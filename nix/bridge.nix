{ lib, buildNpmPackage, nodejs }:

buildNpmPackage {
  pname = "couchmail";
  version = "0.1.0";

  src = ../bridge;

  npmDepsHash = "sha256-XdSos5hL13f6Anni0GvpuXjh5er1voeOmXbBtApM108=";

  dontNpmBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin $out/lib/couchmail
    cp -r node_modules $out/lib/couchmail/
    cp *.js package.json $out/lib/couchmail/

    cat > $out/bin/couchmail <<EOF
    #!/bin/sh
    exec ${nodejs}/bin/node $out/lib/couchmail/server.js "\$@"
    EOF
    cat > $out/bin/couchmail-ctl <<EOF
    #!/bin/sh
    exec ${nodejs}/bin/node $out/lib/couchmail/ctl.js "\$@"
    EOF
    chmod +x $out/bin/couchmail $out/bin/couchmail-ctl

    runHook postInstall
  '';

  meta = {
    description = "Mail bridge for postfix virtual lookups, dovecot auth/sieve and the couchmail web UI";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
