# The hook scripts of hooks/<name>.sh, ready to use as `run` of a repo-rules hook.
{
  lib,
  stdenvNoCC,
  bash,
  version,
}:
stdenvNoCC.mkDerivation {
  pname = "pi-rules-hooks";
  inherit version;

  src = lib.fileset.toSource {
    root = ../hooks;
    fileset = lib.fileset.fileFilter (file: file.hasExt "sh") ../hooks;
  };

  # patchShebangs (fixup) points `#!/usr/bin/env bash` at this bash.
  buildInputs = [ bash ];
  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    install -m 755 *.sh $out/
    runHook postInstall
  '';

  meta = {
    description = "Hook scripts for the pi repo-rules extension";
    homepage = "https://github.com/Patrick-Kappen/pi-rules";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
  };
}
