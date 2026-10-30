import { describe, expect, test } from "vitest";
import { globToRegExp, matchesAny } from "./glob.ts";

function matches(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

describe("globToRegExp", () => {
  test.each([
    ["src/api/**/*.ts", "src/api/users.ts"],
    ["src/api/**/*.ts", "src/api/v1/deep/users.ts"],
    ["src/**/*.{ts,tsx}", "src/ui/button.tsx"],
    ["src/**/*.{ts,tsx}", "src/index.ts"],
    ["tests/**/*.test.ts", "tests/unit/a.test.ts"],
    ["*.md", "README.md"],
    ["*.md", "docs/deep/guide.md"],
    ["src/*.ts", "src/index.ts"],
    ["/flake.nix", "flake.nix"],
    ["./flake.nix", "flake.nix"],
    ["docs/", "docs/a/b.md"],
    ["src/**", "src/a/b/c.ts"],
    ["**", "anything/at/all"],
    ["file?.txt", "file1.txt"],
    ["[abc].ts", "b.ts"],
    ["[a-c].ts", "c.ts"],
    ["[!abc].ts", "d.ts"],
    ["{src,lib}/{**/,}*.{ts,js}", "lib/a/b.js"],
    ["{src,lib}/{**/,}*.{ts,js}", "src/index.ts"],
    ["a+b(c).ts", "a+b(c).ts"],
    [".env", ".env"],
    ["secrets/**", "secrets/prod/key.pem"],
  ])("%s matches %s", (pattern, path) => {
    expect(matches(pattern, path)).toBe(true);
  });

  test.each([
    ["src/api/**/*.ts", "src/web/users.ts"],
    ["src/api/**/*.ts", "src/api/users.js"],
    ["src/*.ts", "src/deep/index.ts"],
    ["/flake.nix", "sub/flake.nix"],
    ["./flake.nix", "sub/flake.nix"],
    ["file?.txt", "file10.txt"],
    ["[abc].ts", "d.ts"],
    ["[!abc].ts", "a.ts"],
    ["*.md", "README.mdx"],
    ["a.b", "axb"],
    ["src/**/*.{ts,tsx}", "src/index.js"],
    ["secrets/**", "secrets"],
  ])("%s does not match %s", (pattern, path) => {
    expect(matches(pattern, path)).toBe(false);
  });

  test("unclosed brackets and braces are literal", () => {
    expect(matches("a[b", "a[b")).toBe(true);
    expect(matches("a{b", "a{b")).toBe(true);
    expect(matches("a{b", "ab")).toBe(false);
  });

  test("** inside a segment matches across segments", () => {
    expect(matches("src/a**.ts", "src/a/b/c.ts")).toBe(true);
  });
});

describe("matchesAny", () => {
  test("any pattern", () => {
    const patterns = ["*.ts", "docs/**"].map(globToRegExp);
    expect(matchesAny(patterns, "a/b.ts")).toBe(true);
    expect(matchesAny(patterns, "docs/x.md")).toBe(true);
    expect(matchesAny(patterns, "x.md")).toBe(false);
    expect(matchesAny([], "x.md")).toBe(false);
  });
});
