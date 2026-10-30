import { homedir } from "node:os";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { configPath, EVERYWHERE, type LoadedConfig, loadConfig, type Scope } from "./config.ts";
import { filesOfCall, realpathLoose, relativeTo, resolvePath } from "./files.ts";
import { firstMatch, type MatchContext, normalizeRemote } from "./match.ts";
import { decide, describeSubject, type Permission, subjectsOf, type Where } from "./permissions.ts";
import { findRepo } from "./repo.ts";
import {
  loadRule,
  type Rule,
  renderedRuleFiles,
  renderPromptSection,
  renderToolResultRules,
  ruleApplies,
} from "./rules.ts";

/** The answers to an `ask` rule. */
export const ALLOW_ONCE = "Allow";
export const ALLOW_SESSION = "Allow for this session";
export const DENY = "Deny";

/** The name of the system prompt section with the rules. */
export const PROMPT_SECTION = "repo_rules";

/** Whether a scope applies to the session: global always, a `repos` pattern when it matches. */
export function scopeMatches(scope: Scope, ctx: MatchContext): boolean {
  return scope.pattern === EVERYWHERE || firstMatch([scope.pattern], ctx) !== undefined;
}

/** The rules of the scopes that apply, each file once (the first scope that lists it wins). */
export function selectRules(config: LoadedConfig, ctx: MatchContext): { rules: Rule[]; errors: string[] } {
  const rules: Rule[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const scope of config.scopes) {
    if (!scopeMatches(scope, ctx)) continue;
    for (const file of scope.rules) {
      if (seen.has(file)) continue;
      seen.add(file);
      const rule = loadRule(file, scope.name);
      if (typeof rule === "string") errors.push(rule);
      else rules.push(rule);
    }
  }
  return { rules, errors };
}

/** The permission rules of the scopes that apply, in the order of the config. */
export function selectPermissions(config: LoadedConfig, ctx: MatchContext): Permission[] {
  return config.scopes.filter((scope) => scopeMatches(scope, ctx)).flatMap((scope) => scope.permissions);
}

/** The rule files whose text is already in the model's context: in a tool result since the last compaction. */
export function deliveredRules(entries: readonly SessionEntry[]): Set<string> {
  const files = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    for (const block of entry.message.content) {
      if (block.type === "text") for (const file of renderedRuleFiles(block.text)) files.add(file);
    }
  }
  return files;
}

/** The call that the model made: a nested call (`<parent id>/<n>`) belongs to the first part. */
function topLevelCallId(toolCallId: string): string {
  return toolCallId.split("/")[0] as string;
}

export interface Options {
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** The pi methods this extension uses; a subset of ExtensionAPI, so tests can pass a fake. */
export type RepoRulesApi = Pick<ExtensionAPI, "on" | "registerCommand">;

interface State {
  root: string;
  where: Where;
  rules: Rule[];
  permissions: Permission[];
  /** `ask` decisions the user allowed for the rest of the session: the rule and what it matched. */
  approved: Set<string>;
  errors: string[];
  /** Rule files already in the context. */
  delivered: Set<string>;
  /** Rules found in nested calls (codemode), added to the result of the call the model made. */
  pending: Map<string, Rule[]>;
}

export function createRepoRules(pi: RepoRulesApi, options: Options = {}): void {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const file = configPath(env, home);
  const matchContext = (cwd: string): MatchContext => ({ cwd, home, repo: findRepo(cwd) });
  let state: State | undefined;

  const load = (ctx: ExtensionContext): State => {
    const match = matchContext(ctx.cwd);
    const config = loadConfig(file, home);
    const { rules, errors } = selectRules(config, match);
    const root = match.repo?.worktreeRoot ?? realpathLoose(ctx.cwd);
    return {
      root,
      where: { cwd: ctx.cwd, root, home },
      rules,
      permissions: selectPermissions(config, match),
      approved: new Set(),
      errors: [...config.errors, ...errors],
      delivered: deliveredRules(ctx.sessionManager.buildContextEntries()),
      pending: new Map(),
    };
  };

  // Runs at startup, on /reload, /new, /resume and /fork: the config and the rules are read again.
  pi.on("session_start", (_event, ctx) => {
    state = load(ctx);
    if (state.errors.length > 0 && ctx.hasUI) ctx.ui.notify(`repo-rules:\n${state.errors.join("\n")}`, "warning");
  });

  // After a compaction or a move in the tree, rules that left the context are added again when needed.
  const refresh = (_event: unknown, ctx: ExtensionContext): void => {
    if (state) state.delivered = deliveredRules(ctx.sessionManager.buildContextEntries());
  };
  pi.on("session_compact", refresh);
  pi.on("session_tree", refresh);

  pi.on("before_agent_start", (event) => {
    const section = state && renderPromptSection(state.rules);
    if (section) event.systemPromptOptions.sections[PROMPT_SECTION] = section;
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
    if (!state || state.permissions.length === 0) return undefined;
    return checkPermissions(state, event, ctx);
  });

  pi.on("tool_result", (event: ToolResultEvent, ctx) => {
    if (!state) return undefined;
    const current = state;
    const files = filesOfCall(event.toolName, event.input).map((path) => resolvePath(path, ctx.cwd, home));
    const relative = files.map((path) => relativeTo(current.root, path)).filter((path) => path !== undefined);
    const due = current.rules.filter(
      (rule) => !current.delivered.has(rule.file) && relative.some((path) => ruleApplies(rule, path)),
    );
    for (const rule of due) current.delivered.add(rule.file);

    if (event.parentToolCallId !== undefined) {
      // The result of a nested call goes to the calling tool, not to the model.
      const id = topLevelCallId(event.toolCallId);
      if (due.length > 0) current.pending.set(id, [...(current.pending.get(id) ?? []), ...due]);
      return undefined;
    }
    const rules = [...(current.pending.get(event.toolCallId) ?? []), ...due];
    current.pending.delete(event.toolCallId);
    if (rules.length === 0) return undefined;
    const text = renderToolResultRules(rules, relative);
    const content = [...event.content, { type: "text" as const, text }];
    return event.structuredContent === undefined
      ? { content }
      : { content, structuredContent: event.structuredContent };
  });

  pi.registerCommand("repo-rules", {
    description: "Show which repository pi is in and which repo-rules scopes, rules and permissions apply",
    handler: async (_args, ctx) => {
      ctx.ui.notify(describe(loadConfig(file, home), matchContext(ctx.cwd), state?.delivered ?? new Set()), "info");
    },
  });
}

/** Apply the permission rules to a tool call: allow it, block it, or ask the user. */
async function checkPermissions(
  state: State,
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<ToolCallEventResult | undefined> {
  const decision = decide(state.permissions, subjectsOf(event.toolName, event.input, state.where), state.where);
  if (decision.action === "allow" || !decision.permission) return undefined;
  const what = describeSubject(event.toolName, decision.subject);
  const rule = `${decision.permission.action} "${decision.permission.text}" (${decision.permission.scope})`;
  if (decision.action === "deny") return { block: true, reason: `repo-rules: ${what} is denied by ${rule}.` };

  const key = `${decision.permission.text}\n${what}`;
  if (state.approved.has(key)) return undefined;
  if (!ctx.hasUI) {
    return { block: true, reason: `repo-rules: ${what} needs approval (${rule}), and there is no UI to ask.` };
  }
  const choice = await ctx.ui.select(
    `repo-rules: allow ${what}?\n${rule}`,
    [ALLOW_ONCE, ALLOW_SESSION, DENY],
    ctx.signal ? { signal: ctx.signal } : undefined,
  );
  if (choice === ALLOW_SESSION) state.approved.add(key);
  if (choice === ALLOW_ONCE || choice === ALLOW_SESSION) return undefined;
  return { block: true, reason: `repo-rules: the user did not allow ${what} (${rule}).` };
}

function describeRepo(match: MatchContext): string[] {
  if (!match.repo) return ["not in a git repository"];
  const lines = [`main checkout: ${match.repo.mainRoot}`];
  if (match.repo.worktreeRoot !== match.repo.mainRoot) lines.push(`worktree: ${match.repo.worktreeRoot}`);
  for (const url of match.repo.remotes) lines.push(`remote: ${normalizeRemote(url) ?? url}`);
  return lines;
}

/** The text of `/repo-rules`: where pi is, which scopes apply, and their rules. */
export function describe(config: LoadedConfig, match: MatchContext, delivered: ReadonlySet<string>): string {
  const lines = [`config: ${config.path}`, `cwd: ${match.cwd}`, ...describeRepo(match)];
  if (config.scopes.length === 0) lines.push("no scopes configured");
  for (const scope of config.scopes) {
    lines.push(`- ${scope.name}: ${scopeMatches(scope, match) ? "applies" : "does not apply"}`);
  }
  const { rules, errors } = selectRules(config, match);
  for (const rule of rules) {
    const when = rule.paths.length === 0 ? "always" : rule.paths.join(", ");
    const loaded = rule.paths.length > 0 && delivered.has(rule.file) ? ", in context" : "";
    lines.push(`  rule ${rule.name} (${rule.scope}): ${when}${loaded}`);
  }
  for (const permission of selectPermissions(config, match)) {
    lines.push(`  ${permission.action} ${permission.text} (${permission.scope})`);
  }
  lines.push(...[...config.errors, ...errors].map((error) => `error: ${error}`));
  lines.push("Changed the config, a rule or the directory? Run /reload.");
  return lines.join("\n");
}

export default function repoRules(pi: ExtensionAPI): void {
  createRepoRules(pi);
}
