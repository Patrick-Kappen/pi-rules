import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** What identifies the repository a directory belongs to. */
export interface RepoInfo {
  /** Root of the worktree that contains the directory. */
  worktreeRoot: string;
  /** The shared git directory: the same for the main checkout and all its worktrees. */
  commonDir: string;
  /** Root of the main checkout (or the bare repository) that owns all worktrees. */
  mainRoot: string;
  /** URLs of all configured remotes, in config order. */
  remotes: string[];
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The git directory named by a `.git` entry: the directory itself or the target of a `gitdir:` file. */
function gitDirOf(dotGit: string): string | undefined {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(dotGit);
  } catch {
    return undefined;
  }
  if (stat.isDirectory()) return dotGit;
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? "");
  if (!match?.[1]) return undefined;
  return resolve(dirname(dotGit), match[1]);
}

/** Remote URLs from the `[remote "<name>"]` sections of a git config file. */
export function parseRemotes(config: string): string[] {
  const urls: string[] = [];
  let inRemote = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      inRemote = /^\[\s*remote\s+"[^"]*"\s*\]$/i.test(line);
      continue;
    }
    if (!inRemote) continue;
    const match = /^url\s*=\s*(.*)$/i.exec(line);
    if (!match?.[1]) continue;
    const url = match[1].replace(/^"(.*)"$/, "$1").trim();
    if (url !== "") urls.push(url);
  }
  return urls;
}

/** The shared git directory of a (worktree) git directory, from its `commondir` file. */
function commonDirOf(gitDir: string): string {
  const commondir = readText(join(gitDir, "commondir"))?.trim();
  if (!commondir) return realpath(gitDir);
  return realpath(isAbsolute(commondir) ? commondir : resolve(gitDir, commondir));
}

/** The repository whose worktree root is `dir`, if `dir` has a `.git` entry. */
function repoAt(dir: string): RepoInfo | undefined {
  const gitDir = gitDirOf(join(dir, ".git"));
  if (!gitDir) return undefined;
  const commonDir = commonDirOf(gitDir);
  return {
    worktreeRoot: realpath(dir),
    commonDir,
    mainRoot: basename(commonDir) === ".git" ? dirname(commonDir) : commonDir,
    remotes: parseRemotes(readText(join(commonDir, "config")) ?? ""),
  };
}

/**
 * Find the repository that contains `cwd` by reading `.git` entries, without running git.
 * Works for normal checkouts, linked worktrees (`git worktree add`) and submodules.
 */
export function findRepo(cwd: string): RepoInfo | undefined {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const repo = repoAt(dir);
    if (repo) return repo;
    if (dirname(dir) === dir) return undefined;
  }
}
