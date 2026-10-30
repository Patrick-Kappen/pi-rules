import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fileReadByCommand, filesOfCall, realpathLoose, relativeTo, resolvePath, shellWords } from "./files.ts";

describe("shellWords", () => {
  test.each([
    ["cat a.ts", ["cat", "a.ts"]],
    ["  cat\t 'a b.ts'  ", ["cat", "a b.ts"]],
    ['cat "a \\"b\\".ts"', ["cat", 'a "b".ts']],
    ["cat a\\ b.ts", ["cat", "a b.ts"]],
    ["cat pre'fix'\"ed\"", ["cat", "prefixed"]],
    ["cat ''", ["cat", ""]],
    ["", []],
  ])("%s", (command, words) => {
    expect(shellWords(command)).toEqual(words);
  });

  test.each([
    ["cat a | head"],
    ["cat a; rm b"],
    ["cat a && b"],
    ["cat a > b"],
    ["cat $(x)"],
    ['cat "$HOME/a"'],
    ["cat `x`"],
    ["cat *.ts"],
    ["cat a\nb"],
    ["cat 'open"],
    ["cat {a,b}"],
  ])("not a simple command: %s", (command) => {
    expect(shellWords(command)).toBeUndefined();
  });
});

describe("fileReadByCommand", () => {
  test.each([
    ["cat src/a.ts", "src/a.ts"],
    ["/usr/bin/cat src/a.ts", "src/a.ts"],
    ["head -n 20 src/a.ts", "src/a.ts"],
    ["head -20 src/a.ts", "src/a.ts"],
    ["tail --lines 5 -- -odd-name", "-odd-name"],
    ["bat -l ts --style plain src/a.ts", "src/a.ts"],
    ["nl -b a src/a.ts", "src/a.ts"],
    ["less 'my file.md'", "my file.md"],
    ["sed -n '1,20p' src/a.ts", "src/a.ts"],
    ["sed -E -n 5p src/a.ts", "src/a.ts"],
  ])("%s reads %s", (command, file) => {
    expect(fileReadByCommand(command)).toBe(file);
  });

  test.each([
    ["cat"],
    ["cat a b"],
    ["cat -"],
    ["head -n 5"],
    ["grep x a.ts"],
    ["sed 's/a/b/' a.ts"],
    ["sed -i -n 1p a.ts"],
    ["sed -n -e 1p a.ts"],
    ["cat a.ts | head"],
  ])("not a single-file read: %s", (command) => {
    expect(fileReadByCommand(command)).toBeUndefined();
  });
});

describe("filesOfCall", () => {
  test("file tools", () => {
    expect(filesOfCall("read", { path: "a.ts" })).toEqual(["a.ts"]);
    expect(filesOfCall("edit", { path: "/abs/a.ts", edits: [] })).toEqual(["/abs/a.ts"]);
    expect(filesOfCall("write", { path: "new.ts", content: "" })).toEqual(["new.ts"]);
    expect(filesOfCall("read", { path: "" })).toEqual([]);
    expect(filesOfCall("read", {})).toEqual([]);
  });

  test("bash", () => {
    expect(filesOfCall("bash", { command: "cat a.ts" })).toEqual(["a.ts"]);
    expect(filesOfCall("bash", { command: "ls" })).toEqual([]);
    expect(filesOfCall("bash", {})).toEqual([]);
  });

  test("other tools", () => {
    expect(filesOfCall("grep", { pattern: "x", path: "a.ts" })).toEqual([]);
    expect(filesOfCall("mcp__x__read", { path: "a.ts" })).toEqual([]);
  });
});

describe("resolvePath", () => {
  test.each([
    ["a.ts", "/repo/a.ts"],
    ["./src/../a.ts", "/repo/a.ts"],
    ["/abs/a.ts", "/abs/a.ts"],
    ["~", "/home/u"],
    ["~/a.ts", "/home/u/a.ts"],
    ["@src/a.ts", "/repo/src/a.ts"],
  ])("%s", (path, expected) => {
    expect(resolvePath(path, "/repo", "/home/u")).toBe(expected);
  });
});

describe("relativeTo", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "repo-rules-files-")));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "");
  symlinkSync(repo, join(root, "link"));

  test("inside the root", () => {
    expect(relativeTo(repo, join(repo, "src", "a.ts"))).toBe("src/a.ts");
  });

  test("a file that does not exist yet", () => {
    expect(relativeTo(repo, join(repo, "src", "new", "b.ts"))).toBe("src/new/b.ts");
  });

  test("through a symlink to the root", () => {
    expect(relativeTo(repo, join(root, "link", "src", "a.ts"))).toBe("src/a.ts");
    expect(relativeTo(join(root, "link"), join(repo, "src", "a.ts"))).toBe("src/a.ts");
  });

  test("outside the root", () => {
    expect(relativeTo(repo, join(root, "other.ts"))).toBeUndefined();
    expect(relativeTo(repo, repo)).toBeUndefined();
    expect(relativeTo(join(repo, "src"), join(repo, "..x"))).toBeUndefined();
  });

  test("a name that starts with two dots is inside", () => {
    expect(relativeTo(repo, join(repo, "..config"))).toBe("..config");
  });

  test("realpathLoose of a path that does not exist at all", () => {
    expect(realpathLoose("/does-not-exist-repo-rules/a")).toBe("/does-not-exist-repo-rules/a");
  });
});
