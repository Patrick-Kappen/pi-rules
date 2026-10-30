import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** pi's built-in tools that read or change one file, with its path in `input.path`. */
const FILE_TOOLS = new Set(["read", "edit", "write"]);

/** Commands that print a file; `bash` with one of these on a single file counts as reading it. */
const READ_COMMANDS = new Set(["cat", "head", "tail", "less", "more", "bat", "batcat", "nl", "sed"]);

/** Options of the read commands that take a value as the next word. */
const OPTIONS_WITH_VALUE: Record<string, ReadonlySet<string>> = {
  head: new Set(["-n", "-c", "--lines", "--bytes"]),
  tail: new Set(["-n", "-c", "--lines", "--bytes"]),
  bat: new Set(["-l", "-r", "-H", "--language", "--line-range", "--highlight-line", "--style", "--theme"]),
  batcat: new Set(["-l", "-r", "-H", "--language", "--line-range", "--highlight-line", "--style", "--theme"]),
  nl: new Set(["-b", "-s", "-v", "-w", "-i", "-n"]),
};

/** One part of a word: single-quoted, double-quoted (without substitutions) or unquoted (without operators and globs). */
const SEGMENT = /'([^']*)'|"((?:[^"\\$`]|\\[\s\S])*)"|((?:[^\s'"\\|&;<>()$`*?[{]|\\[\s\S])+)/y;
const BLANKS = /[ \t]+/y;

function unescapeBackslashes(text: string): string {
  return text.replace(/\\([\s\S])/g, "$1");
}

/**
 * Split a command line into words, honouring quotes and backslashes. Returns undefined for anything
 * more than one simple command: pipes, lists, redirections, substitutions, globs or newlines.
 */
export function shellWords(command: string): string[] | undefined {
  const words: string[] = [];
  let i = 0;
  while (i < command.length) {
    BLANKS.lastIndex = i;
    if (BLANKS.exec(command)) {
      i = BLANKS.lastIndex;
      continue;
    }
    let word = "";
    while (i < command.length && command[i] !== " " && command[i] !== "\t") {
      SEGMENT.lastIndex = i;
      const segment = SEGMENT.exec(command);
      if (!segment) return undefined;
      word += segment[1] ?? unescapeBackslashes(segment[2] ?? segment[3] ?? "");
      i = SEGMENT.lastIndex;
    }
    words.push(word);
  }
  return words;
}

/** The arguments of `sed -n <script> <file>`, without the script; undefined for any other sed. */
function sedFiles(args: readonly string[]): string[] | undefined {
  let quiet = false;
  let script: string | undefined;
  const files: string[] = [];
  for (const arg of args) {
    if (arg === "-n" || arg === "--quiet" || arg === "--silent") quiet = true;
    else if (arg === "-E" || arg === "-r") continue;
    else if (arg.startsWith("-"))
      return undefined; // -i edits, -e/-f change the meaning of the rest.
    else if (script === undefined) script = arg;
    else files.push(arg);
  }
  return quiet ? files : undefined;
}

/** The file operands of a read command: the words that are not options or option values. */
function operands(name: string, args: readonly string[]): string[] | undefined {
  if (name === "sed") return sedFiles(args);
  const withValue = OPTIONS_WITH_VALUE[name] ?? new Set<string>();
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      files.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("-") && arg !== "-") {
      if (withValue.has(arg)) i++;
      continue;
    }
    files.push(arg);
  }
  return files;
}

/** The file a bash command reads, when it is `cat`, `head`, `sed -n` and so on with a single file. */
export function fileReadByCommand(command: string): string | undefined {
  const words = shellWords(command.trim());
  if (!words || words.length < 2) return undefined;
  const [program, ...args] = words as [string, ...string[]];
  const name = basename(program);
  if (!READ_COMMANDS.has(name)) return undefined;
  const files = operands(name, args);
  if (files?.length !== 1 || files[0] === "-") return undefined;
  return files[0];
}

/** The files a tool call reads or changes, as the tool got them (relative or absolute). */
export function filesOfCall(toolName: string, input: Record<string, unknown>): string[] {
  if (FILE_TOOLS.has(toolName) && typeof input.path === "string" && input.path !== "") return [input.path];
  if (toolName === "bash" && typeof input.command === "string") {
    const file = fileReadByCommand(input.command);
    return file === undefined ? [] : [file];
  }
  return [];
}

/** `path` resolved against `cwd`, with `~` expanded, as pi's tools resolve it. */
export function resolvePath(path: string, cwd: string, home: string): string {
  const withoutAt = path.startsWith("@") ? path.slice(1) : path;
  if (withoutAt === "~") return home;
  if (withoutAt.startsWith("~/")) return join(home, withoutAt.slice(2));
  return isAbsolute(withoutAt) ? resolve(withoutAt) : resolve(cwd, withoutAt);
}

/** The real path of `path`; for a path that does not exist yet, that of its closest existing parent. */
export function realpathLoose(path: string): string {
  const missing: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    missing.unshift(basename(current));
    current = parent;
  }
  try {
    return join(realpathSync(current), ...missing);
  } catch {
    return path;
  }
}

/**
 * `file` relative to `root`, with `/` separators, after resolving symlinks in both. Undefined when the
 * file is not inside the root.
 */
export function relativeTo(root: string, file: string): string | undefined {
  const rel = relative(realpathLoose(root), realpathLoose(file));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}
