{ lib, buildNpmPackage }:

buildNpmPackage {
  pname = "couchmail-ui";
  version = "0.1.0";

  src = ../ui;

  npmDepsHash = "sha256-GCY+m9lyWWRz+aXg9h4h1l+XEIz7L4kB2aXoWr+yZaw=";

  buildPhase = ''
    runHook preBuild
    npx vite build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    cp -r dist $out
    runHook postInstall
  '';

  meta = {
    description = "Couchmail web UI — mail account and filter management SPA";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
