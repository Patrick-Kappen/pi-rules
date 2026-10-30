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

  permissionList =
    action: description:
    lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      inherit description;
      example =
        {
          deny = [
            "read(.env)"
            "read(secrets/**)"
            "bash(rm -rf *)"
          ];
          ask = [
            "bash(git push *)"
            "mcp__github__delete_*"
          ];
          allow = [ "bash(git push origin feat/*)" ];
        }
        .${action};
    };

  hookEvents = {
    session_start = "When a session starts (also on /reload, /new, /resume and /fork). Its stdout goes into the system prompt.";
    before_agent_start = "On every prompt, before the model runs. Its stdout is added to the context, hidden in the transcript.";
    tool_call = "Before a tool call, after the permissions. Exit code 2 blocks the call; stderr is the reason the model gets.";
    tool_result = "After a tool call. Its stdout is added to the tool result; with exit code 2, its stderr is added as a problem.";
    agent_before_settle = "When the model is done. Exit code 2 gives the model stderr and one more round, at most three times per prompt.";
    session_shutdown = "When the session ends.";
  };
  toolEvents = [
    "tool_call"
    "tool_result"
  ];

  hookModule = {
    options = {
      run = lib.mkOption {
        type = lib.types.str;
        example = ''biome format --write "$PI_FILE"'';
        description = ''
          Shell command, run with `sh -c` in the root of the repository (outside git: the working
          directory). It gets the event as JSON on stdin, and `PI_EVENT`, `PI_CWD`, `PI_ROOT`,
          `PI_TOOL`, `PI_FILE`, `PI_FILES` and `PI_COMMAND` in its environment. Exit code 2 is
          for the model (see the event); other non-zero codes are reported to you.
        '';
      };
      tools = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [
          "edit"
          "write"
        ];
        description = "Only for these tools (`*` matches anything). Empty: every tool. Only for tool_call and tool_result.";
      };
      paths = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "**/*.ts" ];
        description = "Only when the call reads or changes a file that matches, with the globs of rules. Only for tool_call and tool_result.";
      };
      command = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        example = [ "git commit *" ];
        description = "Only for bash calls with a command that matches, with the globs of permissions. Only for tool_call and tool_result.";
      };
      timeout = lib.mkOption {
        type = lib.types.ints.positive;
        default = 60;
        description = "Seconds before the hook is stopped.";
      };
    };
  };

  scopeModule.options = {
    hooks = lib.mapAttrs (
      event: description:
      lib.mkOption {
        type = lib.types.listOf (lib.types.submodule hookModule);
        default = [ ];
        description = "Hooks on pi's `${event}` event. ${description}";
      }
    ) hookEvents;

    permissions = {
      deny = permissionList "deny" "Tool calls that are blocked. `deny` always wins.";
      ask = permissionList "ask" ''
        Tool calls that need your approval: allow once, allow for the session, or deny. Without a UI
        (print and JSON mode) they are blocked.
      '';
      allow = permissionList "allow" ''
        Exceptions to `ask`: a call that matches `allow` is not asked. Everything that matches no
        `deny` or `ask` rule is allowed anyway.
      '';
    };

    rules = lib.mkOption {
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

  scopeJson = scope: {
    rules = map ruleFile scope.rules;
    inherit (scope) permissions;
    hooks = lib.filterAttrs (_: hooks: hooks != [ ]) scope.hooks;
  };
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
      ++ lib.concatLists (
        lib.mapAttrsToList (
          event: hooks:
          map (hook: {
            assertion = builtins.elem event toolEvents || hook.tools ++ hook.paths ++ hook.command == [ ];
            message = "programs.pi-rules.${name}.hooks.${event}: tools, paths and command only work on tool_call and tool_result.";
          }) hooks
        ) scope.hooks
      )
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
