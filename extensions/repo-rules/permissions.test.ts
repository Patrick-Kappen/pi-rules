import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type Action,
  commandMatches,
  commandsOf,
  decide,
  describeSubject,
  type Permission,
  parsePermission,
  pathMatches,
  permissionMatches,
  subjectsOf,
  type Where,
} from "./permissions.ts";

const where: Where = { cwd: "/repo/src", root: "/repo", home: "/home/u" };

function permission(text: string, action: Action = "deny"): Permission {
  const parsed = parsePermission(text, action, "global");
  if (typeof parsed === "string") throw new Error(parsed);
  return parsed;
}

describe("parsePermission", () => {
  test("tool and specifier", () => {
    expect(permission("Bash(git push *)")).toMatchObject({
      action: "deny",
      text: "Bash(git push *)",
      scope: "global",
      specifier: "git push *",
    });
    expect(permission("bash").specifier).toBeUndefined();
    expect(permission("mcp__github__*").tool.test("mcp__github__create_issue")).toBe(true);
    expect(permission("mcp__github__*").tool.test("mcp__gitlab__x")).toBe(false);
  });

  test.each([["bash()"], ["bash("], ["(x)"], ["two words"], [""]])("invalid: %s", (text) => {
    expect(parsePermission(text, "ask", "owner/repo")).toMatch(/^owner\/repo: ask/);
  });
});

describe("commandMatches", () => {
  test.each([
    ["git push *", "git push origin main"],
    ["git push *", "git push"],
    ["git push *", "git  push   --force"],
    ["git push", "git push"],
    ["npm run test:*", "npm run test:unit"],
    ["rm -rf *", "rm -rf /"],
    ["*", "anything at all"],
    ["git * --force", "git push --force"],
  ])("%s matches %s", (pattern, command) => {
    expect(commandMatches(pattern, command)).toBe(true);
  });

  test.each([
    ["git push *", "git pushx"],
    ["git push", "git push origin"],
    ["ls *", "lsof"],
    ["npm test", "npm testing"],
    ["a.b", "axb"],
  ])("%s does not match %s", (pattern, command) => {
    expect(commandMatches(pattern, command)).toBe(false);
  });
});

describe("commandsOf", () => {
  test.each([
    ["git push", ["git push"]],
    ["npm test && git push origin main", ["npm test", "git push origin main"]],
    ["a || b; c | d & e", ["a", "b", "c", "d", "e"]],
    ["echo $(git push) `rm x`", ["echo", "git push", "rm x"]],
    ["(cd x && git push)", ["cd x", "git push"]],
    ["FOO=1 BAR='a b' git push", ["git push"]],
    ["sudo -E env X=1 git push", ["git push"]],
    ["echo 'a && b' \"c; d\"", ["echo 'a && b' \"c; d\""]],
    ["bash -c 'git push --force'", ["bash -c 'git push --force'", "git push --force"]],
    ['/bin/sh -c "npm test && git push"', ['/bin/sh -c "npm test && git push"', "npm test", "git push"]],
    ["a\nb", ["a", "b"]],
    ["   ", []],
    ["echo $HOME", ["echo $HOME"]],
  ])("%s", (command, commands) => {
    expect(commandsOf(command)).toEqual(commands);
  });

  test("nested shells stop at depth 3", () => {
    const command = `sh -c "sh -c 'sh -c \\"sh -c x\\"'"`;
    expect(commandsOf(command).length).toBeLessThanOrEqual(4);
  });
});

describe("pathMatches", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-rules-perm-")));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "secrets"), { recursive: true });
  symlinkSync(repo, join(root, "link"));
  const at: Where = { cwd: repo, root: repo, home: root };

  test("relative to the root", () => {
    expect(pathMatches(".env", join(repo, ".env"), at)).toBe(true);
    expect(pathMatches(".env", join(repo, "sub", ".env"), at)).toBe(true);
    expect(pathMatches("/.env", join(repo, "sub", ".env"), at)).toBe(false);
    expect(pathMatches("secrets/**", join(repo, "secrets", "a.key"), at)).toBe(true);
    expect(pathMatches("secrets/**", join(root, "link", "secrets", "a.key"), at)).toBe(true);
    expect(pathMatches(".env", join(root, ".env"), at)).toBe(false);
  });

  test("absolute: ~/ and //", () => {
    expect(pathMatches("~/.ssh/**", join(root, ".ssh", "id_ed25519"), at)).toBe(true);
    expect(pathMatches("//etc/**", "/etc/shadow", at)).toBe(true);
    expect(pathMatches("//etc/**", "/home/etc/x", at)).toBe(false);
    expect(pathMatches(`/${join(root, "link")}/**`, join(repo, "x"), at)).toBe(false);
    expect(pathMatches(`/${repo}/**`, join(root, "link", "x"), at)).toBe(true);
  });
});

describe("subjectsOf", () => {
  test("read", () => {
    expect(subjectsOf("read", { path: "a.ts" }, where)).toEqual([{ tools: ["read"], path: "/repo/src/a.ts" }]);
    expect(subjectsOf("read", {}, where)).toEqual([{ tools: ["read"] }]);
  });

  test("search tools count as reading their path, by default the working directory", () => {
    expect(subjectsOf("grep", { pattern: "x" }, where)).toEqual([{ tools: ["grep", "read"], path: "/repo/src" }]);
    expect(subjectsOf("ls", { path: "~/x" }, where)).toEqual([{ tools: ["ls", "read"], path: "/home/u/x" }]);
    expect(subjectsOf("find", { pattern: "*.ts", path: "/a" }, where)).toEqual([
      { tools: ["find", "read"], path: "/a" },
    ]);
  });

  test("edit and write; write also answers to edit", () => {
    expect(subjectsOf("edit", { path: "a.ts" }, where)).toEqual([{ tools: ["edit"], path: "/repo/src/a.ts" }]);
    expect(subjectsOf("write", { path: "/b.ts" }, where)).toEqual([{ tools: ["write", "edit"], path: "/b.ts" }]);
    expect(subjectsOf("edit", {}, where)).toEqual([{ tools: ["edit"] }]);
  });

  test("bash: the tool, each command, and the file of a read command", () => {
    expect(subjectsOf("bash", { command: "cat .env && git push" }, where)).toEqual([
      { tools: ["bash"] },
      { tools: ["bash"], command: "cat .env" },
      { tools: ["read"], path: "/repo/src/.env" },
      { tools: ["bash"], command: "git push" },
    ]);
    expect(subjectsOf("bash", {}, where)).toEqual([{ tools: ["bash"] }]);
  });

  test("other tools, by lower-case name", () => {
    expect(subjectsOf("mcp__GitHub__delete", { path: "x" }, where)).toEqual([{ tools: ["mcp__github__delete"] }]);
  });
});

describe("permissionMatches", () => {
  test("a specifier needs a command or a path", () => {
    expect(permissionMatches(permission("read(x)"), { tools: ["read"] }, where)).toBe(false);
    expect(permissionMatches(permission("read"), { tools: ["read"] }, where)).toBe(true);
    expect(
      permissionMatches(permission("edit(*.lock)"), { tools: ["write", "edit"], path: "/repo/a.lock" }, where),
    ).toBe(true);
    expect(permissionMatches(permission("bash(ls)"), { tools: ["read"], path: "/repo/ls" }, where)).toBe(false);
  });
});

describe("decide", () => {
  const permissions = [
    permission("read(.env)"),
    permission("bash(rm -rf *)"),
    permission("bash(git push *)", "ask"),
    permission("bash(git push origin feat/*)", "allow"),
    permission("mcp__github__delete_*", "ask"),
    permission("edit(flake.lock)", "ask"),
    permission("edit(flake.lock)", "allow"),
  ];
  const call = (toolName: string, input: Record<string, unknown>) =>
    decide(permissions, subjectsOf(toolName, input, where), where);

  test("nothing matches: allow", () => {
    expect(call("bash", { command: "npm test" })).toEqual({ action: "allow" });
    expect(call("read", { path: "README.md" })).toEqual({ action: "allow" });
  });

  test("deny, also through bash", () => {
    expect(call("read", { path: "../.env" })).toMatchObject({ action: "deny", permission: { text: "read(.env)" } });
    expect(call("bash", { command: "head -5 .env" })).toMatchObject({ action: "deny" });
    expect(call("bash", { command: "npm test && rm -rf /" })).toMatchObject({
      action: "deny",
      subject: { command: "rm -rf /" },
    });
  });

  test("ask, unless allow matches the same subject", () => {
    expect(call("bash", { command: "git push origin main" })).toMatchObject({ action: "ask" });
    expect(call("bash", { command: "git push origin feat/x" })).toEqual({ action: "allow" });
    expect(call("mcp__github__delete_repo", {})).toMatchObject({ action: "ask" });
    expect(call("write", { path: "../flake.lock" })).toEqual({ action: "allow" });
  });

  test("deny wins over ask", () => {
    expect(call("bash", { command: "git push origin main; rm -rf x" })).toMatchObject({ action: "deny" });
  });
});

describe("describeSubject", () => {
  test("command, path or tool", () => {
    expect(describeSubject("bash", { tools: ["bash"], command: "git push" })).toBe("bash: git push");
    expect(describeSubject("read", { tools: ["read"], path: "/repo/.env" })).toBe("read: /repo/.env");
    expect(describeSubject("x", { tools: ["x"] })).toBe("x");
    expect(describeSubject("x", undefined)).toBe("x");
  });
});
