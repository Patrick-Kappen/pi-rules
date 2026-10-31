import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { currentBranch, defaultBranch, onMain } from "./branch.ts";
import { decide, parsePermission, subjectsOf } from "./permissions.ts";
import { findRepo, type RepoInfo } from "./repo.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-rules-branch-")));
const origin = join(root, "origin.git");
const main = join(root, "main");
const feature = join(root, "feature");
const onDefault = join(root, "on-default");
const local = join(root, "local");

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    stdio: "ignore",
  });
}

beforeAll(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
  git(root, "init", "-q", "--bare", origin);
  git(root, "clone", "-q", origin, main);
  writeFileSync(join(main, "a.txt"), "a\n");
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "start");
  git(main, "push", "-q", "origin", "main");
  git(main, "remote", "set-head", "origin", "main");
  git(main, "worktree", "add", "-q", "-b", "feat/x", feature);
  // The main checkout moves to another branch, so a worktree can have the default branch.
  git(main, "switch", "-q", "-c", "dev");
  git(main, "worktree", "add", "-q", onDefault, "main");
  git(root, "init", "-q", local);
});

function repoOf(dir: string): RepoInfo {
  const repo = findRepo(dir);
  if (!repo) throw new Error(`no repository at ${dir}`);
  return repo;
}

describe("branches", () => {
  test("currentBranch and defaultBranch", () => {
    expect(currentBranch(repoOf(feature))).toBe("feat/x");
    expect(currentBranch(repoOf(main))).toBe("dev");
    expect(defaultBranch(repoOf(feature))).toBe("main");
    expect(defaultBranch(repoOf(local))).toBeUndefined();
  });

  test("onMain: the main checkout and the default branch are main; a feature worktree is not", () => {
    expect(onMain(join(main, "a.txt"))).toBe(true);
    expect(onMain(join(main, "new", "dir", "b.txt"))).toBe(true);
    expect(onMain(join(onDefault, "a.txt"))).toBe(true);
    expect(onMain(join(feature, "a.txt"))).toBe(false);
    expect(onMain(join(feature, "src", "new.ts"))).toBe(false);
    expect(onMain(join(root, "outside.txt"))).toBe(false);
  });

  test("without origin's HEAD, main and master count as the default branch", () => {
    git(local, "commit", "-q", "--allow-empty", "-m", "x");
    const other = join(root, "local-feature");
    git(local, "worktree", "add", "-q", "-b", "topic", other);
    expect(onMain(join(other, "f.txt"))).toBe(false);
    const master = join(root, "local-master");
    git(local, "branch", "master");
    git(local, "worktree", "add", "-q", master, "master");
    expect(onMain(join(master, "f.txt"))).toBe(true);
    git(other, "switch", "-q", "--detach");
    expect(onMain(join(other, "f.txt"))).toBe(false);
  });
});

describe("edit(@main) as a permission", () => {
  test("blocks edit and write on main, not in a feature worktree", () => {
    const rule = parsePermission("edit(@main)", "deny", "global");
    if (typeof rule === "string") throw new Error(rule);
    const where = { cwd: main, root: main, home: root };
    const decision = (file: string, tool = "edit") =>
      decide([rule], subjectsOf(tool, { path: file }, where), where).action;
    expect(decision(join(main, "a.txt"))).toBe("deny");
    expect(decision(join(onDefault, "new.ts"), "write")).toBe("deny");
    expect(decision(join(feature, "a.txt"))).toBe("allow");
    expect(decision(join(main, "a.txt"), "read")).toBe("allow");
  });
});
