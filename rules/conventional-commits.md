# Commits

- Write commit messages as Conventional Commits: `type(scope): subject`, imperative, lower case, no
  period, at most 72 characters.
- Types: feat, fix, perf, refactor, docs, test, build, ci, chore, revert; `!` marks a breaking change.
- The body says why, not what; wrap it at 72 columns.
- Never commit on `main`: work on a branch named `<type>/<short-topic>` and open a PR whose title is
  a Conventional Commit.
