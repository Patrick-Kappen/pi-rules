// Runs pi's own session with a scripted model: the extension loads from the agent directory, puts the
// global rule in the system prompt, and adds a path rule to the first tool result that reads a matching file.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getSystemMessageText } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const source = resolve(import.meta.dirname, "../../extensions/repo-rules");
const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-rules-it-")));
const agentDir = join(root, "agent");
const repo = join(root, "repo");
const rules = join(root, "rules");
const savedEnv = { ...process.env };

function git(cwd: string, ...args: string[]): void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env, stdio: "ignore" });
}

beforeAll(() => {
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  cpSync(source, join(agentDir, "extensions", "repo-rules"), {
    recursive: true,
    filter: (path) => !path.endsWith(".test.ts"),
  });
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, "everywhere.md"), "# Everywhere\n\n- GLOBAL-RULE-TEXT\n");
  writeFileSync(join(rules, "api.md"), '---\npaths:\n  - "src/api/**/*.ts"\n---\n\n- API-RULE-TEXT\n');
  writeFileSync(join(rules, "elsewhere.md"), "- OTHER-REPO-TEXT\n");
  writeFileSync(
    join(agentDir, "repo-rules.json"),
    JSON.stringify({
      global: { rules: [join(rules, "everywhere.md")] },
      repos: {
        "example-owner/example-repo": { rules: [join(rules, "api.md")] },
        "someone/else": { rules: [join(rules, "elsewhere.md")] },
      },
    }),
  );

  mkdirSync(join(repo, "src", "api"), { recursive: true });
  writeFileSync(join(repo, "src", "api", "users.ts"), "export const users = [];\n");
  writeFileSync(join(repo, "src", "api", "orders.ts"), "export const orders = [];\n");
  git(repo, "init");
  git(repo, "remote", "add", "origin", "git@github.com:Example-Owner/example-repo.git");

  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.PI_REPO_RULES_CONFIG;
});

afterAll(() => {
  process.env = savedEnv;
  rmSync(root, { recursive: true, force: true });
});

function text(message: unknown): string {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content.map((block: { type: string; text?: string }) => (block.type === "text" ? block.text : "")).join("\n");
}

describe("pi applies repo-rules", () => {
  test("global rule in the system prompt, path rule once in the first matching tool result", async () => {
    const faux = fauxProvider();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "src/api/users.ts" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("bash", { command: "cat src/api/orders.ts" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);

    const resourceLoader = new DefaultResourceLoader({ cwd: repo, agentDir });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: repo,
      agentDir,
      model: faux.getModel(),
      modelRuntime,
      resourceLoader,
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(repo),
    });
    try {
      await session.bindExtensions({});
      await session.prompt("read the api");

      // The system prompt the model got: the system messages of the transcript.
      const system = session.messages
        .filter((message) => message.role === "system")
        .map((message) => getSystemMessageText(message))
        .join("\n");
      expect(system).toContain("<repo_rules>");
      expect(system).toContain("GLOBAL-RULE-TEXT");
      expect(system).toContain("- api (src/api/**/*.ts)");
      expect(system).not.toContain("API-RULE-TEXT");
      expect(system).not.toContain("OTHER-REPO-TEXT");

      const results = session.messages.filter((message) => message.role === "toolResult").map(text);
      expect(results).toHaveLength(2);
      expect(results[0]).toContain("export const users");
      expect(results[0]).toContain("API-RULE-TEXT");
      expect(results[1]).toContain("export const orders");
      expect(results[1]).not.toContain("API-RULE-TEXT");
    } finally {
      session.dispose();
    }
  });
});
