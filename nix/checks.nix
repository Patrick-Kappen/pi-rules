{
  self,
  pkgs,
  home-manager,
}:
let
  packages = self.packages.${pkgs.stdenv.hostPlatform.system};
  hmConfig =
    settings:
    home-manager.lib.homeManagerConfiguration {
      inherit pkgs;
      modules = [
        self.homeModules.default
        {
          home = {
            username = "check";
            homeDirectory = "/home/check";
            stateVersion = "25.11";
          };
          programs.pi-rules = {
            enable = true;
          }
          // settings;
        }
      ];
    };
  hm = hmConfig {
    global = {
      rules = [ "conventional-commits" ];
      permissions.deny = [ "read(.env)" ];
      hooks.tool_call = [
        {
          run = "echo no >&2; exit 2";
          command = [ "git commit *" ];
        }
      ];
    };
    # A rule from elsewhere, by Nix path.
    repos."Patrick-Kappen/*".rules = [ ../test/nix/api.md ];
  };
  # The test-changed hook: its scripts and the hooks it adds to global.
  hmTestChanged = hmConfig {
    global.hooks.tool_call = [ { run = "own"; } ];
    testChanged = {
      enable = true;
      timeout = 600;
    };
  };
in
{
  inherit (packages) repo-rules rules hooks;

  # The test-changed option adds a tool_call and a tool_result hook after the own hooks of global.
  home-manager-test-changed =
    pkgs.runCommand "home-manager-test-changed-check"
      {
        nativeBuildInputs = [ pkgs.jq ];
        homeFiles = hmTestChanged.config.home-files;
      }
      ''
        config="$homeFiles/.pi/agent/repo-rules.json"
        jq -e --arg run "TEST_CHANGED_TIMEOUT=570 ${packages.hooks}/test-changed.sh" \
          '.global.hooks.tool_call | length == 2 and .[0].run == "own" and .[1].run == $run and .[1].timeout == 600 and .[1].tools == ["bash"] and (.[1].command | index("pytest *"))' "$config"
        jq -e --arg run "${packages.hooks}/test-changed.sh" \
          '.global.hooks.tool_result == [{ run: $run, tools: ["bash"], paths: [], command: .global.hooks.tool_call[1].command, timeout: 10 }]' "$config"
        test -x ${packages.hooks}/test-changed.sh
        head -1 ${packages.hooks}/test-changed.sh | grep -q '^#!/nix/store/.*/bash$'
        touch $out
      '';

  # Builds a Home Manager configuration with the module and runs the generated files with node.
  home-manager =
    pkgs.runCommand "home-manager-check"
      {
        nativeBuildInputs = [
          pkgs.nodejs_24
          pkgs.git
          pkgs.jq
        ];
        homeFiles = hm.config.home-files;
        smoke = ../test/nix/home-manager-smoke.ts;
      }
      ''
        export HOME=$TMPDIR
        agent=.pi/agent
        test -f "$homeFiles/$agent/extensions/repo-rules/index.ts"
        test ! -e "$homeFiles/$agent/extensions/repo-rules/index.test.ts"
        jq -e --arg rule "${packages.rules}/conventional-commits.md" \
          '.global == {
            rules: [$rule],
            permissions: { deny: ["read(.env)"], ask: [], allow: [] },
            hooks: { tool_call: [{ run: "echo no >&2; exit 2", tools: [], paths: [], command: ["git commit *"], timeout: 60 }] }
          }' "$homeFiles/$agent/repo-rules.json"
        test -f "$(jq -r '.repos."Patrick-Kappen/*".rules[0]' "$homeFiles/$agent/repo-rules.json")"
        cp "$smoke" smoke.ts
        node smoke.ts "$homeFiles" "$agent"
        touch $out
      '';

  # A rule name that is not in this flake, or a filter on a hook that has no tool, fails the evaluation.
  home-manager-assertion =
    let
      fails = settings: !(builtins.tryEval (hmConfig settings).activationPackage.drvPath).success;
    in
    assert fails { global.rules = [ "unknown" ]; };
    assert fails {
      global.hooks.agent_before_settle = [
        {
          run = "check";
          tools = [ "bash" ];
        }
      ];
    };
    pkgs.emptyFile;
}
