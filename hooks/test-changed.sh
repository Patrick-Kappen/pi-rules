#!/usr/bin/env bash
# A repo-rules hook: test runs go through the repository's recipes.
#
# On tool_call (bash): when the command runs a test tool directly (pytest, vitest, jest, bun test,
# Invoke-Pester, go/cargo/dotnet test, npm test, ...) and the repository has a `test-changed` recipe
# in its justfile, the call is blocked (exit 2) and the right recipe runs instead:
#   - `just test <paths>` when the command named test files or folders (and a `test` recipe exists);
#   - else `just test-changed`, the tests that cover the changes.
# The model gets one sentence with the recipe's result, and the failures when it fails.
# On tool_result: for a test command in a repository without the recipe, one sentence that the
# test-speed skill sets it up.
#
# Environment (from repo-rules): PI_EVENT, PI_CWD, PI_COMMAND. TEST_CHANGED_TIMEOUT: seconds for the
# recipe (default 840; keep it below the hook's timeout).
set -uo pipefail

command_line="${PI_COMMAND:-}"
[[ -n ${command_line} ]] || exit 0
dir="${PI_CWD:-$PWD}"
limit="${TEST_CHANGED_TIMEOUT:-840}"

TEST_FILE='(\.Tests\.ps1|\.(test|spec)\.[cm]?[jt]sx?|(^|/)test_[^/]*\.py|_test\.(py|go))$'

# Remove what runs the command without being it: VAR=x, timeout, time, env, npx, uv run, devenv shell.
strip_wrappers() {
  local s="$1" before=""
  while [[ ${s} != "${before}" ]]; do
    before="${s}"
    s="$(sed -E \
      -e 's/^[[:space:]]+//' \
      -e 's/^[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+//' \
      -e 's/^(sudo|env|time|command|exec)[[:space:]]+//' \
      -e 's/^timeout([[:space:]]+-[^[:space:]]+)*[[:space:]]+[0-9.]+[smhd]?[[:space:]]+//' \
      -e 's/^(npx|bunx|pnpm[[:space:]]+exec|yarn[[:space:]]+exec)[[:space:]]+(--yes[[:space:]]+)?//' \
      -e 's/^(uv|poetry|pipenv|pdm|hatch)[[:space:]]+run[[:space:]]+//' \
      -e 's/^devenv[[:space:]]+shell[[:space:]]+(--[[:space:]]+)?//' \
      -e 's/^nix[[:space:]]+develop([[:space:]]+[^-][^[:space:]]*)?[[:space:]]+(-c|--command)[[:space:]]+//' \
      <<<"${s}")"
  done
  printf '%s\n' "${s}"
}

# Whether a (stripped) command runs a test tool directly.
is_test() {
  local s="$1"
  [[ ${s} =~ (^|[[:space:]])--(help|version)([[:space:]]|$) ]] && return 1
  [[ ${s} =~ ^(pytest|py\.test|vitest|jest|Invoke-Pester)([[:space:]]|$) ]] && return 0
  [[ ${s} =~ ^python3?[[:space:]]+-m[[:space:]]+pytest([[:space:]]|$) ]] && return 0
  [[ ${s} =~ ^bun[[:space:]]+test([[:space:]]|$) ]] && return 0
  [[ ${s} =~ ^(npm|pnpm|yarn)[[:space:]]+(run[[:space:]]+)?test([[:space:]]|$) ]] && return 0
  [[ ${s} =~ ^(go|cargo|dotnet)[[:space:]]+test([[:space:]]|$) ]] && return 0
  [[ ${s} =~ ^(pwsh|powershell)(\.exe)?[[:space:]].*(Invoke-Pester|\.Tests\.ps1) ]] && return 0
  return 1
}

# Find the test command in the line, following `cd <dir>` before it.
test_command=""
while IFS= read -r part; do
  part="$(strip_wrappers "${part}")"
  if [[ ${part} =~ ^cd[[:space:]]+(.+)$ ]]; then
    target="${BASH_REMATCH[1]}"
    target="${target%"${target##*[![:space:]]}"}"
    target="${target#[\"\']}"
    target="${target%[\"\']}"
    [[ ${target} == "~"* ]] && target="${HOME}${target:1}"
    [[ ${target} == /* ]] || target="${dir}/${target}"
    [[ -d ${target} ]] && dir="$(cd "${target}" && pwd)"
    continue
  fi
  if is_test "${part}"; then
    test_command="${part}"
    break
  fi
done < <(sed -E 's/(&&|\|\||;|\|)/\n/g' <<<"${command_line}")
[[ -n ${test_command} ]] || exit 0

recipes=" $(cd "${dir}" 2>/dev/null && just --summary 2>/dev/null) "
if [[ ${recipes} != *" test-changed "* ]]; then
  if [[ ${PI_EVENT:-} == tool_result ]]; then
    echo "This repository has no \`just test-changed\` recipe; the test-speed skill sets up fast test recipes."
  fi
  exit 0
fi
[[ ${PI_EVENT:-tool_call} == tool_call ]] || exit 0

# Test files and folders named in the command (pytest node ids lose their ::part).
paths=()
read -r -a words <<<"${test_command}"
for word in "${words[@]:1}"; do
  word="${word#[\"\']}"
  word="${word%[\"\']}"
  word="${word%%::*}"
  word="${word#./}"
  [[ -z ${word} || ${word} == -* || ${word} == "." ]] && continue
  if [[ -d "${dir}/${word}" ]] || [[ -f "${dir}/${word}" && ${word} =~ ${TEST_FILE} ]]; then
    paths+=("${word}")
  fi
done

if [[ ${#paths[@]} -gt 0 && ${recipes} == *" test "* ]]; then
  recipe=(test "${paths[@]}")
elif [[ ${#paths[@]} -gt 0 ]]; then
  recipe=(test-changed "${paths[@]}")
else
  recipe=(test-changed)
fi

output="$(cd "${dir}" && timeout "${limit}" just "${recipe[@]}" 2>&1)"
code=$?
# Without colours and empty lines, for the model.
output="$(sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g' <<<"${output}" | sed '/^[[:space:]]*$/d')"
summary="$(tail -n 1 <<<"${output}")"
[[ -n ${summary} ]] || summary="no tests cover the changes"

shown="${test_command}"
[[ ${#shown} -gt 80 ]] && shown="${shown:0:77}..."
if [[ ${code} -eq 0 ]]; then
  echo "Blocked \`${shown}\` and ran \`just ${recipe[*]}\` instead (use the recipes for tests): ${summary}" >&2
elif [[ ${code} -eq 124 ]]; then
  echo "Blocked \`${shown}\` and ran \`just ${recipe[*]}\` instead, which did not finish in ${limit}s." >&2
else
  echo "Blocked \`${shown}\` and ran \`just ${recipe[*]}\` instead (use the recipes for tests); it failed:" >&2
  tail -n 40 <<<"${output}" >&2
fi
exit 2
