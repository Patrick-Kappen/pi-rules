# Home Manager module: installs the repo-rules extension and writes which rules apply where.
{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.pi-rules;
  json = pkgs.formats.json { };
  ownRules = map (lib.removeSuffix ".md") (
    builtins.attrNames (
      lib.filterAttrs (name: type: type == "regular" && lib.hasSuffix ".md" name) (
        builtins.readDir ../rules
      )
    )
  );

  # A name of a rule of this flake, or a file: a Nix path, an absolute path or ~/path.
  isName = rule: builtins.isString rule && !(lib.hasPrefix "/" rule) && !(lib.hasPrefix "~/" rule);
  # A Nix path goes to the store; a string path stays as it is.
  ruleFile = rule: if isName rule then "${cfg.rulesPackage}/${rule}.md" else "${rule}";

  scopeModule = {
    options.rules = lib.mkOption {
      type = lib.types.listOf (lib.types.either lib.types.path lib.types.str);
      default = [ ];
      example = lib.literalExpression ''[ "conventional-commits" ./rules/api.md "~/rules/local.md" ]'';
      description = ''
        Rule files: Markdown, optionally with `paths` globs in YAML front matter. A rule without
        `paths` goes into the system prompt; a rule with `paths` is added to the tool result when pi
        reads or changes a matching file. An entry is the name of a rule of this flake
        (${lib.concatStringsSep ", " ownRules}), a Nix path, or an absolute path or ~/path.
      '';
    };
  };

  scopeJson = scope: { rules = map ruleFile scope.rules; };
  allScopes = [
    {
      name = "global";
      scope = cfg.global;
    }
  ]
  ++ lib.mapAttrsToList (name: scope: {
    name = "repos.${name}";
    inherit scope;
  }) cfg.repos;
in
{
  options.programs.pi-rules = {
    enable = lib.mkEnableOption "the pi repo-rules extension, which applies rules per repository";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.repo-rules;
      defaultText = lib.literalExpression "pi-rules.packages.\${system}.repo-rules";
      description = "The repo-rules extension package.";
    };

    rulesPackage = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.rules;
      defaultText = lib.literalExpression "pi-rules.packages.\${system}.rules";
      description = "The package with the rules of this flake, one <name>.md per rule.";
    };

    agentDir = lib.mkOption {
      type = lib.types.str;
      default = ".pi/agent";
      description = "pi's agent directory relative to the home directory. Change it together with `PI_CODING_AGENT_DIR`.";
    };

    global = lib.mkOption {
      type = lib.types.submodule scopeModule;
      default = { };
      example = lib.literalExpression ''{ rules = [ "conventional-commits" ]; }'';
      description = "What applies everywhere, also outside git repositories.";
    };

    repos = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule scopeModule);
      default = { };
      example = lib.literalExpression ''
        {
          "my-org/infra".rules = [ ./rules/terraform.md ];
          "my-org/*".rules = [ "conventional-commits" ];
          "~/src/project".rules = [ ./rules/project.md ];
        }
      '';
      description = ''
        What applies per repository, on top of `global`. The name is where it applies:

        - a remote: `owner/repo`, `host/owner/repo` or with `*` (`owner/*`). It matches when any
          remote of the repository ends with it, so it works in every clone and every worktree;
        - a path starting with `/` or `~/`: it matches that directory and everything below it.
          Worktrees elsewhere match through the location of their main checkout;
        - `*`: everywhere, like `global`.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = lib.concatMap (
      { name, scope }:
      map (rule: {
        assertion = !(isName rule) || builtins.elem rule ownRules;
        message = "programs.pi-rules.${name}.rules: \"${rule}\" is not a rule of pi-rules (${lib.concatStringsSep ", " ownRules}); use a path.";
      }) scope.rules
    ) allScopes;

    home.file = {
      "${cfg.agentDir}/extensions/repo-rules".source = cfg.package;
      "${cfg.agentDir}/repo-rules.json".source = json.generate "repo-rules.json" {
        global = scopeJson cfg.global;
        repos = lib.mapAttrs (_: scopeJson) cfg.repos;
      };
    };
  };
}
