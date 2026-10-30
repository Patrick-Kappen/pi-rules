import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  loadRule,
  parseRuleText,
  type Rule,
  renderedRuleFiles,
  renderPromptSection,
  renderRule,
  renderToolResultRules,
  ruleApplies,
  ruleName,
} from "./rules.ts";

describe("parseRuleText", () => {
  test("no front matter", () => {
    expect(parseRuleText("# Rule\n\n- a\n")).toEqual({ paths: [], body: "# Rule\n\n- a" });
  });

  test("block list", () => {
    const text =
      '---\ndescription: x\npaths:\n  - "src/**/*.{ts,tsx}"\n\n  # comment\n  - lib/**/*.ts\nother: 1\n---\n\nBody\n';
    expect(parseRuleText(text)).toEqual({ paths: ["src/**/*.{ts,tsx}", "lib/**/*.ts"], body: "Body" });
  });

  test("inline list with commas in braces and quotes", () => {
    const text = "---\npaths: [\"src/**/*.{ts,tsx}\", 'a,b.md', docs/**]\n---\nBody";
    expect(parseRuleText(text).paths).toEqual(["src/**/*.{ts,tsx}", "a,b.md", "docs/**"]);
  });

  test("a single value", () => {
    expect(parseRuleText("---\npaths: '*.md'\n---\nBody").paths).toEqual(["*.md"]);
    expect(parseRuleText('---\npaths: ""\n---\nBody').paths).toEqual([]);
  });

  test("front matter without paths", () => {
    expect(parseRuleText("---\ndescription: x\n---\nBody")).toEqual({ paths: [], body: "Body" });
  });

  test("empty block list items are skipped", () => {
    expect(parseRuleText("---\npaths:\n  - ''\n  - a\n---\n").paths).toEqual(["a"]);
  });

  test("CRLF", () => {
    expect(parseRuleText("---\r\npaths:\r\n  - a\r\n---\r\nBody\r\n")).toEqual({ paths: ["a"], body: "Body" });
  });
});

describe("ruleName", () => {
  test.each([
    ["/rules/api.md", "api"],
    ["/nix/store/0123456789abcdefghijklmnopqrstuv-api.md", "api"],
    ["/rules/API.MD", "API"],
    ["/rules/notes.txt", "notes.txt"],
  ])("%s", (file, name) => {
    expect(ruleName(file)).toBe(name);
  });
});

describe("loadRule", () => {
  const dir = mkdtempSync(join(tmpdir(), "repo-rules-rules-"));

  test("a rule file", () => {
    const file = join(dir, "api.md");
    writeFileSync(file, "---\npaths: [src/api/**]\n---\n- validate input\n");
    const rule = loadRule(file, "owner/repo") as Rule;
    expect(rule).toMatchObject({
      name: "api",
      file,
      scope: "owner/repo",
      paths: ["src/api/**"],
      body: "- validate input",
    });
    expect(ruleApplies(rule, "src/api/users.ts")).toBe(true);
    expect(ruleApplies(rule, "src/web/users.ts")).toBe(false);
  });

  test("a missing file", () => {
    expect(loadRule(join(dir, "missing.md"), "global")).toBe(`global: rule ${join(dir, "missing.md")}: ENOENT`);
  });

  test("a rule without paths applies to no single file", () => {
    const file = join(dir, "always.md");
    writeFileSync(file, "always");
    expect(ruleApplies(loadRule(file, "global") as Rule, "a.ts")).toBe(false);
  });
});

function rule(name: string, paths: string[] = [], file = `/rules/${name}.md`): Rule {
  return { name, file, scope: "global", paths, matchers: [], body: `${name} body` };
}

describe("rendering", () => {
  test("renderRule escapes attributes", () => {
    expect(renderRule(rule("a", ["src/**"], '/r/a"&<.md'))).toBe(
      '<repo_rule name="a" file="/r/a&quot;&amp;&lt;.md" paths="src/**">\na body\n</repo_rule>',
    );
  });

  test("renderedRuleFiles finds the files again", () => {
    const text = renderToolResultRules([rule("a", ["x"], '/r/a"&<.md'), rule("b", ["y"])], ["src/a.ts"]);
    expect(text).toContain("apply to src/a.ts");
    expect(renderedRuleFiles(`before\n${text}`)).toEqual(['/r/a"&<.md', "/rules/b.md"]);
    expect(renderedRuleFiles("nothing")).toEqual([]);
  });

  test("renderToolResultRules without files", () => {
    expect(renderToolResultRules([rule("a", ["x"])], [])).toMatch(/^These repository rules apply\. Follow them\./);
  });

  test("renderPromptSection", () => {
    expect(renderPromptSection([])).toBeUndefined();
    const both = renderPromptSection([rule("always"), rule("api", ["src/api/**", "*.sql"])]) as string;
    expect(both).toContain("always body");
    expect(both).not.toContain("api body");
    expect(both).toContain("- api (src/api/**, *.sql): /rules/api.md");
    expect(renderPromptSection([rule("always")])).not.toContain("some files only");
    expect(renderPromptSection([rule("api", ["x"])])).not.toContain("apply to this repository");
  });
});
