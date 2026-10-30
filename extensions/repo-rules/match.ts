import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { RepoInfo } from "./repo.ts";

/**
 * Normalize a git remote URL to `host/path` without scheme, user, port and `.git`, in lower case.
 * `git@github.com:Owner/Repo.git` and `https://github.com/owner/repo` both become `github.com/owner/repo`.
 * Returns undefined for local remotes (paths and file:// URLs).
 */
export function normalizeRemote(url: string): string | undefined {
  let rest = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(rest);
  if (scheme) {
    if (scheme[1]?.toLowerCase() === "file") return undefined;
    rest = rest.slice(scheme[0].length);
    rest = rest.replace(/^[^@/]*@/, "");
    rest = rest.replace(/^([^/:]+):\d+(?=\/|$)/, "$1");
  } else {
    const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+)$/.exec(rest);
    if (!scp) return undefined;
    rest = `${scp[1]}/${scp[2]}`;
  }
  rest = rest
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/{2,}/g, "/");
  if (!rest.includes("/")) return undefined;
  return rest.toLowerCase();
}

/** True for entries that name a directory instead of a remote. */
export function isPathPattern(pattern: string): boolean {
  return pattern.startsWith("/") || pattern === "~" || pattern.startsWith("~/");
}

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return resolve(home, path.slice(2));
  return resolve(path);
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** `*` matches within one path segment; the pattern matches the end of the remote at a segment boundary. */
export function remoteMatches(pattern: string, remote: string): boolean {
  const normalized = pattern
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "");
  if (normalized === "") return false;
  const body = normalized.split("*").map(escapeRegExp).join("[^/]*");
  return new RegExp(`(^|/)${body}$`).test(remote);
}

export interface MatchContext {
  cwd: string;
  home: string;
  repo: RepoInfo | undefined;
}

/**
 * Whether one entry of a server's `repos` list matches the session.
 *
 * - A path (`/…` or `~/…`) matches when the working directory, its worktree or the main
 *   checkout of the repository lies in that directory. Worktrees elsewhere match through their main checkout.
 * - Anything else is a remote: `owner/repo`, `host/owner/repo` or with `*`, such as `owner/*`.
 *   It matches when any remote of the repository ends with it.
 */
export function patternMatches(pattern: string, ctx: MatchContext): boolean {
  if (isPathPattern(pattern)) {
    const dir = realpath(expandHome(pattern, ctx.home));
    const candidates = [realpath(resolve(ctx.cwd))];
    if (ctx.repo) candidates.push(ctx.repo.worktreeRoot, ctx.repo.mainRoot);
    return candidates.some((candidate) => isInside(candidate, dir));
  }
  if (!ctx.repo) return false;
  return ctx.repo.remotes.some((url) => {
    const remote = normalizeRemote(url);
    return remote !== undefined && remoteMatches(pattern, remote);
  });
}

/** The first entry of `patterns` that matches, or undefined. */
export function firstMatch(patterns: readonly string[], ctx: MatchContext): string | undefined {
  return patterns.find((pattern) => patternMatches(pattern, ctx));
}
