import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { expandHome } from "./match.ts";

export const CONFIG_FILE = "repo-rules.json";

/** The `repos` entry of the global scope: everywhere, also outside git repositories. */
export const EVERYWHERE = "*";

/** One block of the config: `global`, or one entry of `repos` with the pattern as its name. */
export interface Scope {
  /** `global`, or the `repos` pattern. */
  name: string;
  /** Where the scope applies: `*` for global, else the pattern. */
  pattern: string;
  /** Rule files: absolute paths. */
  rules: string[];
}

export interface LoadedConfig {
  path: string;
  scopes: Scope[];
  /** Problems with the file or with single entries. Valid entries are still used. */
  errors: string[];
}

/** The keys a scope may have. */
const SCOPE_KEYS = new Set(["rules"]);

/** pi's agent directory: `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
export function agentDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const dir = env.PI_CODING_AGENT_DIR;
  return dir ? expandHome(dir, home) : join(home, ".pi", "agent");
}

/** `$PI_REPO_RULES_CONFIG`, else `repo-rules.json` in the agent directory. */
export function configPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const file = env.PI_REPO_RULES_CONFIG;
  return file ? expandHome(file, home) : join(agentDir(env, home), CONFIG_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFilePath(value: unknown): value is string {
  return typeof value === "string" && (isAbsolute(value) || value.startsWith("~/"));
}

function parseScope(
  name: string,
  pattern: string,
  raw: unknown,
  where: string,
  home: string,
  errors: string[],
): Scope | undefined {
  if (!isRecord(raw)) {
    errors.push(`${where}: must be an object`);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!SCOPE_KEYS.has(key)) errors.push(`${where}: unknown key "${key}"`);
  }
  const rules: string[] = [];
  const list = raw.rules ?? [];
  if (Array.isArray(list)) {
    for (const rule of list) {
      if (isFilePath(rule)) rules.push(expandHome(rule, home));
      else errors.push(`${where}: rule ${JSON.stringify(rule)} is not an absolute path or ~/path`);
    }
  } else {
    errors.push(`${where}: "rules" must be a list of files`);
  }
  return { name, pattern, rules };
}

/**
 * Validate the parsed config file. The shape is
 * `{ "global": { "rules": ["/abs/rule.md"] }, "repos": { "owner/repo": { "rules": ["~/rules/x.md"] } } }`.
 */
export function parseConfig(raw: unknown, path: string, home: string = homedir()): LoadedConfig {
  const result: LoadedConfig = { path, scopes: [], errors: [] };
  if (!isRecord(raw)) {
    result.errors.push(`${path}: expected a JSON object`);
    return result;
  }
  for (const key of Object.keys(raw)) {
    if (key !== "global" && key !== "repos") result.errors.push(`${path}: unknown key "${key}"`);
  }
  if (raw.global !== undefined) {
    const scope = parseScope("global", EVERYWHERE, raw.global, `${path}: global`, home, result.errors);
    if (scope) result.scopes.push(scope);
  }
  const repos = raw.repos ?? {};
  if (!isRecord(repos)) {
    result.errors.push(`${path}: "repos" must be an object`);
    return result;
  }
  for (const [pattern, value] of Object.entries(repos)) {
    if (pattern.trim() === "") {
      result.errors.push(`${path}: repos: empty pattern`);
      continue;
    }
    const scope = parseScope(pattern, pattern.trim(), value, `${path}: repos."${pattern}"`, home, result.errors);
    if (scope) result.scopes.push(scope);
  }
  return result;
}

/** Read and validate the config file. A missing file means no rules and no error. */
export function loadConfig(path: string, home: string = homedir()): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, scopes: [], errors: [] };
    return { path, scopes: [], errors: [`${path}: ${(error as Error).message}`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { path, scopes: [], errors: [`${path}: invalid JSON: ${(error as Error).message}`] };
  }
  return parseConfig(raw, path, home);
}
