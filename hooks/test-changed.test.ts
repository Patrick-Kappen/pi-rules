// Runs hooks/test-changed.sh with a fake `just` and checks what it blocks, runs and reports.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const hook = resolve(import.meta.dirname, "test-changed.sh");
const roots: string[] = [];
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A repository with test files, and a fake `just` that lists `recipes` and logs what it runs. */
function setup(recipes: string, exitCode = 0, output = "Passed 3 Failed 0 Skipped 0 in 1.0s (2 files)") {
  const root = mkdtempSync(join(tmpdir(), "test-changed-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(join(repo, "tests/unit"), { recursive: true });
  writeFileSync(join(repo, "tests/unit/test_a.py"), "");
  writeFileSync(join(repo, "notes.py"), "");
  execFileSync("git", ["init", "-q", repo], { env: cleanEnv });
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "just"),
    [
      "#!/bin/sh",
      `if [ "$1" = --summary ]; then echo "${recipes}"; exit 0; fi`,
      `echo "$PWD $*" >> "${join(root, "ran.log")}"`,
      `printf '\\033[32mline\\033[0m\\n\\n${output}\\n'`,
      `exit ${exitCode}`,
    ].join("\n"),
  );
  chmodSync(join(bin, "just"), 0o755);
  return { root, repo, bin, ran: () => readFileSync(join(root, "ran.log"), "utf8").trim() };
}

function hookRun(command: string, cwd: string, bin: string, event = "tool_call", extra: Record<string, string> = {}) {
  const result = spawnSync(hook, [], {
    cwd,
    encoding: "utf8",
    env: { ...cleanEnv, PATH: `${bin}:${cleanEnv.PATH}`, PI_EVENT: event, PI_CWD: cwd, PI_COMMAND: command, ...extra },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("test-changed.sh on tool_call", () => {
  test("a direct test run is blocked and test-changed runs instead, with one sentence", () => {
    const { repo, bin, ran } = setup("lint test test-changed test-serial");
    const out = hookRun("uv run pytest -q", repo, bin);
    expect(out.status).toBe(2);
    expect(out.stderr.trim()).toBe(
      "Blocked `pytest -q` and ran `just test-changed` instead (use the recipes for tests): Passed 3 Failed 0 Skipped 0 in 1.0s (2 files)",
    );
    expect(ran()).toBe(`${repo} test-changed`);
  });

  test("named test files and folders run with just test", () => {
    const { repo, bin, ran } = setup("test test-changed");
    const out = hookRun("pytest tests/unit './tests/unit/test_a.py::test_x' -k fast notes.py .", repo, bin);
    expect(out.status).toBe(2);
    expect(ran()).toBe(`${repo} test tests/unit tests/unit/test_a.py`);
    expect(out.stderr).toContain("ran `just test tests/unit tests/unit/test_a.py` instead");
  });

  test("named tests go to test-changed when there is no test recipe", () => {
    const { repo, bin, ran } = setup("test-changed");
    hookRun("pytest tests/unit/test_a.py", repo, bin);
    expect(ran()).toBe(`${repo} test-changed tests/unit/test_a.py`);
  });

  test("follows cd, strips wrappers, and finds the test part of a chain", () => {
    const { root, repo, bin, ran } = setup("test-changed");
    const out = hookRun(`cd ${repo} && git status; TERM=dumb timeout 600 devenv shell -- npx vitest run`, root, bin);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("Blocked `vitest run`");
    expect(ran()).toBe(`${repo} test-changed`);
  });

  test("a failure shows the output without colours and blank lines", () => {
    const { repo, bin } = setup("test-changed", 1, "[-] a :: fails\\nPassed 1 Failed 1");
    const out = hookRun("pwsh -NoProfile -Command 'Invoke-Pester'", repo, bin);
    expect(out.status).toBe(2);
    expect(out.stderr.split("\n")).toEqual([
      "Blocked `pwsh -NoProfile -Command 'Invoke-Pester'` and ran `just test-changed` instead (use the recipes for tests); it failed:",
      "line",
      "[-] a :: fails",
      "Passed 1 Failed 1",
      "",
    ]);
  });

  test("a recipe that runs too long is reported", () => {
    const { repo, bin } = setup("test-changed");
    writeFileSync(join(bin, "just"), '#!/bin/sh\n[ "$1" = --summary ] && { echo test-changed; exit 0; }\nsleep 5\n');
    const out = hookRun("bun test", repo, bin, "tool_call", { TEST_CHANGED_TIMEOUT: "0.2" });
    expect(out.status).toBe(2);
    expect(out.stderr).toContain("which did not finish in 0.2s");
  });

  test("other commands, recipes, help and repositories without the recipe pass", () => {
    const { repo, bin } = setup("test test-changed");
    for (const command of [
      "git status && echo pytest",
      "just test",
      "devenv shell -- tests",
      "pytest --help",
      "pwsh -c Get-Date",
    ]) {
      expect(hookRun(command, repo, bin).status, command).toBe(0);
    }
    const none = setup("lint");
    expect(hookRun("pytest", none.repo, none.bin).status).toBe(0);
    expect(hookRun("", repo, bin).status).toBe(0);
  });
});

describe("test-changed.sh on tool_result", () => {
  test("without the recipe: one sentence about the test-speed skill", () => {
    const { repo, bin } = setup("lint");
    const out = hookRun("go test ./...", repo, bin, "tool_result");
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe(
      "This repository has no `just test-changed` recipe; the test-speed skill sets up fast test recipes.",
    );
  });

  test("with the recipe, or for another command: nothing", () => {
    const { repo, bin } = setup("test-changed");
    expect(hookRun("cargo test", repo, bin, "tool_result").stdout).toBe("");
    expect(hookRun("ls", repo, bin, "tool_result").stdout).toBe("");
  });
});
