/**
 * Globs for the `paths` of a rule, matched against a path relative to the repository root, with `/`
 * as separator.
 *
 * - `*` matches within one path segment, `**` across segments, `?` one character.
 * - `[abc]`, `[a-z]` and `[!abc]` match one character of (or not of) a set.
 * - `{a,b}` matches either alternative; alternatives may contain globs.
 * - A pattern without `/` matches at any depth: `*.md` is `**\/*.md`.
 * - A leading `/` or `./` anchors the pattern at the root; a trailing `/` matches everything below.
 */
export function globToRegExp(pattern: string): RegExp {
  let glob = pattern.trim();
  if (glob.endsWith("/")) glob += "**";
  if (glob.startsWith("./")) glob = glob.slice(2);
  else if (glob.startsWith("/")) glob = glob.slice(1);
  else if (!glob.includes("/")) glob = `**/${glob}`;
  return new RegExp(`^${convert(glob)}$`);
}

function escapeChar(char: string): string {
  return /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** The index of the `}` that closes the `{` at `start`, or -1. */
function closingBrace(glob: string, start: number): number {
  let depth = 0;
  for (let i = start; i < glob.length; i++) {
    if (glob[i] === "{") depth++;
    else if (glob[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Split the inside of `{...}` at the commas of its own level. */
function alternatives(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of inner) {
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    if (char === "{") depth++;
    if (char === "}") depth--;
    current += char;
  }
  parts.push(current);
  return parts;
}

function convertClass(glob: string, start: number): [string, number] | undefined {
  const end = glob.indexOf("]", start + 2);
  if (end === -1) return undefined;
  let body = glob.slice(start + 1, end);
  const negated = body.startsWith("!") || body.startsWith("^");
  if (negated) body = body.slice(1);
  body = body.replace(/[\\\]^]/g, "\\$&");
  return [`[${negated ? "^" : ""}${body}]`, end + 1];
}

function convertStars(glob: string, i: number): [string, number] {
  if (glob[i + 1] !== "*") return ["[^/]*", i + 1];
  // `**/` at the start of a segment also matches no directory at all: `src/**/a.ts` matches `src/a.ts`.
  const atStart = i === 0 || glob[i - 1] === "/";
  if (atStart && glob[i + 2] === "/") return ["(?:.*/)?", i + 3];
  return [".*", i + 2];
}

/** The regex for the glob token at `i`, and the index after it. */
function convertAt(glob: string, i: number): [string, number] {
  const char = glob[i] as string;
  if (char === "*") return convertStars(glob, i);
  if (char === "?") return ["[^/]", i + 1];
  if (char === "[") {
    const set = convertClass(glob, i);
    if (set) return set;
  }
  if (char === "{") {
    const end = closingBrace(glob, i);
    if (end !== -1)
      return [
        `(?:${alternatives(glob.slice(i + 1, end))
          .map(convert)
          .join("|")})`,
        end + 1,
      ];
  }
  return [escapeChar(char), i + 1];
}

function convert(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const [regex, next] = convertAt(glob, i);
    out += regex;
    i = next;
  }
  return out;
}

/** Whether `relativePath` (with `/` separators) matches any of `patterns`. */
export function matchesAny(patterns: readonly RegExp[], relativePath: string): boolean {
  return patterns.some((pattern) => pattern.test(relativePath));
}
