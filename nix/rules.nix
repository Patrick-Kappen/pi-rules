# The rules of rules/<name>.md.
{
  lib,
  stdenvNoCC,
  version,
}:
stdenvNoCC.mkDerivation {
  pname = "pi-rules";
  inherit version;

  src = lib.fileset.toSource {
    root = ../rules;
    fileset = lib.fileset.fileFilter (file: file.hasExt "md") ../rules;
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
    description = "pi agent rules, applied per repository by the repo-rules extension";
    homepage = "https://github.com/Patrick-Kappen/pi-rules";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
  };
}
