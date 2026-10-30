import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { globToRegExp, matchesAny } from "./glob.ts";

/** A rule file, read and parsed. */
export interface Rule {
  /** The file name without `.md` (and without the hash of a Nix store path). */
  name: string;
  /** The absolute path of the file. */
  file: string;
  /** The scope that lists the rule: `global` or a `repos` pattern. */
  scope: string;
  /** The globs of the `paths` front matter; empty for a rule that always applies. */
  paths: string[];
  matchers: RegExp[];
  /** The text after the front matter. */
  body: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted ? (quoted[2] as string) : trimmed;
}

/** Quoted strings, brace groups, commas, and the text between them. */
const INLINE_TOKEN = /"[^"]*"|'[^']*'|\{[^}]*\}|,|[^,"'{]+|["'{]/g;

/** Split an inline YAML list (`a, "b,c", {x,y}`) at the commas outside quotes and braces. */
function splitInline(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  for (const [token] of inner.matchAll(INLINE_TOKEN)) {
    if (token === ",") {
      items.push(current);
      current = "";
    } else {
      current += token;
    }
  }
  items.push(current);
  return items.map(unquote).filter((item) => item !== "");
}

/** The value of `key` in YAML front matter lines: a scalar, an inline list or a block list. */
function listValue(lines: readonly string[], key: string): string[] | undefined {
  const index = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (index === -1) return undefined;
  const rest = (lines[index] as string).replace(/^[^:]*:/, "").trim();
  if (rest.startsWith("[") && rest.endsWith("]")) return splitInline(rest.slice(1, -1));
  if (rest !== "") return [unquote(rest)].filter((item) => item !== "");
  const items: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (!item) break;
    const value = unquote(item[1] as string);
    if (value !== "") items.push(value);
  }
  return items;
}

/** The `paths` of the YAML front matter, and the text after it. Other keys are ignored. */
export function parseRuleText(text: string): { paths: string[]; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { paths: [], body: text.trim() };
  const lines = (match[1] as string).split(/\r?\n/);
  return { paths: listValue(lines, "paths") ?? [], body: text.slice(match[0].length).trim() };
}

/** The name of a rule file: `/nix/store/<hash>-api.md` and `/rules/api.md` are both `api`. */
export function ruleName(file: string): string {
  return basename(file)
    .replace(/^[0-9a-z]{32}-/, "")
    .replace(/\.md$/i, "");
}

/** Read and parse a rule file; a string is the error. */
export function loadRule(file: string, scope: string): Rule | string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return `${scope}: rule ${file}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
  }
  const { paths, body } = parseRuleText(text);
  return { name: ruleName(file), file, scope, paths, matchers: paths.map(globToRegExp), body };
}

/** Whether a rule with `paths` applies to a file, given relative to the repository root. */
export function ruleApplies(rule: Rule, relativePath: string): boolean {
  return rule.paths.length > 0 && matchesAny(rule.matchers, relativePath);
}

function attribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** One rule as the model sees it. `deliveredRules` finds the files of these blocks again. */
export function renderRule(rule: Rule): string {
  const paths = rule.paths.length > 0 ? ` paths="${attribute(rule.paths.join(", "))}"` : "";
  return `<repo_rule name="${attribute(rule.name)}" file="${attribute(rule.file)}"${paths}>\n${rule.body}\n</repo_rule>`;
}

/** The system prompt section: the rules without `paths`, and a list of the rules with `paths`. */
export function renderPromptSection(rules: readonly Rule[]): string | undefined {
  const always = rules.filter((rule) => rule.paths.length === 0);
  const scoped = rules.filter((rule) => rule.paths.length > 0);
  if (always.length === 0 && scoped.length === 0) return undefined;
  const parts: string[] = [];
  if (always.length > 0) {
    parts.push("The rules below apply to this repository. Follow them.", ...always.map(renderRule));
  }
  if (scoped.length > 0) {
    parts.push(
      [
        "These rules apply to some files only. When you read or change a matching file, the rule is added to that tool result.",
        "Before you create or change a matching file, read its rule file first.",
        ...scoped.map((rule) => `- ${rule.name} (${rule.paths.join(", ")}): ${rule.file}`),
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

/** The text added to a tool result for the rules that apply to the files of the call. */
export function renderToolResultRules(rules: readonly Rule[], files: readonly string[]): string {
  const subject = files.length > 0 ? ` to ${files.join(", ")}` : "";
  return [`These repository rules apply${subject}. Follow them.`, ...rules.map(renderRule)].join("\n\n");
}

/** The files of the `<repo_rule>` blocks in a text. */
export function renderedRuleFiles(text: string): string[] {
  const files: string[] = [];
  for (const match of text.matchAll(/<repo_rule name="[^"]*" file="([^"]*)"/g)) {
    files.push(
      (match[1] as string)
        .replace(/&lt;/g, "<")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&"),
    );
  }
  return files;
}
