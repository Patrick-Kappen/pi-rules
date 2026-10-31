import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { findRepo, type RepoInfo } from "./repo.ts";

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The git directory of a worktree: `.git` itself, or the target of its `gitdir:` file. */
function gitDirOf(worktreeRoot: string): string | undefined {
  const dotGit = join(worktreeRoot, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
  } catch {
    return undefined;
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? "");
  return match?.[1] ? resolve(worktreeRoot, match[1]) : undefined;
}

/** The branch checked out in a worktree; undefined for a detached HEAD. */
export function currentBranch(repo: RepoInfo): string | undefined {
  const gitDir = gitDirOf(repo.worktreeRoot);
  const head = gitDir ? readText(join(gitDir, "HEAD")) : undefined;
  return /^ref: refs\/heads\/(.+?)\s*$/m.exec(head ?? "")?.[1];
}

/** The default branch of origin, from refs/remotes/origin/HEAD; undefined when git never recorded it. */
export function defaultBranch(repo: RepoInfo): string | undefined {
  const head = readText(join(repo.commonDir, "refs", "remotes", "origin", "HEAD"));
  return /^ref: refs\/remotes\/origin\/(.+?)\s*$/m.exec(head ?? "")?.[1];
}

/** The closest directory of a path that exists, so a new file finds its repository. */
function existingDir(path: string): string {
  let dir = dirname(path);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

/**
 * Whether a file is "on main": in the main checkout of a repository (not a linked worktree), or on
 * its default branch (origin's HEAD; without it, main or master).
 */
export function onMain(path: string): boolean {
  const repo = findRepo(existingDir(path));
  if (!repo) return false;
  if (repo.worktreeRoot === repo.mainRoot) return true;
  const branch = currentBranch(repo);
  if (branch === undefined) return false;
  const main = defaultBranch(repo);
  return main === undefined ? branch === "main" || branch === "master" : branch === main;
}
