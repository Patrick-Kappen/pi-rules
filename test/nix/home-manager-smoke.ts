// Run by the `home-manager` flake check with node: the files Home Manager generates must work together.
// Usage: node home-manager-smoke.ts <home-files> <agent-dir>
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { createRepoRules as CreateRepoRules, RepoRulesApi } from "../../extensions/repo-rules/index.ts";

const [homeFiles, agentDir] = process.argv.slice(2);
if (!homeFiles || !agentDir) throw new Error("usage: home-manager-smoke.ts <home-files> <agent-dir>");

const extension = join(homeFiles, agentDir, "extensions", "repo-rules", "index.ts");
const config = join(homeFiles, agentDir, "repo-rules.json");
const { createRepoRules }: { createRepoRules: typeof CreateRepoRules } = await import(extension);

function repo(remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hm-smoke-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", remote]);
  return dir;
}

type Handler = (event: unknown, ctx: unknown) => unknown;

/** The system prompt section and the text added to a read of src/api/users.ts. */
function rulesIn(cwd: string): { section: string; added: string } {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: () => {},
  } as unknown as RepoRulesApi;
  createRepoRules(pi, { env: { PI_REPO_RULES_CONFIG: config }, home: tmpdir() });
  const ctx = { cwd, hasUI: false, sessionManager: { buildContextEntries: () => [] } };
  handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  const start = { type: "before_agent_start", systemPromptOptions: { sections: {} as Record<string, string> } };
  handlers.get("before_agent_start")?.(start, ctx);
  const result = handlers.get("tool_result")?.(
    { type: "tool_result", toolCallId: "1", toolName: "read", input: { path: "src/api/users.ts" }, content: [] },
    ctx,
  ) as { content: Array<{ text: string }> } | undefined;
  return { section: start.systemPromptOptions.sections.repo_rules ?? "", added: result?.content[0]?.text ?? "" };
}

const cases: Array<[string, boolean]> = [
  ["git@github.com:Patrick-Kappen/nixos-config.git", true],
  ["https://github.com/someone/else", false],
];
for (const [remote, inScope] of cases) {
  const { section, added } = rulesIn(repo(remote));
  if (!section.includes("Conventional Commits")) throw new Error(`${remote}: no global rule in ${section}`);
  if (added.includes("API-RULE-TEXT") !== inScope) throw new Error(`${remote}: unexpected tool result: ${added}`);
  process.stdout.write(`ok ${remote}\n`);
}
