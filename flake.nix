{
  description = "Margin Calendar, a calendar for Google Calendar";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      overlays.default = final: prev: {
        margin-calendar = final.callPackage ./nix/package.nix { };
      };

      packages.${system} = {
        margin-calendar = pkgs.callPackage ./nix/package.nix { };
        default = self.packages.${system}.margin-calendar;
      };
    };
}
