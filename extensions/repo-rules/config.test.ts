import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { agentDir, configPath, loadConfig, parseConfig } from "./config.ts";

const home = "/home/u";

describe("configPath", () => {
  test("default", () => {
    expect(configPath({}, home)).toBe("/home/u/.pi/agent/repo-rules.json");
  });

  test("PI_CODING_AGENT_DIR", () => {
    expect(agentDir({ PI_CODING_AGENT_DIR: "~/agent" }, home)).toBe("/home/u/agent");
    expect(configPath({ PI_CODING_AGENT_DIR: "/agent" }, home)).toBe("/agent/repo-rules.json");
  });

  test("PI_REPO_RULES_CONFIG", () => {
    expect(configPath({ PI_REPO_RULES_CONFIG: "~/rules.json" }, home)).toBe("/home/u/rules.json");
  });
});

describe("parseConfig", () => {
  test("global and repos", () => {
    const config = parseConfig(
      {
        global: { rules: ["/rules/a.md", "~/rules/b.md"] },
        repos: { "owner/repo": { rules: ["/rules/c.md"] }, "~/src": {} },
      },
      "cfg",
      home,
    );
    expect(config).toEqual({
      path: "cfg",
      scopes: [
        { name: "global", pattern: "*", rules: ["/rules/a.md", "/home/u/rules/b.md"], permissions: [] },
        { name: "owner/repo", pattern: "owner/repo", rules: ["/rules/c.md"], permissions: [] },
        { name: "~/src", pattern: "~/src", rules: [], permissions: [] },
      ],
      errors: [],
    });
  });

  test("empty", () => {
    expect(parseConfig({}, "cfg", home)).toEqual({ path: "cfg", scopes: [], errors: [] });
  });

  test("not an object", () => {
    expect(parseConfig([], "cfg", home).errors).toEqual(["cfg: expected a JSON object"]);
  });

  test("repos not an object", () => {
    const config = parseConfig({ global: { rules: [] }, repos: [] }, "cfg", home);
    expect(config.scopes).toHaveLength(1);
    expect(config.errors).toEqual(['cfg: "repos" must be an object']);
  });

  test("invalid entries are reported, valid ones kept", () => {
    const config = parseConfig(
      {
        other: true,
        global: { rules: ["relative.md", 3, "/ok.md"], hooks: {} },
        repos: { " ": {}, "a/b": "x", "c/d": { rules: "x" } },
      },
      "cfg",
      home,
    );
    expect(config.scopes).toEqual([
      { name: "global", pattern: "*", rules: ["/ok.md"], permissions: [] },
      { name: "c/d", pattern: "c/d", rules: [], permissions: [] },
    ]);
    expect(config.errors).toEqual([
      'cfg: unknown key "other"',
      'cfg: global: unknown key "hooks"',
      'cfg: global: rule "relative.md" is not an absolute path or ~/path',
      "cfg: global: rule 3 is not an absolute path or ~/path",
      "cfg: repos: empty pattern",
      'cfg: repos."a/b": must be an object',
      'cfg: repos."c/d": "rules" must be a list of files',
    ]);
  });
});

describe("permissions", () => {
  test("deny, ask and allow, in that order", () => {
    const config = parseConfig(
      { global: { permissions: { allow: ["bash(npm test)"], ask: ["bash(git push *)"], deny: ["read(.env)"] } } },
      "cfg",
      home,
    );
    expect(config.errors).toEqual([]);
    expect(config.scopes[0]?.permissions.map(({ action, text, scope }) => [action, text, scope])).toEqual([
      ["deny", "read(.env)", "global"],
      ["ask", "bash(git push *)", "global"],
      ["allow", "bash(npm test)", "global"],
    ]);
  });

  test("invalid permissions are reported, valid ones kept", () => {
    const config = parseConfig(
      {
        global: { permissions: { deny: ["read(", 3, "bash"], ask: "x", maybe: [] } },
        repos: { "a/b": { permissions: [] } },
      },
      "cfg",
      home,
    );
    expect(config.scopes[0]?.permissions.map(({ text }) => text)).toEqual(["bash"]);
    expect(config.scopes[1]?.permissions).toEqual([]);
    expect(config.errors).toEqual([
      'cfg: global: permissions: unknown key "maybe"',
      'global: deny "read(": expected tool or tool(specifier)',
      "global: deny 3: not a string",
      "cfg: global: permissions.ask must be a list",
      'cfg: repos."a/b": "permissions" must be an object with deny, ask and allow',
    ]);
  });
});

describe("loadConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-rules-config-"));

  test("missing file", () => {
    expect(loadConfig(join(dir, "missing.json"), home)).toEqual({
      path: join(dir, "missing.json"),
      scopes: [],
      errors: [],
    });
  });

  test("valid file", () => {
    const file = join(dir, "ok.json");
    writeFileSync(file, JSON.stringify({ global: { rules: ["/a.md"] } }));
    expect(loadConfig(file, home).scopes).toEqual([
      { name: "global", pattern: "*", rules: ["/a.md"], permissions: [] },
    ]);
  });

  test("invalid JSON", () => {
    const file = join(dir, "bad.json");
    writeFileSync(file, "{");
    expect(loadConfig(file, home).errors[0]).toMatch(/invalid JSON/);
  });

  test("unreadable file", () => {
    const file = join(dir, "dir.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o000);
    const errors = loadConfig(file, home).errors;
    chmodSync(file, 0o644);
    // root can read anything; then there is no error.
    if (process.getuid?.() !== 0) expect(errors[0]).toMatch(/EACCES|permission/i);
  });
});
