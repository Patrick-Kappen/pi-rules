import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  blockMessage,
  clip,
  describeFailure,
  type Hook,
  type HookRun,
  hookApplies,
  MAX_OUTPUT,
  parseHook,
  parseHooks,
  runHook,
} from "./hooks.ts";

function hook(raw: Record<string, unknown>, event: Hook["event"] = "tool_result"): Hook {
  const parsed = parseHook(raw, event, "global");
  if (typeof parsed === "string") throw new Error(parsed);
  return parsed;
}

describe("parseHook", () => {
  test("a hook with filters", () => {
    expect(
      hook({ run: "biome format", tools: ["Edit", "write"], paths: "**/*.ts", command: ["git *"], timeout: 5 }),
    ).toMatchObject({
      event: "tool_result",
      scope: "global",
      run: "biome format",
      tools: ["Edit", "write"],
      paths: ["**/*.ts"],
      commands: ["git *"],
      timeoutMs: 5000,
    });
    expect(hook({ run: "x" }).timeoutMs).toBe(60_000);
  });

  test.each([
    ["x", "a hook must be an object"],
    [{}, '"run" must be a command'],
    [{ run: " " }, '"run" must be a command'],
    [{ run: "x", other: 1 }, 'unknown key "other"'],
    [{ run: "x", tools: 3 }, "must be strings or lists"],
    [{ run: "x", paths: [1] }, "must be strings or lists"],
    [{ run: "x", timeout: 0 }, '"timeout" must be a number'],
    [{ run: "x", timeout: "5" }, '"timeout" must be a number'],
  ])("invalid: %j", (raw, error) => {
    expect(parseHook(raw, "tool_call", "owner/repo")).toContain(error);
  });

  test("filters only on tool events", () => {
    expect(parseHook({ run: "x", tools: ["bash"] }, "agent_before_settle", "global")).toBe(
      'global: hooks.agent_before_settle: "tools", "paths" and "command" only work on tool_call and tool_result',
    );
  });
});

describe("parseHooks", () => {
  test("hooks per event", () => {
    const errors: string[] = [];
    const hooks = parseHooks(
      { tool_call: [{ run: "a" }], agent_before_settle: [{ run: "b" }, { run: "" }], nope: [], session_start: {} },
      "global",
      errors,
    );
    expect(hooks.map((h) => [h.event, h.run])).toEqual([
      ["tool_call", "a"],
      ["agent_before_settle", "b"],
    ]);
    expect(errors).toEqual([
      'global: hooks.agent_before_settle: "run" must be a command',
      expect.stringContaining('global: hooks: unknown event "nope"'),
      "global: hooks.session_start must be a list",
    ]);
  });

  test("missing or invalid", () => {
    const errors: string[] = [];
    expect(parseHooks(undefined, "global", errors)).toEqual([]);
    expect(parseHooks([], "global", errors)).toEqual([]);
    expect(errors).toEqual(['global: "hooks" must be an object with lists per event']);
  });
});

describe("hookApplies", () => {
  const facts = { toolName: "edit", relative: ["src/a.ts"], commands: [] };

  test("event, then each filter it has", () => {
    expect(hookApplies(hook({ run: "x" }), "tool_result", facts)).toBe(true);
    expect(hookApplies(hook({ run: "x" }), "tool_call", facts)).toBe(false);
    expect(hookApplies(hook({ run: "x" }, "session_start"), "session_start")).toBe(true);
    expect(hookApplies(hook({ run: "x", tools: ["EDIT", "write"] }), "tool_result", facts)).toBe(true);
    expect(hookApplies(hook({ run: "x", tools: ["mcp__*"] }), "tool_result", facts)).toBe(false);
    expect(hookApplies(hook({ run: "x", paths: ["**/*.ts"] }), "tool_result", facts)).toBe(true);
    expect(hookApplies(hook({ run: "x", paths: ["*.md"] }), "tool_result", facts)).toBe(false);
    expect(hookApplies(hook({ run: "x", command: "git *" }), "tool_result", facts)).toBe(false);
  });

  test("command globs match one command of the line", () => {
    const bash = { toolName: "bash", relative: [], commands: ["npm test", "git commit -m x"] };
    expect(hookApplies(hook({ run: "x", command: ["git commit *"] }), "tool_result", bash)).toBe(true);
    expect(hookApplies(hook({ run: "x", command: ["git push *"] }), "tool_result", bash)).toBe(false);
  });
});

describe("runHook", () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "repo-rules-hooks-")));
  const options = { cwd, env: { PI_FILE: "/x.ts" }, input: { event: "tool_result", n: 1 } };

  test("stdout, stderr, exit code, environment, stdin and working directory", async () => {
    const run = await runHook(hook({ run: 'echo "$PI_FILE $(pwd)"; cat; echo oops >&2; exit 3' }), options);
    expect(run.code).toBe(3);
    expect(run.stdout).toBe(`/x.ts ${cwd}\n{"event":"tool_result","n":1}`);
    expect(run.stderr).toBe("oops\n");
    expect(run.failure).toBeUndefined();
  });

  test("timeout", async () => {
    const run = await runHook(hook({ run: "sleep 5", timeout: 0.2 }), options);
    expect(run).toMatchObject({ code: null, failure: "timed out after 0.2s" });
  });

  test("aborted", async () => {
    const controller = new AbortController();
    const running = runHook(hook({ run: "sleep 5" }), { ...options, signal: controller.signal });
    controller.abort();
    expect(await running).toMatchObject({ code: null, failure: "aborted" });
  });

  test("a working directory that does not exist", async () => {
    const run = await runHook(hook({ run: "true" }), { ...options, cwd: join(cwd, "missing") });
    expect(run.code).toBeNull();
    expect(run.failure).toMatch(/ENOENT/);
  });
});

describe("output", () => {
  const run = (fields: Partial<HookRun>): HookRun => ({
    hook: hook({ run: "check" }, "agent_before_settle"),
    code: 2,
    stdout: "",
    stderr: "",
    ...fields,
  });

  test("clip", () => {
    expect(clip("  short \n")).toBe("short");
    const long = clip("x".repeat(MAX_OUTPUT + 5));
    expect(long).toHaveLength(MAX_OUTPUT + "\n[... 5 more characters cut by repo-rules]".length);
  });

  test("blockMessage: stderr, else stdout, else a default", () => {
    expect(blockMessage(run({ stderr: "bad\n", stdout: "out" }))).toBe("bad");
    expect(blockMessage(run({ stdout: "out" }))).toBe("out");
    expect(blockMessage(run({}))).toBe('hook "check" exited with 2');
  });

  test("describeFailure", () => {
    expect(describeFailure(run({ code: 1, stderr: "1\n2\n3\n4\n5\n6" }))).toBe(
      'repo-rules: hook agent_before_settle "check" (global) failed: exit code 1\n1\n2\n3\n4\n5',
    );
    expect(describeFailure(run({ code: null, failure: "timed out after 1s" }))).toBe(
      'repo-rules: hook agent_before_settle "check" (global) failed: timed out after 1s',
    );
  });
});
