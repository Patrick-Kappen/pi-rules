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
in
{
  inherit (packages) repo-rules rules;

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
