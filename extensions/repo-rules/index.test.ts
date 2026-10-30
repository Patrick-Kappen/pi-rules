import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
      global: { rules: [join(rules, "always.md"), join(rules, "docs.md")] },
      repos: {
        "owner/repo": { rules: [join(rules, "api.md"), join(rules, "docs.md"), join(rules, "missing.md")] },
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
  let entries: Entry[] = [];
  const ctx = (cwd: string, hasUI = true) => ({
    cwd,
    hasUI,
    ui: { notify },
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
      ) as { content: Array<{ type: string; text: string }>; structuredContent?: unknown } | undefined,
    command: async (cwd = repo) => {
      await command?.("", ctx(cwd));
      return notify.mock.lastCall?.[0] as string;
    },
    notify,
  };
}

describe("session_start", () => {
  test("reports errors with a UI", () => {
    const ext = load();
    ext.start();
    expect(ext.notify).toHaveBeenCalledWith(expect.stringContaining("missing.md: ENOENT"), "warning");
  });

  test("no report without a UI or without errors", () => {
    const ext = load();
    ext.start(repo, false);
    ext.start(plain);
    expect(ext.notify).not.toHaveBeenCalled();
  });
});

describe("before_agent_start", () => {
  test("in the repository: global and repo rules", () => {
    const ext = load();
    ext.start();
    const section = ext.prompt();
    expect(section).toContain("ALWAYS");
    expect(section).toContain("- api (src/api/**/*.ts)");
    expect(section).toContain("- docs (*.md)");
    expect(section).not.toContain("OTHER");
  });

  test("in a worktree of the repository", () => {
    const ext = load();
    ext.start(worktree);
    expect(ext.prompt(worktree)).toContain("- api (src/api/**/*.ts)");
  });

  test("outside the repository: only global rules", () => {
    const ext = load();
    ext.start(plain);
    const section = ext.prompt(plain);
    expect(section).toContain("ALWAYS");
    expect(section).not.toContain("api");
  });

  test("before session_start and without rules: no section", () => {
    const ext = load();
    expect(ext.prompt()).toBeUndefined();
    const empty = load(join(root, "missing.json"));
    empty.start();
    expect(empty.prompt()).toBeUndefined();
  });
});

describe("tool_result", () => {
  test("adds a path rule once", () => {
    const ext = load();
    ext.start();
    const first = ext.result("read", { path: "src/api/users.ts" });
    expect(first?.content[0]).toEqual({ type: "text", text: "out" });
    expect(first?.content[1]?.text).toContain("apply to src/api/users.ts");
    expect(first?.content[1]?.text).toContain(`<repo_rule name="api" file="${join(rules, "api.md")}"`);
    expect(first).not.toHaveProperty("structuredContent");
    expect(ext.result("edit", { path: join(repo, "src/api/orders.ts") })).toBeUndefined();
  });

  test("keeps structured content", () => {
    const ext = load();
    ext.start();
    const result = ext.result("bash", { command: "cat src/api/a.ts" }, { structuredContent: { output: "x" } });
    expect(result?.structuredContent).toEqual({ output: "x" });
  });

  test("files that match no rule, or lie outside the repository", () => {
    const ext = load();
    ext.start();
    expect(ext.result("read", { path: "src/web/a.ts" })).toBeUndefined();
    expect(ext.result("read", { path: join(plain, "src/api/a.ts") })).toBeUndefined();
    expect(ext.result("grep", { pattern: "x", path: "src/api/a.ts" })).toBeUndefined();
  });

  test("outside git, paths are relative to the working directory", () => {
    const ext = load();
    ext.start(plain);
    expect(ext.result("write", { path: "notes/todo.md" }, {}, plain)?.content[1]?.text).toContain("DOCS");
  });

  test("before session_start: nothing", () => {
    expect(load().result("read", { path: "src/api/users.ts" })).toBeUndefined();
  });

  test("nested calls: the rule goes to the result of the call the model made", () => {
    const ext = load();
    ext.start();
    const nested = { toolCallId: "call-1/1", parentToolCallId: "call-1" };
    expect(ext.result("read", { path: "src/api/a.ts" }, nested)).toBeUndefined();
    expect(ext.result("read", { path: "README.md" }, { ...nested, toolCallId: "call-1/2" })).toBeUndefined();
    const parent = ext.result("codemode", { code: "..." });
    expect(parent?.content[1]?.text).toContain('name="api"');
    expect(parent?.content[1]?.text).toContain('name="docs"');
    expect(ext.result("codemode", { code: "..." })).toBeUndefined();
  });

  test("rules already in the context are not added again, until they leave it", () => {
    const ext = load();
    ext.start();
    const text = ext.result("read", { path: "src/api/a.ts" })?.content[1]?.text as string;

    // Resuming the session: the rule is in a tool result of the transcript.
    const resumed = load();
    resumed.setEntries([
      { type: "compaction" },
      { type: "message", message: { role: "user", content: [{ type: "text", text }] } },
      { type: "message", message: { role: "toolResult", content: [{ type: "image" }, { type: "text", text }] } },
    ]);
    resumed.start();
    expect(resumed.result("read", { path: "src/api/b.ts" })).toBeUndefined();

    // After a compaction that summarized it away, the rule is added again.
    resumed.setEntries([]);
    resumed.emit("session_compact", {});
    expect(resumed.result("read", { path: "src/api/b.ts" })?.content[1]?.text).toContain('name="api"');
    resumed.emit("session_tree", {});
    expect(resumed.result("read", { path: "src/api/c.ts" })?.content[1]?.text).toContain('name="api"');
  });

  test("session_compact before session_start does nothing", () => {
    const ext = load();
    expect(() => ext.emit("session_compact", {})).not.toThrow();
  });
});

describe("deliveredRules", () => {
  test("only tool results", () => {
    expect(deliveredRules([])).toEqual(new Set());
  });
});

describe("/repo-rules", () => {
  test("in the repository", async () => {
    const ext = load();
    ext.start();
    ext.result("read", { path: "src/api/a.ts" });
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
  test("registers the handlers and the command", () => {
    const on = vi.fn();
    const registerCommand = vi.fn();
    repoRules({ on, registerCommand } as unknown as ExtensionAPI);
    expect(on.mock.calls.map(([name]) => name)).toEqual([
      "session_start",
      "session_compact",
      "session_tree",
      "before_agent_start",
      "tool_result",
    ]);
    expect(registerCommand).toHaveBeenCalledWith("repo-rules", expect.any(Object));
  });
});
