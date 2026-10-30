{
  description = "pi extension that applies rules per repository: instructions, permissions and hooks";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # Only for the checks; consumers set `inputs.home-manager.follows`.
    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      home-manager,
    }:
    let
      inherit (nixpkgs) lib;
      inherit (builtins.fromJSON (builtins.readFile ./package.json)) version;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        # The extension that applies the rules.
        repo-rules = pkgs.callPackage ./nix/package.nix { inherit version; };
        # The rules of rules/<name>.md.
        rules = pkgs.callPackage ./nix/rules.nix { inherit version; };
        default = repo-rules;
      });

      homeModules = rec {
        pi-rules = import ./nix/home-manager.nix { inherit self; };
        default = pi-rules;
      };

      # treefmt, so `nix fmt -- --fail-on-change FILES` works (the owner's global pre-commit hook uses it).
      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);

      checks = forAllSystems (
        pkgs:
        import ./nix/checks.nix { inherit self pkgs home-manager; }
        // {
          formatting = pkgs.runCommand "formatting" { nativeBuildInputs = [ pkgs.nixfmt ]; } ''
            cd ${self}
            nixfmt --check $(find . -name '*.nix' -not -path './.devenv/*')
            touch $out
          '';
        }
      );
    };
}
