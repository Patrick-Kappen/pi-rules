import { describe, expect, test } from "vitest";
import {
  expandHome,
  firstMatch,
  isPathPattern,
  type MatchContext,
  normalizeRemote,
  patternMatches,
  remoteMatches,
} from "./match.ts";

describe("normalizeRemote", () => {
  test.each([
    ["git@github.com:Patrick-Kappen/pi-mcp-servers.git", "github.com/patrick-kappen/pi-mcp-servers"],
    ["https://github.com/Patrick-Kappen/pi-mcp-servers", "github.com/patrick-kappen/pi-mcp-servers"],
    ["https://user:token@github.com/owner/repo.git/", "github.com/owner/repo"],
    ["ssh://git@github.com:22/owner/repo.git", "github.com/owner/repo"],
    ["ssh://git@gitlab.example.com/group/sub/repo", "gitlab.example.com/group/sub/repo"],
    ["git://example.org//owner//repo", "example.org/owner/repo"],
    ["github.com:owner/repo", "github.com/owner/repo"],
  ])("%s", (url, expected) => {
    expect(normalizeRemote(url)).toBe(expected);
  });

  test.each([["/srv/git/repo.git"], ["file:///srv/git/repo.git"], ["../other"], ["https://example.org"], ["C:/repo"]])(
    "local or invalid: %s",
    (url) => {
      expect(normalizeRemote(url)).toBeUndefined();
    },
  );
});

describe("remoteMatches", () => {
  const remote = "github.com/patrick-kappen/pi-mcp-servers";

  test.each([
    ["Patrick-Kappen/pi-mcp-servers", true],
    ["github.com/Patrick-Kappen/pi-mcp-servers", true],
    ["patrick-kappen/pi-mcp-servers.git", true],
    ["/patrick-kappen/pi-mcp-servers/", true],
    ["pi-mcp-servers", true],
    ["Patrick-Kappen/*", true],
    ["*/pi-mcp-*", true],
    ["kappen/pi-mcp-servers", false],
    ["Patrick-Kappen/pi-mcp", false],
    ["other/pi-mcp-servers", false],
    ["*", true],
    ["", false],
    ["gitlab.com/Patrick-Kappen/pi-mcp-servers", false],
  ])("%s -> %s", (pattern, expected) => {
    expect(remoteMatches(pattern, remote)).toBe(expected);
  });

  test("treats regex characters literally", () => {
    expect(remoteMatches("owner/a.b", "github.com/owner/a.b")).toBe(true);
    expect(remoteMatches("owner/a.b", "github.com/owner/axb")).toBe(false);
  });
});

describe("paths", () => {
  test("isPathPattern", () => {
    expect(isPathPattern("/srv/repo")).toBe(true);
    expect(isPathPattern("~/work")).toBe(true);
    expect(isPathPattern("~")).toBe(true);
    expect(isPathPattern("~other/x")).toBe(false);
    expect(isPathPattern("owner/repo")).toBe(false);
  });

  test("expandHome", () => {
    expect(expandHome("~", "/home/u")).toBe("/home/u");
    expect(expandHome("~/work/x", "/home/u")).toBe("/home/u/work/x");
    expect(expandHome("/abs/x/", "/home/u")).toBe("/abs/x");
  });
});

describe("patternMatches", () => {
  const home = "/nonexistent-home";
  const repo = {
    worktreeRoot: "/nonexistent/worktrees/feature",
    commonDir: "/nonexistent/main/.git",
    mainRoot: "/nonexistent/main",
    remotes: ["/local/mirror.git", "git@github.com:Owner/Repo.git"],
  };
  const inWorktree: MatchContext = { cwd: "/nonexistent/worktrees/feature/src", home, repo };

  test("path of the main checkout matches its worktrees", () => {
    expect(patternMatches("/nonexistent/main", inWorktree)).toBe(true);
  });

  test("path of a parent directory matches", () => {
    expect(patternMatches("/nonexistent", inWorktree)).toBe(true);
    expect(patternMatches("/nonexistent/worktrees", inWorktree)).toBe(true);
  });

  test("path with a shared prefix does not match", () => {
    expect(patternMatches("/nonexistent/mai", inWorktree)).toBe(false);
  });

  test("~ expands to the home directory", () => {
    expect(patternMatches("~/x", { cwd: `${home}/x/y`, home, repo: undefined })).toBe(true);
    expect(patternMatches("~/z", { cwd: `${home}/x/y`, home, repo: undefined })).toBe(false);
  });

  test("remote matches any remote and skips local ones", () => {
    expect(patternMatches("owner/repo", inWorktree)).toBe(true);
    expect(patternMatches("mirror", inWorktree)).toBe(false);
  });

  test("remote never matches outside a repository", () => {
    expect(patternMatches("owner/repo", { cwd: "/tmp", home, repo: undefined })).toBe(false);
  });

  test("firstMatch returns the first matching entry", () => {
    expect(firstMatch(["other/repo", "owner/*", "owner/repo"], inWorktree)).toBe("owner/*");
    expect(firstMatch(["other/repo"], inWorktree)).toBeUndefined();
  });
});
