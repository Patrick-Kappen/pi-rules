import { basename, isAbsolute } from "node:path";
import { onMain } from "./branch.ts";
import { fileReadByCommand, realpathLoose, relativeTo, resolvePath } from "./files.ts";
import { globToRegExp } from "./glob.ts";

export type Action = "deny" | "ask" | "allow";
export const ACTIONS: readonly Action[] = ["deny", "ask", "allow"];

/** One permission rule, such as `bash(git push *)`, `read(.env)` or `mcp__github__*`. */
export interface Permission {
  action: Action;
  /** The rule as written. */
  text: string;
  /** The scope that lists it: `global` or a `repos` pattern. */
  scope: string;
  tool: RegExp;
  /** The command or path glob between the parentheses; undefined for the whole tool. */
  specifier: string | undefined;
}

/** What a rule is matched against: one command of a bash call, one path, or the tool itself. */
export interface Subject {
  /** The tool names the subject answers to: `write` also answers to `edit`, `grep` to `read`. */
  tools: string[];
  command?: string;
  /** Absolute path. */
  path?: string;
}

export interface Where {
  cwd: string;
  /** Root for relative globs: the worktree of the repository, else the working directory. */
  root: string;
  home: string;
}

export interface Decision {
  action: Action;
  /** The rule that decided; undefined when nothing matched. */
  permission?: Permission;
  /** What the rule matched, for messages. */
  subject?: Subject;
}

const RULE = /^([A-Za-z0-9_.*-]+)(?:\(([\s\S]*)\))?$/;

/** Parse `tool` or `tool(specifier)`; a string is the error. */
export function parsePermission(text: string, action: Action, scope: string): Permission | string {
  const match = RULE.exec(text.trim());
  if (!match) return `${scope}: ${action} "${text}": expected tool or tool(specifier)`;
  const specifier = match[2]?.trim();
  if (specifier === "") return `${scope}: ${action} "${text}": empty specifier`;
  const name = (match[1] as string).toLowerCase();
  const tool = new RegExp(`^${name.split("*").map(escapeRegExp).join(".*")}$`);
  return { action, text: text.trim(), scope, tool, specifier };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** A command glob: `*` matches anything, blanks match any blanks, and `cmd *` also matches `cmd`. */
export function commandMatches(pattern: string, command: string): boolean {
  let glob = pattern.trim().replace(/\s+/g, " ");
  let tail = "";
  if (glob.endsWith(" *")) {
    glob = glob.slice(0, -2);
    tail = "(?:\\s.*)?";
  }
  const body = glob
    .split("*")
    .map((part) => part.split(" ").map(escapeRegExp).join("\\s+"))
    .join(".*");
  return new RegExp(`^${body}${tail}$`, "s").test(command.trim());
}

/** The specifier for files in a main checkout or on the default branch: `edit(@main)`. */
export const MAIN = "@main";

/**
 * A path glob: `~/...` and `//abs/...` are absolute, anything else is relative to the root, with the
 * globs of rule `paths`.
 */
export function pathMatches(pattern: string, path: string, where: Where): boolean {
  const glob = pattern.trim();
  if (glob === MAIN) return onMain(path);
  if (glob.startsWith("~/") || glob.startsWith("//")) {
    const absolute = glob.startsWith("~/") ? resolvePath(glob, where.cwd, where.home) : glob.slice(1);
    const regex = globToRegExp(`/${absolute.slice(1)}`);
    return [path, realpathLoose(path)].some((candidate) => regex.test(candidate.slice(1)));
  }
  const relative = relativeTo(where.root, path);
  return relative !== undefined && globToRegExp(glob).test(relative);
}

/** Shells whose `-c` script is checked too. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** Wrappers that run the rest of the line as a command. */
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "time", "nohup", "nice", "builtin"]);

/** Split a part into words at blanks, keeping quoted text together (quotes stay). */
function looseWords(part: string): string[] {
  return part.match(/(?:[^\s'"]+|'[^']*'?|"(?:[^"\\]|\\.)*"?)+/g) ?? [];
}

function unquote(word: string): string {
  return word.replace(/^'([\s\S]*)'$/, "$1").replace(/^"([\s\S]*)"$/, "$1");
}

/** Without leading `VAR=value` assignments and wrappers such as `sudo` and `env`. */
function stripPrefixes(part: string): string {
  const words = looseWords(part);
  let i = 0;
  while (i < words.length) {
    const word = words[i] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || WRAPPERS.has(word)) i++;
    else if (word.startsWith("-") && i > 0 && WRAPPERS.has(words[i - 1] as string)) i++;
    else break;
  }
  return words.slice(i).join(" ");
}

/** Quoted strings, the separators between commands, and the text between them. */
const COMMAND_TOKEN = /'[^']*'?|"(?:[^"\\]|\\[\s\S])*"?|&&|\|\||;;|\$\(|[;|&\n()`]|[^'"&|;$\n()`]+|\$/g;
const SEPARATOR = /^(?:&&|\|\||;;|\$\(|[;|&\n()`])$/;

/** Split a command line at `&&`, `||`, `;`, `|`, `&`, newlines, parentheses and substitutions, outside quotes. */
function splitCommands(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const [token] of command.matchAll(COMMAND_TOKEN)) {
    if (SEPARATOR.test(token)) {
      parts.push(current);
      current = "";
    } else {
      current += token;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * The commands a bash line runs: split at `&&`, `||`, `;`, `|`, `&`, newlines and substitutions,
 * without assignments and wrappers, and with the script of `bash -c '...'` and `sh -c '...'`.
 */
export function commandsOf(command: string, depth = 0): string[] {
  const commands: string[] = [];
  for (const part of splitCommands(command)) {
    const stripped = stripPrefixes(part.trim());
    if (stripped === "") continue;
    commands.push(stripped);
    const words = looseWords(stripped);
    const shell = SHELLS.has(basename(words[0] ?? ""));
    const script = words.indexOf("-c");
    if (shell && script !== -1 && depth < 3 && words[script + 1] !== undefined) {
      commands.push(...commandsOf(unquote(words[script + 1] as string), depth + 1));
    }
  }
  return commands;
}

function fileSubject(tools: string[], path: string | undefined, where: Where): Subject {
  return path === undefined ? { tools } : { tools, path: resolvePath(path, where.cwd, where.home) };
}

function bashSubjects(command: string, where: Where): Subject[] {
  const subjects: Subject[] = [{ tools: ["bash"] }];
  for (const part of commandsOf(command)) {
    subjects.push({ tools: ["bash"], command: part });
    const file = fileReadByCommand(part);
    if (file !== undefined) subjects.push(fileSubject(["read"], file, where));
  }
  return subjects;
}

/** What a tool call does, as subjects for the permission rules. */
export function subjectsOf(toolName: string, input: Record<string, unknown>, where: Where): Subject[] {
  const name = toolName.toLowerCase();
  const path = typeof input.path === "string" && input.path !== "" ? input.path : undefined;
  switch (name) {
    case "read":
      return [fileSubject(["read"], path, where)];
    case "grep":
    case "find":
    case "ls":
      // Without a path, they search the working directory.
      return [fileSubject([name, "read"], path ?? ".", where)];
    case "edit":
      return [fileSubject(["edit"], path, where)];
    case "write":
      return [fileSubject(["write", "edit"], path, where)];
    case "bash":
      return typeof input.command === "string" ? bashSubjects(input.command, where) : [{ tools: ["bash"] }];
    default:
      return [{ tools: [name] }];
  }
}

/** Whether a permission rule matches a subject. */
export function permissionMatches(permission: Permission, subject: Subject, where: Where): boolean {
  if (!subject.tools.some((tool) => permission.tool.test(tool))) return false;
  if (permission.specifier === undefined) return true;
  if (subject.command !== undefined) return commandMatches(permission.specifier, subject.command);
  if (subject.path !== undefined && isAbsolute(subject.path)) {
    return pathMatches(permission.specifier, subject.path, where);
  }
  return false;
}

/**
 * The decision for a tool call. Everything is allowed, unless a `deny` rule matches one of its
 * subjects (then it is denied), or an `ask` rule matches a subject that no `allow` rule matches
 * (then the user is asked). `deny` always wins; `allow` only makes exceptions to `ask`.
 */
export function decide(permissions: readonly Permission[], subjects: readonly Subject[], where: Where): Decision {
  const first = (action: Action, subject: Subject) =>
    permissions.find((permission) => permission.action === action && permissionMatches(permission, subject, where));
  for (const subject of subjects) {
    const permission = first("deny", subject);
    if (permission) return { action: "deny", permission, subject };
  }
  for (const subject of subjects) {
    const permission = first("ask", subject);
    if (permission && !first("allow", subject)) return { action: "ask", permission, subject };
  }
  return { action: "allow" };
}

/** A short description of a subject, for the question and the block reason. */
export function describeSubject(toolName: string, subject: Subject | undefined): string {
  if (subject?.command !== undefined) return `bash: ${subject.command}`;
  if (subject?.path !== undefined) return `${subject.tools[0] ?? toolName}: ${subject.path}`;
  return toolName;
}
