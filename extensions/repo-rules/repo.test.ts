import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findRepo, parseRemotes } from "./repo.ts";

describe("parseRemotes", () => {
  test("reads the url of every remote section", () => {
    const config = [
      "[core]",
      "\tbare = false",
      "\turl = not-a-remote",
      '[remote "origin"]',
      "\turl = git@github.com:owner/repo.git",
      "\tfetch = +refs/heads/*:refs/remotes/origin/*",
      "# comment",
      '[remote "upstream"]',
      '\turl = "https://github.com/upstream/repo"',
      "\tURL = ",
      '[branch "main"]',
      "\turl = also-not",
    ].join("\n");
    expect(parseRemotes(config)).toEqual(["git@github.com:owner/repo.git", "https://github.com/upstream/repo"]);
  });

  test("empty config", () => {
    expect(parseRemotes("")).toEqual([]);
  });
});

describe("findRepo", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "repo-mcp-")));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(path: string, content: string): void {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }

  test("main checkout, from a subdirectory", () => {
    write("main/.git/config", '[remote "origin"]\n\turl = git@github.com:owner/repo.git\n');
    mkdirSync(join(root, "main/src/deep"), { recursive: true });
    expect(findRepo(join(root, "main/src/deep"))).toEqual({
      worktreeRoot: join(root, "main"),
      commonDir: join(root, "main/.git"),
      mainRoot: join(root, "main"),
      remotes: ["git@github.com:owner/repo.git"],
    });
  });

  test("linked worktree points to the main checkout", () => {
    write("main/.git/config", '[remote "origin"]\n\turl = https://github.com/owner/repo\n');
    write("main/.git/worktrees/feature/commondir", "../..\n");
    write("trees/feature/.git", `gitdir: ${join(root, "main/.git/worktrees/feature")}\n`);
    const repo = findRepo(join(root, "trees/feature"));
    expect(repo?.worktreeRoot).toBe(join(root, "trees/feature"));
    expect(repo?.commonDir).toBe(join(root, "main/.git"));
    expect(repo?.mainRoot).toBe(join(root, "main"));
    expect(repo?.remotes).toEqual(["https://github.com/owner/repo"]);
  });

  test("relative gitdir and absolute commondir", () => {
    write("bare.git/config", '[remote "origin"]\n\turl = git@host:o/r\n');
    write("bare.git/worktrees/wt/commondir", join(root, "bare.git"));
    write("wt/.git", "gitdir: ../bare.git/worktrees/wt");
    const repo = findRepo(join(root, "wt"));
    expect(repo?.commonDir).toBe(join(root, "bare.git"));
    expect(repo?.mainRoot).toBe(join(root, "bare.git"));
    expect(repo?.remotes).toEqual(["git@host:o/r"]);
  });

  test("repository without config", () => {
    mkdirSync(join(root, "main/.git"), { recursive: true });
    expect(findRepo(join(root, "main"))?.remotes).toEqual([]);
  });

  test("invalid .git file is skipped", () => {
    write("outer/.git/config", "");
    write("outer/inner/.git", "garbage");
    expect(findRepo(join(root, "outer/inner"))?.worktreeRoot).toBe(join(root, "outer"));
  });

  test("no repository", () => {
    mkdirSync(join(root, "plain"));
    // The temp directory itself might be inside a repository on odd systems; only check the parts we control.
    const repo = findRepo(join(root, "plain"));
    expect(repo?.worktreeRoot.startsWith(root) ?? false).toBe(false);
  });
});
