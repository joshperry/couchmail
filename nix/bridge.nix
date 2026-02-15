{ lib, buildNpmPackage, nodejs }:

buildNpmPackage {
  pname = "couchmail";
  version = "0.1.0";

  src = ../bridge;

  npmDepsHash = "sha256-fsX+CpoOFfYo9fmGVaEYFdv2ZsDvK3g8+VA6UmGwUpM=";

  dontNpmBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin $out/lib/couchmail
    cp -r node_modules $out/lib/couchmail/
    cp server.js $out/lib/couchmail/
    cp package.json $out/lib/couchmail/

    cat > $out/bin/couchmail <<EOF
    #!/bin/sh
    exec ${nodejs}/bin/node $out/lib/couchmail/server.js "\$@"
    EOF
    chmod +x $out/bin/couchmail

    runHook postInstall
  '';

  meta = {
    description = "CouchDB mail bridge for postfix virtual lookups and dovecot auth/sieve";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
