# pi-rules

pi extension that applies rules per repository: instructions, permissions and hooks.

pi has no rules of its own beyond `AGENTS.md` files, and those live in the repositories. The
[`repo-rules`](extensions/repo-rules/README.md) extension applies rules that you configure in one
place, per repository or everywhere, without files in the repositories. It works like `repo-skills`
in [pi-skills](https://github.com/Patrick-Kappen/pi-skills) and `repo-mcp` in
[pi-mcp-servers](https://github.com/Patrick-Kappen/pi-mcp-servers).

- **Rules**: Markdown instructions. A rule without `paths` goes into the system prompt; a rule with
  `paths` globs is added when pi reads or changes a matching file, like the path-specific rules of
  Claude Code.
- **Permissions**: `deny`, `ask` and `allow` rules for tool calls, such as `read(.env)` or
  `bash(git push *)`. Everything else is allowed.
- **Hooks**: your commands on pi's events, such as formatting a file after an edit, blocking
  `git commit`, or running the checks before the model finishes.

| Rule | What it says |
|---|---|
| [`conventional-commits`](rules/conventional-commits.md) | Commit messages, branches and PR titles |

| Hook | What it does |
|---|---|
| [`test-changed`](hooks/test-changed.sh) | Blocks a direct test run (`pytest`, `vitest`, `Invoke-Pester`, ...) where a `test-changed` recipe exists, and runs the recipe instead |

## Use with Home Manager

```nix
{
  inputs.pi-rules = {
    url = "github:Patrick-Kappen/pi-rules/v1.0.0"; # a release tag, or the `latest` branch
    inputs.nixpkgs.follows = "nixpkgs";
    inputs.home-manager.follows = "home-manager";
  };
}
```

```nix
{ inputs, ... }:
{
  imports = [ inputs.pi-rules.homeModules.default ];

  programs.pi-rules = {
    enable = true;

    # Everywhere, also outside git repositories.
    global = {
      rules = [ "conventional-commits" ];
      permissions = {
        deny = [ "read(.env)" "read(secrets/**)" "read(~/.ssh/**)" "edit(@main)" ];   # edit(@main): only in worktrees
        ask = [ "bash(git push *)" ];
      };
    };

    # Per repository, on top of global.
    repos."my-org/infra".rules = [ ./rules/terraform.md ];   # a rule from your own configuration
    repos."my-org/*".rules = [ "conventional-commits" ];     # every repository of an owner
    repos."my-org/*".permissions.allow = [ "bash(git push origin feat/*)" ];   # no question for these

    # Hooks on pi's events.
    repos."~/src/project".hooks = {
      tool_result = [ { run = ''biome format --write "$PI_FILE"''; tools = [ "edit" "write" ]; paths = [ "**/*.ts" ]; } ];
      tool_call = [ { run = "echo 'Commit yourself.' >&2; exit 2"; tools = [ "bash" ]; command = [ "git commit *" ]; } ];
      agent_before_settle = [ { run = "check >&2 || exit 2"; timeout = 600; } ];
    };
    repos."~/src/project".rules = [ "~/rules/project.md" ];  # a directory; a file outside the store
  };
}
```

The module installs the extension in `~/.pi/agent/extensions/repo-rules` and writes
`~/.pi/agent/repo-rules.json`.

| Option | Default | Meaning |
|---|---|---|
| `global.rules` | `[ ]` | Rules that apply everywhere. |
| `global.permissions.{deny,ask,allow}` | `[ ]` | Permission rules that apply everywhere. See the [extension README](extensions/repo-rules/README.md#permissions). |
| `repos.<pattern>.rules` | `[ ]` | Rules for the repositories that match: `owner/repo`, `host/owner/repo`, `owner/*`, a path such as `~/src/project`, or `*`. See the [extension README](extensions/repo-rules/README.md#repos-patterns). |
| `repos.<pattern>.permissions.{deny,ask,allow}` | `[ ]` | Permission rules for those repositories, on top of `global`. |
| `global.hooks.<event>`, `repos.<pattern>.hooks.<event>` | `[ ]` | Hooks: `{ run; tools; paths; command; timeout; }` on `session_start`, `before_agent_start`, `tool_call`, `tool_result`, `agent_before_settle` or `session_shutdown`. See the [extension README](extensions/repo-rules/README.md#hooks). |
| `package` | `packages.<system>.repo-rules` | The extension. |
| `rulesPackage` | `packages.<system>.rules` | The rules of this flake. |
| `testChanged.enable` | `false` | The [test-changed hook](#the-test-changed-hook) everywhere. |
| `testChanged.timeout` | `900` | Seconds the test-changed hook may run; the recipe gets 30 seconds less. |
| `hooksPackage` | `packages.<system>.hooks` | The hook scripts of this flake. |
| `agentDir` | `.pi/agent` | pi's agent directory relative to home. |

A rule entry is the name of a rule of this flake, a Nix path (copied to the store), or an absolute
path or `~/path` (read as it is, so you can change it without a rebuild).

In pi, `/repo-rules` shows which scopes, rules, permissions and hooks apply to the current
repository. After changing
the configuration or a rule, run `/reload` in pi.

## The test-changed hook

`programs.pi-rules.testChanged.enable = true;` makes test runs go through the repository's recipes,
so an agent runs the tests that cover its change, and reads one line instead of a long log.

- A bash call that runs a test tool directly (`pytest`, `python -m pytest`, `vitest`, `jest`,
  `bun test`, `Invoke-Pester` or `pwsh ... Invoke-Pester`, `go test`, `cargo test`, `dotnet test`,
  `npm test`; also behind `cd <dir> &&`, `timeout`, `npx`, `uv run` or `devenv shell --`) is
  blocked when the repository's justfile has a `test-changed` recipe.
- Instead, the hook runs `just test <paths>` when the command named test files or folders, else
  `just test-changed`. The model gets one sentence: what was blocked, what ran, and its last line
  (`Passed 11 Failed 0 Skipped 0 in 11.0s (2 files)`); when the tests fail, also the last 40 lines.
- The recipes themselves (`just test`, `just test-changed`, `just test-serial`, and the devenv
  scripts behind them) are not blocked: `just test` is the full run before the agent reports done.
- In a repository without the recipe nothing is blocked; the tool result gets one sentence that
  the test-speed skill of [pi-skills](https://github.com/Patrick-Kappen/pi-skills) sets the
  recipes up.

It needs `just` on the `PATH`. The recipe contract (what `test-changed` gets and prints) is in the
test-speed skill.

## Writing a rule

```markdown
---
paths:
  - "src/api/**/*.ts"
---

# API rules

- Validate the input of every endpoint.
```

Leave out the front matter for a rule that always applies. The
[extension README](extensions/repo-rules/README.md#rules) describes the globs. To share a rule, add
it to `rules/<name>.md` in this repository; it is then available by its name.

## Layout

| Path | Contains |
|---|---|
| `rules/` | The rules of this flake |
| `hooks/` | The hook scripts of this flake, with their tests |
| `extensions/repo-rules/` | The extension, with unit tests |
| `test/integration/` | Runs the extension in pi's own session, with a scripted model |
| `nix/package.nix`, `nix/rules.nix`, `nix/hooks.nix` | The packages `repo-rules`, `rules` and `hooks` |
| `nix/home-manager.nix` | The Home Manager module |
| `nix/checks.nix`, `test/nix/` | Flake checks: packages, module, and the generated files with node |

## Development

The dev environment uses [devenv](https://devenv.sh):

```sh
devenv shell   # tools, dependencies and git hooks
check          # everything CI runs
```

| Command | What it runs |
|---|---|
| `lint` | Linters and formatters (check only) |
| `typecheck` | The type checker |
| `unit [files]` | Unit tests; with files, only the tests related to them |
| `security` | gitleaks over the history, and known vulnerabilities in the lock files |
| `check` | All of the above with coverage, plus `nix flake check` if there is a `flake.nix` |

### Git hooks

| Hook | Checks |
|---|---|
| `pre-commit` | The staged files: linters, types, and the unit tests related to them; secrets; no commits on `main` |
| `commit-msg` | [Conventional Commits](https://www.conventionalcommits.org/) |
| `pre-push` | `check` |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## CI and releases

- `ci.yml` runs `devenv test` on every PR and on `main`, and checks the PR title and commit messages.
- `release.yml` runs [release-please](https://github.com/googleapis/release-please) on `main`:
  1. It keeps one release PR that collects the merged PRs, with the version bump and the notes in
     [`CHANGELOG.md`](CHANGELOG.md).
  2. Merging that PR tags `vX.Y.Z`, publishes the release, and moves the `latest` branch to it.
- Squash-merge PRs: the PR title becomes the commit on `main`.
