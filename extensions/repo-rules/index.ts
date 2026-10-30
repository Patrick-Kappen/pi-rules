import { homedir } from "node:os";
import type {
  AgentBeforeSettleEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { configPath, EVERYWHERE, type LoadedConfig, loadConfig, type Scope } from "./config.ts";
import { filesOfCall, realpathLoose, relativeTo, resolvePath } from "./files.ts";
import {
  BLOCK_EXIT_CODE,
  blockMessage,
  clip,
  describeFailure,
  type Hook,
  type HookEvent,
  type HookRun,
  hookApplies,
  runHook,
  type ToolFacts,
} from "./hooks.ts";
import { firstMatch, type MatchContext, normalizeRemote } from "./match.ts";
import { commandsOf, decide, describeSubject, type Permission, subjectsOf, type Where } from "./permissions.ts";
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
/** The custom type of the messages the extension adds. */
export const MESSAGE_TYPE = "repo-rules";
/** How many extra rounds failing `agent_before_settle` hooks may start for one prompt. */
export const MAX_SETTLE_ROUNDS = 3;

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

/** The hooks of the scopes that apply, in the order of the config. */
export function selectHooks(config: LoadedConfig, ctx: MatchContext): Hook[] {
  return config.scopes.filter((scope) => scopeMatches(scope, ctx)).flatMap((scope) => scope.hooks);
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
  hooks: Hook[];
  /** `ask` decisions the user allowed for the rest of the session: the rule and what it matched. */
  approved: Set<string>;
  errors: string[];
  /** Rule files already in the context. */
  delivered: Set<string>;
  /** Text for the result of the call the model made, from its nested calls (codemode). */
  pending: Map<string, string[]>;
  /** The output of the session_start hooks, for the system prompt. */
  startOutput: string[];
  /** Rounds started by failing agent_before_settle hooks since the last prompt. */
  settleRounds: number;
}

/** What a tool call is about: its files (absolute and relative to the root) and its bash commands. */
interface CallFacts extends ToolFacts {
  files: string[];
  /** The command line of a bash call, else empty. */
  command: string;
}

function callFacts(state: State, toolName: string, input: Record<string, unknown>, cwd: string): CallFacts {
  const files = filesOfCall(toolName, input).map((path) => resolvePath(path, cwd, state.where.home));
  const relative = files.map((path) => relativeTo(state.root, path)).filter((path) => path !== undefined);
  const command = toolName === "bash" && typeof input.command === "string" ? input.command : "";
  return { toolName, files, relative, commands: command === "" ? [] : commandsOf(command), command };
}

function warn(ctx: ExtensionContext, text: string): void {
  if (ctx.hasUI) ctx.ui.notify(text, "warning");
}

/**
 * Run the hooks of an event one after the other, in the root of the repository. Failures other than
 * exit code 2 are reported to the user. With `stopOnBlock`, the first exit code 2 ends the run.
 */
async function runHooks(
  state: State,
  event: HookEvent,
  ctx: ExtensionContext,
  details: { facts?: CallFacts; input?: Record<string, unknown>; stopOnBlock?: boolean } = {},
): Promise<HookRun[]> {
  const runs: HookRun[] = [];
  const { facts } = details;
  const env: Record<string, string> = {
    PI_EVENT: event,
    PI_CWD: state.where.cwd,
    PI_ROOT: state.root,
    PI_TOOL: facts?.toolName ?? "",
    PI_FILE: facts?.files[0] ?? "",
    PI_FILES: facts?.files.join("\n") ?? "",
    PI_COMMAND: facts?.command ?? "",
  };
  const input = { event, cwd: state.where.cwd, root: state.root, ...details.input };
  for (const hook of state.hooks) {
    if (!hookApplies(hook, event, facts)) continue;
    const run = await runHook(hook, { cwd: state.root, env, input, signal: ctx.signal });
    runs.push(run);
    if (run.code !== 0 && run.code !== BLOCK_EXIT_CODE) warn(ctx, describeFailure(run));
    if (details.stopOnBlock && run.code === BLOCK_EXIT_CODE) break;
  }
  return runs;
}

/** The text for a tool result from the tool_result hooks: their output, and the problems they report. */
function hookTexts(runs: readonly HookRun[]): string[] {
  const texts: string[] = [];
  for (const run of runs) {
    if (run.code === 0 && run.stdout.trim() !== "") {
      texts.push(`Output of the repo-rules hook "${run.hook.run}":\n${clip(run.stdout)}`);
    } else if (run.code === BLOCK_EXIT_CODE) {
      texts.push(`The repo-rules hook "${run.hook.run}" reports a problem:\n${blockMessage(run)}`);
    }
  }
  return texts;
}

/** The system prompt section: the rules, and the output of the session_start hooks. */
function promptSection(state: State): string | undefined {
  const parts = [renderPromptSection(state.rules)];
  if (state.startOutput.length > 0) {
    parts.push(`Output of the session_start hooks of repo-rules:\n\n${state.startOutput.join("\n\n")}`);
  }
  const text = parts.filter((part) => part !== undefined).join("\n\n");
  return text === "" ? undefined : text;
}

/** The text for the path rules that apply to the files of a call and are not in the context yet. */
function dueRules(state: State, facts: CallFacts): string[] {
  const due = state.rules.filter(
    (rule) => !state.delivered.has(rule.file) && facts.relative.some((path) => ruleApplies(rule, path)),
  );
  for (const rule of due) state.delivered.add(rule.file);
  return due.length > 0 ? [renderToolResultRules(due, facts.relative)] : [];
}

/**
 * Add texts to a tool result. The result of a nested call (codemode) goes to the calling tool, not to
 * the model, so its texts wait for the result of the call the model made.
 */
function addToResult(state: State, event: ToolResultEvent, texts: string[]): ToolResultEventResult | undefined {
  if (event.parentToolCallId !== undefined) {
    const id = topLevelCallId(event.toolCallId);
    if (texts.length > 0) state.pending.set(id, [...(state.pending.get(id) ?? []), ...texts]);
    return undefined;
  }
  const all = [...(state.pending.get(event.toolCallId) ?? []), ...texts];
  state.pending.delete(event.toolCallId);
  if (all.length === 0) return undefined;
  const content = [...event.content, { type: "text" as const, text: all.join("\n\n") }];
  return event.structuredContent === undefined ? { content } : { content, structuredContent: event.structuredContent };
}

function resultText(event: ToolResultEvent): string {
  return event.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
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
      hooks: selectHooks(config, match),
      approved: new Set(),
      errors: [...config.errors, ...errors],
      delivered: deliveredRules(ctx.sessionManager.buildContextEntries()),
      pending: new Map(),
      startOutput: [],
      settleRounds: 0,
    };
  };

  // Runs at startup, on /reload, /new, /resume and /fork: the config and the rules are read again.
  pi.on("session_start", async (_event, ctx) => {
    const current = load(ctx);
    state = current;
    if (current.errors.length > 0) warn(ctx, `repo-rules:\n${current.errors.join("\n")}`);
    const runs = await runHooks(current, "session_start", ctx);
    current.startOutput = runs
      .filter((run) => run.code === 0 && run.stdout.trim() !== "")
      .map((run) => clip(run.stdout));
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (state) await runHooks(state, "session_shutdown", ctx);
  });

  // After a compaction or a move in the tree, rules that left the context are added again when needed.
  const refresh = (_event: unknown, ctx: ExtensionContext): void => {
    if (state) state.delivered = deliveredRules(ctx.sessionManager.buildContextEntries());
  };
  pi.on("session_compact", refresh);
  pi.on("session_tree", refresh);

  pi.on(
    "before_agent_start",
    async (event: BeforeAgentStartEvent, ctx): Promise<BeforeAgentStartEventResult | undefined> => {
      if (!state) return undefined;
      if (event.messageType === "user") state.settleRounds = 0;
      const section = promptSection(state);
      if (section) event.systemPromptOptions.sections[PROMPT_SECTION] = section;
      const input = event.messageType === "user" ? { prompt: event.prompt } : {};
      const runs = await runHooks(state, "before_agent_start", ctx, { input });
      const output = runs.filter((run) => run.code === 0 && run.stdout.trim() !== "").map((run) => clip(run.stdout));
      if (output.length === 0) return undefined;
      return { message: { customType: MESSAGE_TYPE, content: output.join("\n\n"), display: false } };
    },
  );

  pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
    if (!state) return undefined;
    if (state.permissions.length > 0) {
      const decision = await checkPermissions(state, event, ctx);
      if (decision) return decision;
    }
    const facts = callFacts(state, event.toolName, event.input, ctx.cwd);
    const input = { tool: { name: event.toolName, input: event.input } };
    const runs = await runHooks(state, "tool_call", ctx, { facts, input, stopOnBlock: true });
    const blocked = runs.find((run) => run.code === BLOCK_EXIT_CODE);
    if (!blocked) return undefined;
    return { block: true, reason: `repo-rules hook "${blocked.hook.run}": ${blockMessage(blocked)}` };
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx): Promise<ToolResultEventResult | undefined> => {
    if (!state) return undefined;
    const facts = callFacts(state, event.toolName, event.input, ctx.cwd);
    const input = {
      tool: { name: event.toolName, input: event.input },
      result: { text: resultText(event), isError: event.isError },
    };
    const runs = await runHooks(state, "tool_result", ctx, { facts, input });
    return addToResult(state, event, [...dueRules(state, facts), ...hookTexts(runs)]);
  });

  pi.on("agent_before_settle", async (event: AgentBeforeSettleEvent, ctx): Promise<BoundaryResult | undefined> => {
    if (!state || event.outcome !== "completed") return undefined;
    const runs = await runHooks(state, "agent_before_settle", ctx);
    const failed = runs.filter((run) => run.code === BLOCK_EXIT_CODE);
    if (failed.length === 0) return undefined;
    if (state.settleRounds >= MAX_SETTLE_ROUNDS) {
      warn(ctx, `repo-rules: agent_before_settle hooks still fail after ${MAX_SETTLE_ROUNDS} extra rounds; stopping.`);
      return undefined;
    }
    state.settleRounds++;
    const content = [
      "A repo-rules hook reports problems before you finish. Fix them, then finish.",
      ...failed.map((run) => `Hook "${run.hook.run}":\n${blockMessage(run)}`),
    ].join("\n\n");
    return {
      entries: [...event.entries, { type: "custom_message", customType: MESSAGE_TYPE, content, display: true }],
      continue: true,
    };
  });

  pi.registerCommand("repo-rules", {
    description: "Show which repository pi is in and which repo-rules scopes, rules, permissions and hooks apply",
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

function describeHook(hook: Hook): string {
  const filters = [
    hook.tools.length > 0 ? `tools: ${hook.tools.join(", ")}` : "",
    hook.paths.length > 0 ? `paths: ${hook.paths.join(", ")}` : "",
    hook.commands.length > 0 ? `command: ${hook.commands.join(", ")}` : "",
  ].filter((filter) => filter !== "");
  const when = filters.length > 0 ? ` [${filters.join("; ")}]` : "";
  return `  hook ${hook.event}${when}: ${hook.run} (${hook.scope})`;
}

/** The text of `/repo-rules`: where pi is, which scopes apply, and their rules, permissions and hooks. */
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
  lines.push(...selectHooks(config, match).map(describeHook));
  lines.push(...[...config.errors, ...errors].map((error) => `error: ${error}`));
  lines.push("Changed the config, a rule or the directory? Run /reload.");
  return lines.join("\n");
}

export default function repoRules(pi: ExtensionAPI): void {
  createRepoRules(pi);
}
