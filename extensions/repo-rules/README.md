# repo-rules

A pi extension that applies rules and permissions per repository. You list them in your own
configuration, not in the repositories: nothing goes into the repositories themselves.

## How it works

1. When a session starts (also on `/reload`, `/new`, `/resume` and `/fork`), the extension reads
   `~/.pi/agent/repo-rules.json`. It finds the git repository of the working directory by reading the
   `.git` entries; it does not run git.
2. It takes the `global` scope and every `repos` scope whose pattern matches, and reads their rule
   files.
3. Rules without `paths` go into the system prompt, in a `<repo_rules>` section, on every prompt. The
   section also lists the rules with `paths`, with their globs and files.
4. A rule with `paths` is added to the result of a tool call that reads or changes a matching file:
   - `read`, `edit` and `write` on that file;
   - `bash` that prints one file: `cat`, `head`, `tail`, `less`, `more`, `bat`, `nl` or `sed -n`,
     as a single command without pipes or globs.

   Each rule is added once. After a compaction that removed it from the context, it is added
   again the next time. When a codemode script reads the file, the rule is added to the result of
   the `codemode` call, which the model sees.
5. Before every tool call, also the calls of codemode scripts, the permissions decide whether it
   runs: see [Permissions](#permissions).

## Rules

A rule is a Markdown file. YAML front matter with `paths` limits it to some files, as in Claude
Code:

```markdown
---
paths:
  - "src/api/**/*.ts"
  - "src/**/*.{ts,tsx}"
---

# API rules

- Validate the input of every endpoint.
```

The globs match the path relative to the root of the repository (outside git: of the working
directory). Symlinked paths match like the real path.

| Glob | Matches |
|---|---|
| `*` | Within one directory level |
| `**` | Any number of directory levels: `src/**/*.ts` matches `src/a.ts` and `src/x/y/a.ts` |
| `?`, `[abc]`, `[!abc]` | One character, one of a set, one not in a set |
| `{ts,tsx}` | One of the alternatives |
| `*.md` (no `/`) | At any depth, like `**/*.md` |
| `/flake.nix`, `./flake.nix` | Only at the root |
| `docs/` | Everything below `docs` |

`paths` may be a block list, an inline list (`paths: ["a", "b"]`) or one string. Other front matter
keys are ignored. The name of a rule is its file name without `.md`.

## Permissions

Everything is allowed, unless a rule says otherwise:

| List | Effect |
|---|---|
| `deny` | The call is blocked; the model gets the reason. `deny` always wins. |
| `ask` | You are asked: **Allow**, **Allow for this session** (the same rule and the same command or file), or **Deny**. Without a UI (print and JSON mode) the call is blocked. |
| `allow` | An exception to `ask`: a call that matches `allow` is not asked. It does not override `deny`. |

A rule is a pi tool name, optionally with a specifier in parentheses:

| Rule | Matches |
|---|---|
| `bash` | Every bash call |
| `bash(git push *)` | A command: `*` matches anything, and `cmd *` also matches `cmd` alone. Each command of a line is checked: `a && b`, `a; b`, `a \| b`, `$(...)`, and the script of `bash -c '...'`, without `VAR=x`, `sudo` and `env` in front. |
| `read(.env)` | Reading a path: `read`, `grep`, `find` and `ls` on that path, and bash commands that print it (`cat .env`). |
| `edit(flake.lock)` | Changing a path: `edit` and `write`. |
| `write(dist/**)` | Only the `write` tool. |
| `grep(...)`, `find(...)`, `ls(...)` | Only that tool, on its `path` (by default the working directory). |
| `mcp__github__delete_*`, `codemode` | Any other tool, by name; `*` in the name matches anything. |

Paths use the [globs of rules](#rules), relative to the root of the repository. `~/...` and
`//abs/...` are absolute: `read(~/.ssh/**)`, `read(//etc/**)`. Tool names are not case-sensitive,
so `Bash(...)` and `Read(...)` from Claude Code work too.

Permissions are a guardrail, not a sandbox: a command can still reach a file in a way the rules
do not see, for example `python -c 'print(open(".env").read())'`.

## Configuration

`~/.pi/agent/repo-rules.json` (Home Manager writes this file; see the [main README](../../README.md)):

```json
{
  "global": {
    "rules": ["/nix/store/...-pi-rules/conventional-commits.md"],
    "permissions": { "deny": ["read(.env)"], "ask": ["bash(git push *)"] }
  },
  "repos": {
    "my-org/infra": {
      "rules": ["~/rules/terraform.md"],
      "permissions": { "ask": ["bash(terraform apply *)"], "allow": ["bash(git push origin feat/*)"] }
    },
    "~/src/project": { "rules": ["/abs/rules/project.md"] }
  }
}
```

Rule files are absolute paths or `~/...`. A rule listed by several scopes counts once. The
permissions of all scopes that apply count together.

### `repos` patterns

| Pattern | Matches |
|---|---|
| `*` | Everywhere, also outside git repositories, like `global`. |
| `owner/repo` | Every repository with a remote that ends in `owner/repo`, so every clone and every worktree. Case-insensitive; SSH and HTTPS URLs are the same. |
| `github.com/owner/repo` | The same, limited to that host. |
| `owner/*`, `*/repo-*` | `*` matches within one path segment. |
| `/abs/path`, `~/path` | That directory and everything below it. A worktree elsewhere matches through the location of its main checkout. Also works outside git. |

Errors in the config or a missing rule file are reported as a warning when the session starts. The
other rules still apply.

### Locations

| What | Default | Override |
|---|---|---|
| Config file | `~/.pi/agent/repo-rules.json` | `PI_REPO_RULES_CONFIG` |
| Agent directory | `~/.pi/agent` | `PI_CODING_AGENT_DIR` |

## Commands

`/repo-rules` shows the following:

- the config file and the working directory
- the main checkout, the worktree and the normalized remotes
- for each scope, whether it applies
- for each rule that applies: always, or its globs, and whether it is in the context
- the permissions that apply, with their scope

The rules are read when the session starts. After a change to the config or a rule, run `/reload`.

## Notes

- Rules are instructions for the model; permissions are what stops a tool call.
- `match.ts` and `repo.ts` are the same as in `repo-skills`
  ([pi-skills](https://github.com/Patrick-Kappen/pi-skills)) and `repo-mcp`
  ([pi-mcp-servers](https://github.com/Patrick-Kappen/pi-mcp-servers)).
