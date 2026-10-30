import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, test, vi } from "vitest";
import repoRules, { createRepoRules, deliveredRules, PROMPT_SECTION, type RepoRulesApi } from "./index.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-rules-index-")));
const rules = join(root, "rules");
const repo = join(root, "repo");
const worktree = join(root, "worktree");
const plain = join(root, "plain");
const configFile = join(root, "repo-rules.json");

function git(...args: string[]): void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { env, stdio: "ignore" });
}

beforeAll(() => {
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, "always.md"), "ALWAYS");
  writeFileSync(join(rules, "api.md"), "---\npaths: [src/api/**/*.ts]\n---\nAPI");
  writeFileSync(join(rules, "docs.md"), "---\npaths: ['*.md']\n---\nDOCS");
  writeFileSync(join(rules, "other.md"), "OTHER");
  mkdirSync(join(repo, "src", "api"), { recursive: true });
  mkdirSync(plain, { recursive: true });
  git("init", "-q", repo);
  git("-C", repo, "remote", "add", "origin", "git@github.com:Owner/Repo.git");
  git("-C", repo, "commit", "-q", "--allow-empty", "-m", "init");
  git("-C", repo, "worktree", "add", "-q", "-b", "feature", worktree);
  writeFileSync(
    configFile,
    JSON.stringify({
      global: {
        rules: [join(rules, "always.md"), join(rules, "docs.md")],
        permissions: { deny: ["read(.env)"], ask: ["bash(git push *)"] },
      },
      repos: {
        "owner/repo": {
          rules: [join(rules, "api.md"), join(rules, "docs.md"), join(rules, "missing.md")],
          permissions: { allow: ["bash(git push origin feat/*)"] },
        },
        "someone/else": { rules: [join(rules, "other.md")] },
      },
    }),
  );
});

type Handler = (event: unknown, ctx: unknown) => unknown;
type Entry = { type: string; message?: { role: string; content: Array<{ type: string; text?: string }> } };

function load(file = configFile) {
  const handlers = new Map<string, Handler>();
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: (_name: string, options: { handler: typeof command }) => {
      command = options.handler;
    },
  } as unknown as RepoRulesApi;
  createRepoRules(pi, { env: { PI_REPO_RULES_CONFIG: file }, home: root });
  const notify = vi.fn();
  const select = vi.fn<(title: string, options: string[], opts?: unknown) => Promise<string | undefined>>();
  let entries: Entry[] = [];
  let signal: AbortSignal | undefined;
  const ctx = (cwd: string, hasUI = true) => ({
    cwd,
    hasUI,
    signal,
    ui: { notify, select },
    sessionManager: { buildContextEntries: () => entries },
  });
  const emit = (name: string, event: object, cwd = repo, hasUI = true) =>
    handlers.get(name)?.({ type: name, ...event }, ctx(cwd, hasUI));
  return {
    emit,
    setEntries: (next: Entry[]) => {
      entries = next;
    },
    start: (cwd = repo, hasUI = true) => emit("session_start", { reason: "startup" }, cwd, hasUI),
    prompt: (cwd = repo) => {
      const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
      emit("before_agent_start", event, cwd);
      return event.systemPromptOptions.sections[PROMPT_SECTION];
    },
    result: (toolName: string, input: object, extra: object = {}, cwd = repo) =>
      emit(
        "tool_result",
        { toolCallId: "call-1", toolName, input, content: [{ type: "text", text: "out" }], isError: false, ...extra },
        cwd,
      ) as Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: unknown } | undefined>,
    call: (toolName: string, input: object, hasUI = true, cwd = repo) =>
      emit("tool_call", { toolCallId: "call-1", toolName, input }, cwd, hasUI) as Promise<
        { block: boolean; reason: string } | undefined
      >,
    setSignal: (next: AbortSignal | undefined) => {
      signal = next;
    },
    select,
    command: async (cwd = repo) => {
      await command?.("", ctx(cwd));
      return notify.mock.lastCall?.[0] as string;
    },
    notify,
  };
}

describe("session_start", () => {
  test("reports errors with a UI", async () => {
    const ext = load();
    await ext.start();
    expect(ext.notify).toHaveBeenCalledWith(expect.stringContaining("missing.md: ENOENT"), "warning");
  });

  test("no report without a UI or without errors", async () => {
    const ext = load();
    await ext.start(repo, false);
    await ext.start(plain);
    expect(ext.notify).not.toHaveBeenCalled();
  });
});

describe("before_agent_start", () => {
  test("in the repository: global and repo rules", async () => {
    const ext = load();
    await ext.start();
    const section = ext.prompt();
    expect(section).toContain("ALWAYS");
    expect(section).toContain("- api (src/api/**/*.ts)");
    expect(section).toContain("- docs (*.md)");
    expect(section).not.toContain("OTHER");
  });

  test("in a worktree of the repository", async () => {
    const ext = load();
    await ext.start(worktree);
    expect(ext.prompt(worktree)).toContain("- api (src/api/**/*.ts)");
  });

  test("outside the repository: only global rules", async () => {
    const ext = load();
    await ext.start(plain);
    const section = ext.prompt(plain);
    expect(section).toContain("ALWAYS");
    expect(section).not.toContain("api");
  });

  test("before session_start and without rules: no section", async () => {
    const ext = load();
    expect(ext.prompt()).toBeUndefined();
    const empty = load(join(root, "missing.json"));
    await empty.start();
    expect(empty.prompt()).toBeUndefined();
  });
});

describe("tool_result", () => {
  test("adds a path rule once", async () => {
    const ext = load();
    await ext.start();
    const first = await ext.result("read", { path: "src/api/users.ts" });
    expect(first?.content[0]).toEqual({ type: "text", text: "out" });
    expect(first?.content[1]?.text).toContain("apply to src/api/users.ts");
    expect(first?.content[1]?.text).toContain(`<repo_rule name="api" file="${join(rules, "api.md")}"`);
    expect(first).not.toHaveProperty("structuredContent");
    expect(await ext.result("edit", { path: join(repo, "src/api/orders.ts") })).toBeUndefined();
  });

  test("keeps structured content", async () => {
    const ext = load();
    await ext.start();
    const result = await ext.result("bash", { command: "cat src/api/a.ts" }, { structuredContent: { output: "x" } });
    expect(result?.structuredContent).toEqual({ output: "x" });
  });

  test("files that match no rule, or lie outside the repository", async () => {
    const ext = load();
    await ext.start();
    expect(await ext.result("read", { path: "src/web/a.ts" })).toBeUndefined();
    expect(await ext.result("read", { path: join(plain, "src/api/a.ts") })).toBeUndefined();
    expect(await ext.result("grep", { pattern: "x", path: "src/api/a.ts" })).toBeUndefined();
  });

  test("outside git, paths are relative to the working directory", async () => {
    const ext = load();
    await ext.start(plain);
    expect((await ext.result("write", { path: "notes/todo.md" }, {}, plain))?.content[1]?.text).toContain("DOCS");
  });

  test("before session_start: nothing", async () => {
    expect(await load().result("read", { path: "src/api/users.ts" })).toBeUndefined();
  });

  test("nested calls: the rule goes to the result of the call the model made", async () => {
    const ext = load();
    await ext.start();
    const nested = { toolCallId: "call-1/1", parentToolCallId: "call-1" };
    expect(await ext.result("read", { path: "src/api/a.ts" }, nested)).toBeUndefined();
    expect(await ext.result("read", { path: "README.md" }, { ...nested, toolCallId: "call-1/2" })).toBeUndefined();
    const parent = await ext.result("codemode", { code: "..." });
    expect(parent?.content[1]?.text).toContain('name="api"');
    expect(parent?.content[1]?.text).toContain('name="docs"');
    expect(await ext.result("codemode", { code: "..." })).toBeUndefined();
  });

  test("rules already in the context are not added again, until they leave it", async () => {
    const ext = load();
    await ext.start();
    const text = (await ext.result("read", { path: "src/api/a.ts" }))?.content[1]?.text as string;

    // Resuming the session: the rule is in a tool result of the transcript.
    const resumed = load();
    resumed.setEntries([
      { type: "compaction" },
      { type: "message", message: { role: "user", content: [{ type: "text", text }] } },
      { type: "message", message: { role: "toolResult", content: [{ type: "image" }, { type: "text", text }] } },
    ]);
    await resumed.start();
    expect(await resumed.result("read", { path: "src/api/b.ts" })).toBeUndefined();

    // After a compaction that summarized it away, the rule is added again.
    resumed.setEntries([]);
    resumed.emit("session_compact", {});
    expect((await resumed.result("read", { path: "src/api/b.ts" }))?.content[1]?.text).toContain('name="api"');
    resumed.emit("session_tree", {});
    expect((await resumed.result("read", { path: "src/api/c.ts" }))?.content[1]?.text).toContain('name="api"');
  });

  test("session_compact before session_start does nothing", async () => {
    const ext = load();
    expect(() => ext.emit("session_compact", {})).not.toThrow();
  });
});

describe("tool_call", () => {
  test("allowed: nothing matches, or allow makes an exception to ask", async () => {
    const ext = load();
    await ext.start();
    expect(await ext.call("bash", { command: "npm test" })).toBeUndefined();
    expect(await ext.call("bash", { command: "git push origin feat/x" })).toBeUndefined();
    expect(ext.select).not.toHaveBeenCalled();
  });

  test("denied", async () => {
    const ext = load();
    await ext.start();
    const result = await ext.call("bash", { command: "cat .env" });
    expect(result).toEqual({
      block: true,
      reason: `repo-rules: read: ${join(repo, ".env")} is denied by deny "read(.env)" (global).`,
    });
  });

  test("ask: allow once", async () => {
    const ext = load();
    await ext.start();
    ext.select.mockResolvedValueOnce("Allow");
    expect(await ext.call("bash", { command: "git push origin main" })).toBeUndefined();
    expect(ext.select).toHaveBeenCalledWith(
      'repo-rules: allow bash: git push origin main?\nask "bash(git push *)" (global)',
      ["Allow", "Allow for this session", "Deny"],
      undefined,
    );
    ext.select.mockResolvedValueOnce("Deny");
    expect(await ext.call("bash", { command: "git push origin main" })).toEqual({
      block: true,
      reason: 'repo-rules: the user did not allow bash: git push origin main (ask "bash(git push *)" (global)).',
    });
  });

  test("ask: allow for this session, for the same command only", async () => {
    const ext = load();
    await ext.start();
    const controller = new AbortController();
    ext.setSignal(controller.signal);
    ext.select.mockResolvedValueOnce("Allow for this session");
    expect(await ext.call("bash", { command: "git push origin main" })).toBeUndefined();
    expect(ext.select.mock.lastCall?.[2]).toEqual({ signal: controller.signal });
    expect(await ext.call("bash", { command: "git push origin main" })).toBeUndefined();
    expect(ext.select).toHaveBeenCalledTimes(1);
    ext.select.mockResolvedValueOnce(undefined);
    expect(await ext.call("bash", { command: "git push origin dev" })).toMatchObject({ block: true });
  });

  test("ask without a UI blocks", async () => {
    const ext = load();
    await ext.start();
    expect(await ext.call("bash", { command: "git push" }, false)).toEqual({
      block: true,
      reason: 'repo-rules: bash: git push needs approval (ask "bash(git push *)" (global)), and there is no UI to ask.',
    });
  });

  test("before session_start, or without permissions: nothing", async () => {
    expect(await load().call("bash", { command: "cat .env" })).toBeUndefined();
    const empty = load(join(root, "missing.json"));
    await empty.start();
    expect(await empty.call("bash", { command: "cat .env" })).toBeUndefined();
  });
});

describe("deliveredRules", () => {
  test("only tool results", async () => {
    expect(deliveredRules([])).toEqual(new Set());
  });
});

describe("/repo-rules", () => {
  test("in the repository", async () => {
    const ext = load();
    await ext.start();
    await ext.result("read", { path: "src/api/a.ts" });
    const text = await ext.command();
    expect(text).toContain(`config: ${configFile}`);
    expect(text).toContain(`main checkout: ${repo}`);
    expect(text).toContain("remote: github.com/owner/repo");
    expect(text).toContain("- global: applies");
    expect(text).toContain("- owner/repo: applies");
    expect(text).toContain("- someone/else: does not apply");
    expect(text).toContain("rule always (global): always");
    expect(text).toContain("rule api (owner/repo): src/api/**/*.ts, in context");
    expect(text).toContain("rule docs (global): *.md\n");
    expect(text).toContain("  deny read(.env) (global)");
    expect(text).toContain("  ask bash(git push *) (global)");
    expect(text).toContain("  allow bash(git push origin feat/*) (owner/repo)");
    expect(text).toContain("error: owner/repo: rule");
  });

  test("in a worktree", async () => {
    const text = await load().command(worktree);
    expect(text).toContain(`worktree: ${worktree}`);
  });

  test("outside git and without config", async () => {
    const text = await load(join(root, "missing.json")).command(plain);
    expect(text).toContain("not in a git repository");
    expect(text).toContain("no scopes configured");
  });
});

describe("default export", () => {
  test("registers the handlers and the command", async () => {
    const on = vi.fn();
    const registerCommand = vi.fn();
    repoRules({ on, registerCommand } as unknown as ExtensionAPI);
    expect(on.mock.calls.map(([name]) => name)).toEqual([
      "session_start",
      "session_shutdown",
      "session_compact",
      "session_tree",
      "before_agent_start",
      "tool_call",
      "tool_result",
      "agent_before_settle",
    ]);
    expect(registerCommand).toHaveBeenCalledWith("repo-rules", expect.any(Object));
  });
});

describe("hooks", () => {
  const dir = join(root, "hooked");
  const hooksConfig = join(root, "hooks.json");

  beforeAll(() => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      hooksConfig,
      JSON.stringify({
        global: {
          hooks: {
            session_start: [{ run: "echo STARTED" }, { run: "echo broken >&2; exit 1" }, { run: "true" }],
            before_agent_start: [{ run: "cat" }, { run: "true" }],
            tool_call: [
              { run: "echo no commits here >&2; exit 2", tools: ["bash"], command: ["git commit *"] },
              { run: "echo never", tools: ["bash"], command: ["git commit *"] },
            ],
            tool_result: [
              { run: 'echo "formatted $PI_FILE"', tools: ["edit", "write"], paths: ["**/*.ts"] },
              { run: "echo lint error >&2; exit 2", paths: ["src/bad.ts"] },
              { run: 'printf "%s" "$PI_COMMAND"', command: ["npm *"] },
            ],
            agent_before_settle: [{ run: 'test -f "$PI_ROOT/ok" || { echo not ok >&2; exit 2; }' }],
            session_shutdown: [{ run: 'touch "$PI_ROOT/shutdown"' }],
          },
        },
      }),
    );
  });

  const settle = (ext: ReturnType<typeof load>, outcome = "completed") =>
    ext.emit("agent_before_settle", { outcome, entries: [{ type: "custom", customType: "x" }] }, dir) as Promise<
      { entries: unknown[]; continue: boolean } | undefined
    >;
  const prompt = (ext: ReturnType<typeof load>, event: object = { messageType: "user", prompt: "hi" }) => {
    const full = { ...event, systemPromptOptions: { sections: {} as Record<string, string> } };
    return {
      result: ext.emit("before_agent_start", full, dir) as Promise<{ message: { content: string } } | undefined>,
      sections: full.systemPromptOptions.sections,
    };
  };

  test("session_start: output into the system prompt, failures to the user", async () => {
    const ext = load(hooksConfig);
    await ext.start(dir);
    expect(ext.notify).toHaveBeenCalledWith(expect.stringContaining("broken"), "warning");
    const { sections } = prompt(ext);
    expect(sections[PROMPT_SECTION]).toBe("Output of the session_start hooks of repo-rules:\n\nSTARTED");
  });

  test("before_agent_start: output as a hidden message, with the prompt on stdin", async () => {
    const ext = load(hooksConfig);
    await ext.start(dir);
    const { result } = prompt(ext);
    const message = (await result)?.message;
    expect(message).toMatchObject({ customType: "repo-rules", display: false });
    expect(JSON.parse(message?.content ?? "")).toEqual({
      event: "before_agent_start",
      cwd: dir,
      root: dir,
      prompt: "hi",
    });
    const custom = await prompt(ext, { messageType: "custom", message: {} }).result;
    expect(JSON.parse(custom?.message.content ?? "")).not.toHaveProperty("prompt");
  });

  test("before_agent_start without output: no message", async () => {
    const ext = load(configFile);
    await ext.start();
    expect(await prompt(ext).result).toBeUndefined();
    expect(await load(configFile).emit("before_agent_start", {})).toBeUndefined();
  });

  test("tool_call: exit code 2 blocks with stderr, and stops the other hooks", async () => {
    const ext = load(hooksConfig);
    await ext.start(dir);
    expect(await ext.call("bash", { command: "npm test && git commit -m x" }, true, dir)).toEqual({
      block: true,
      reason: 'repo-rules hook "echo no commits here >&2; exit 2": no commits here',
    });
    expect(await ext.call("bash", { command: "git status" }, true, dir)).toBeUndefined();
  });

  test("tool_result: output and problems are added", async () => {
    const ext = load(hooksConfig);
    await ext.start(dir);
    const edit = await ext.result("edit", { path: "src/a.ts" }, {}, dir);
    expect(edit?.content[1]?.text).toBe(
      `Output of the repo-rules hook "echo "formatted $PI_FILE"":\nformatted ${join(dir, "src/a.ts")}`,
    );
    const bad = await ext.result("write", { path: "src/bad.ts" }, {}, dir);
    expect(bad?.content[1]?.text).toContain(
      'The repo-rules hook "echo lint error >&2; exit 2" reports a problem:\nlint error',
    );
    const npm = await ext.result("bash", { command: "npm test" }, {}, dir);
    expect(npm?.content[1]?.text).toContain("npm test");
    expect(await ext.result("read", { path: "README.md" }, {}, dir)).toBeUndefined();
  });

  test("tool_result of a nested call: the output goes to the call the model made", async () => {
    const ext = load(hooksConfig);
    await ext.start(dir);
    const nested = { toolCallId: "call-1/1", parentToolCallId: "call-1" };
    expect(await ext.result("edit", { path: "src/a.ts" }, nested, dir)).toBeUndefined();
    expect((await ext.result("codemode", { code: "" }, {}, dir))?.content[1]?.text).toContain("formatted");
  });

  test("agent_before_settle: exit code 2 starts another round, at most three times", async () => {
    const ext = load(hooksConfig);
    await ext.start(dir);
    await prompt(ext).result;
    for (let round = 0; round < 3; round++) {
      const result = await settle(ext);
      expect(result?.continue).toBe(true);
      expect(result?.entries).toEqual([
        { type: "custom", customType: "x" },
        expect.objectContaining({ type: "custom_message", customType: "repo-rules", display: true }),
      ]);
      expect((result?.entries[1] as { content: string } | undefined)?.content).toContain('Hook "test -f');
    }
    expect(await settle(ext)).toBeUndefined();
    expect(ext.notify).toHaveBeenLastCalledWith(expect.stringContaining("after 3 extra rounds"), "warning");

    // A new prompt starts counting again.
    await prompt(ext).result;
    expect((await settle(ext))?.continue).toBe(true);
    // A custom message does not.
    await prompt(ext, { messageType: "custom", message: {} }).result;
    await settle(ext);
    await settle(ext);
    expect(await settle(ext)).toBeUndefined();
  });

  test("agent_before_settle: passing hooks, aborted runs, and no session", async () => {
    const ext = load(hooksConfig);
    expect(await settle(ext)).toBeUndefined();
    await ext.start(dir);
    expect(await settle(ext, "aborted")).toBeUndefined();
    writeFileSync(join(dir, "ok"), "");
    expect(await settle(ext)).toBeUndefined();
  });

  test("session_shutdown runs its hooks", async () => {
    const ext = load(hooksConfig);
    await ext.emit("session_shutdown", {}, dir);
    await ext.start(dir);
    await ext.emit("session_shutdown", {}, dir);
    expect(existsSync(join(dir, "shutdown"))).toBe(true);
  });

  test("/repo-rules lists the hooks", async () => {
    const text = await load(hooksConfig).command(dir);
    expect(text).toContain("  hook session_start: echo STARTED (global)");
    expect(text).toContain(
      '  hook tool_result [tools: edit, write; paths: **/*.ts]: echo "formatted $PI_FILE" (global)',
    );
    expect(text).toContain("  hook tool_call [tools: bash; command: git commit *]: echo never (global)");
  });
});
