# The repo-rules extension: only the files pi loads, no tests.
{
  lib,
  stdenvNoCC,
  version,
}:
let
  src = ../extensions/repo-rules;
in
stdenvNoCC.mkDerivation {
  pname = "pi-repo-rules";
  inherit version;

  src = lib.fileset.toSource {
    root = src;
    fileset = lib.fileset.unions [
      (lib.fileset.fileFilter (file: file.hasExt "ts" && !lib.hasSuffix ".test.ts" file.name) src)
      (src + "/README.md")
    ];
  };

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r . $out/
    runHook postInstall
  '';

  meta = {
    description = "Pi extension that applies rules per repository";
    homepage = "https://github.com/Patrick-Kappen/pi-rules";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
  };
}
