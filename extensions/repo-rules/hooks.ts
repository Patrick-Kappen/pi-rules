import { spawn } from "node:child_process";
import { globToRegExp, matchesAny } from "./glob.ts";
import { commandMatches } from "./permissions.ts";

/** The pi events a hook can run on. */
export const HOOK_EVENTS = [
  "session_start",
  "before_agent_start",
  "tool_call",
  "tool_result",
  "agent_before_settle",
  "session_shutdown",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Events about one tool call: only these hooks can filter on tools, paths and commands. */
const TOOL_EVENTS: ReadonlySet<HookEvent> = new Set(["tool_call", "tool_result"]);

/** The exit code that blocks a tool call, or reports a problem to the model. */
export const BLOCK_EXIT_CODE = 2;
export const DEFAULT_TIMEOUT_SECONDS = 60;
/** Hook output that goes to the model is cut to this many characters. */
export const MAX_OUTPUT = 10_000;

export interface Hook {
  event: HookEvent;
  /** The scope that lists it: `global` or a `repos` pattern. */
  scope: string;
  /** The shell command, run with `sh -c` in the root of the repository. */
  run: string;
  /** Tool name globs; empty for every tool. */
  tools: string[];
  /** Path globs, as in rules; empty for every call. */
  paths: string[];
  /** Command globs for bash, as in permissions; empty for every call. */
  commands: string[];
  timeoutMs: number;
  toolMatchers: RegExp[];
  pathMatchers: RegExp[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  return undefined;
}

const HOOK_KEYS = new Set(["run", "tools", "paths", "command", "timeout"]);

function toolGlob(name: string): RegExp {
  const parts = name.trim().toLowerCase().split("*");
  return new RegExp(`^${parts.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
}

/** Parse one hook of a scope; a string is the error. */
export function parseHook(raw: unknown, event: HookEvent, scope: string): Hook | string {
  const where = `${scope}: hooks.${event}`;
  if (!isRecord(raw)) return `${where}: a hook must be an object with "run"`;
  const unknown = Object.keys(raw).filter((key) => !HOOK_KEYS.has(key));
  if (unknown.length > 0) return `${where}: unknown key "${unknown[0]}"`;
  if (typeof raw.run !== "string" || raw.run.trim() === "") return `${where}: "run" must be a command`;
  const tools = stringList(raw.tools);
  const paths = stringList(raw.paths);
  const commands = stringList(raw.command);
  if (!tools || !paths || !commands) return `${where}: "tools", "paths" and "command" must be strings or lists`;
  if (!TOOL_EVENTS.has(event) && tools.length + paths.length + commands.length > 0) {
    return `${where}: "tools", "paths" and "command" only work on tool_call and tool_result`;
  }
  const timeout = raw.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  if (typeof timeout !== "number" || !(timeout > 0)) return `${where}: "timeout" must be a number of seconds`;
  return {
    event,
    scope,
    run: raw.run,
    tools,
    paths,
    commands,
    timeoutMs: timeout * 1000,
    toolMatchers: tools.map(toolGlob),
    pathMatchers: paths.map(globToRegExp),
  };
}

/** Parse the `hooks` of a scope: `{ "<event>": [hook, ...] }`. */
export function parseHooks(raw: unknown, scope: string, errors: string[]): Hook[] {
  if (raw === undefined) return [];
  if (!isRecord(raw)) {
    errors.push(`${scope}: "hooks" must be an object with lists per event`);
    return [];
  }
  const hooks: Hook[] = [];
  for (const [event, list] of Object.entries(raw)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      errors.push(`${scope}: hooks: unknown event "${event}" (${HOOK_EVENTS.join(", ")})`);
      continue;
    }
    if (!Array.isArray(list)) {
      errors.push(`${scope}: hooks.${event} must be a list`);
      continue;
    }
    for (const item of list) {
      const hook = parseHook(item, event as HookEvent, scope);
      if (typeof hook === "string") errors.push(hook);
      else hooks.push(hook);
    }
  }
  return hooks;
}

/** What a tool event is about, for the filters of a hook. */
export interface ToolFacts {
  toolName: string;
  /** Files of the call, relative to the root. */
  relative: string[];
  /** The commands of a bash call. */
  commands: string[];
}

/** Whether a hook runs for an event: the event matches, and so do the filters it has. */
export function hookApplies(hook: Hook, event: HookEvent, facts?: ToolFacts): boolean {
  if (hook.event !== event) return false;
  if (!facts) return true;
  const tool = facts.toolName.toLowerCase();
  if (hook.toolMatchers.length > 0 && !hook.toolMatchers.some((matcher) => matcher.test(tool))) return false;
  if (hook.pathMatchers.length > 0 && !facts.relative.some((path) => matchesAny(hook.pathMatchers, path))) return false;
  if (hook.commands.length > 0) {
    return facts.commands.some((command) => hook.commands.some((pattern) => commandMatches(pattern, command)));
  }
  return true;
}

export interface HookRun {
  hook: Hook;
  /** The exit code; null when the hook could not start, timed out or was killed. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Why the hook did not finish normally. */
  failure?: string;
}

export interface RunOptions {
  cwd: string;
  env: Record<string, string>;
  /** JSON for the hook's stdin. */
  input: unknown;
  signal?: AbortSignal | undefined;
}

/** Run a hook with `sh -c`, the event as JSON on stdin, and a timeout. */
export function runHook(hook: Hook, options: RunOptions): Promise<HookRun> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", hook.run], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let stdout = "";
    let stderr = "";
    let failure: string | undefined;
    const timer = setTimeout(() => {
      failure = `timed out after ${hook.timeoutMs / 1000}s`;
      child.kill("SIGKILL");
    }, hook.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      failure ??= error.name === "AbortError" ? "aborted" : error.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ hook, code: failure ? null : code, stdout, stderr, ...(failure ? { failure } : {}) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(options.input));
  });
}

/** Text for the model, cut to MAX_OUTPUT characters. */
export function clip(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_OUTPUT) return trimmed;
  return `${trimmed.slice(0, MAX_OUTPUT)}\n[... ${trimmed.length - MAX_OUTPUT} more characters cut by repo-rules]`;
}

/** A one-line description of a hook run that failed, for the user. */
export function describeFailure(run: HookRun): string {
  const reason = run.failure ?? `exit code ${run.code}`;
  const detail = clip(run.stderr || run.stdout)
    .split("\n")
    .slice(0, 5)
    .join("\n");
  return `repo-rules: hook ${run.hook.event} "${run.hook.run}" (${run.hook.scope}) failed: ${reason}${detail ? `\n${detail}` : ""}`;
}

/** What the model gets from a hook that exited with 2: its stderr, else its stdout. */
export function blockMessage(run: HookRun): string {
  return clip(run.stderr || run.stdout) || `hook "${run.hook.run}" exited with ${BLOCK_EXIT_CODE}`;
}
