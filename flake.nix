{
  description = "Couchmail — CouchDB-backed mail management with web UI";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.11";
    flake-parts.url = "github:hercules-ci/flake-parts";
  };

  outputs = inputs@{ self, nixpkgs, flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" ];

      perSystem = { pkgs, system, ... }: {
        packages = {
          couchmail = pkgs.callPackage ./nix/bridge.nix { };
          couchmail-ui = pkgs.callPackage ./nix/ui.nix { };
          default = self.packages.${system}.couchmail;
        };
      };

      flake = {
        nixosModules.default = import ./nix/module.nix self;
      };
    };
}
