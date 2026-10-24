flake:

{ config, lib, pkgs, ... }:

let
  cfg = config.services.couchmail;
  packages = flake.packages.${pkgs.stdenv.hostPlatform.system};
  imp = cfg.importFromCouchdb;
  stateDir = "/var/lib/couchmail";
in
{
  options.services.couchmail = {
    enable = lib.mkEnableOption "Couchmail — mail bridge for postfix/dovecot with a web UI";

    domain = lib.mkOption {
      type = lib.types.str;
      example = "6bit.com";
      description = "Primary mail domain";
    };

    bridgePorts = {
      domain = lib.mkOption {
        type = lib.types.port;
        default = 40571;
        description = "Loopback TCP port for postfix virtual_mailbox_domains lookup";
      };
      mailbox = lib.mkOption {
        type = lib.types.port;
        default = 40572;
        description = "Loopback TCP port for postfix virtual_mailbox_maps lookup";
      };
      alias = lib.mkOption {
        type = lib.types.port;
        default = 40573;
        description = "Loopback TCP port for postfix virtual_alias_maps lookup";
      };
      password = lib.mkOption {
        type = lib.types.port;
        default = 40574;
        description = "Loopback HTTP port for the web API (proxied by nginx at /_couchmail/api/)";
      };
      sieve = lib.mkOption {
        type = lib.types.port;
        default = 40576;
        description = ''
          Loopback-only port where the bridge answers dovecot's sieve script
          lookups (dovecot's redis dict driver). Never expose this port.
        '';
      };
      oauth2 = lib.mkOption {
        type = lib.types.port;
        default = 40575;
        description = ''
          Loopback-only HTTP port for dovecot's OAuth2 password grant.
          Never proxy this port.
        '';
      };
    };

    oauth2ClientSecretFile = lib.mkOption {
      type = lib.types.str;
      example = "/run/secrets/couchmail/oauth2-client-secret";
      description = ''
        File containing the secret dovecot uses to authenticate to the
        bridge: the OAuth2 client secret for logins, and the password for
        sieve lookups. Read by dovecot's config
        process and passed to the bridge as a systemd credential, so it is
        never copied to the Nix store.
      '';
    };

    importFromCouchdb = {
      enable = lib.mkEnableOption ''
        a one-time import from couchmail's old CouchDB `mail` database. Runs
        CouchDB as before; the bridge copies everything into its SQLite
        database (${stateDir}/couchmail.db) on its first start and never
        writes to CouchDB. Turn this off once the import has run (the
        journal says "Import: imported ..."); CouchDB's data is left in place
      '';
      dataDir = lib.mkOption {
        type = lib.types.path;
        default = "/var/lib/couchdb";
        description = "CouchDB data directory";
      };
      port = lib.mkOption {
        type = lib.types.port;
        default = 5984;
        description = "Port for CouchDB to listen on (loopback)";
      };
      credentialsFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        description = ''
          Environment file for CouchDB admin credentials.
          Should contain COUCHDB_USER and COUCHDB_PASSWORD.
        '';
      };
      bridgePasswordFile = lib.mkOption {
        type = lib.types.nullOr lib.types.path;
        default = null;
        description = ''
          Environment file with the bridge's CouchDB password (COUCH_PASSWORD)
          for the `mail` admin user it imports as.
        '';
      };
    };

    nginx = {
      enable = lib.mkEnableOption "nginx locations for the couchmail web UI and API";
      virtualHost = lib.mkOption {
        type = lib.types.str;
        default = "mail.${cfg.domain}";
        description = "nginx virtual host to serve the web UI on";
      };
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [{

    assertions = [
      {
        assertion = !imp.enable || (imp.credentialsFile != null && imp.bridgePasswordFile != null);
        message = "services.couchmail.importFromCouchdb needs credentialsFile and bridgePasswordFile.";
      }
      {
        assertion = !config.services.dovecot2.enable
          || lib.versionAtLeast config.services.dovecot2.package.version "2.4";
        message = "services.couchmail requires Dovecot 2.4 (passdb oauth2 and 2.4 sieve settings).";
      }
    ];

    # ── Couchmail bridge ────────────────────────────────────────
    users.users.couchmail = {
      isSystemUser = true;
      group = "couchmail";
    };
    users.groups.couchmail = { };

    # Admin CLI; run as the couchmail user, e.g.
    #   sudo -u couchmail couchmail-ctl add-user you@example.com --admin
    environment.systemPackages = [ packages.couchmail ]
      # Sieve storage and the LMTP sieve plugin need pigeonhole's modules
      ++ lib.optional config.services.dovecot2.enable
        config.services.dovecot2.package.passthru.dovecot_pigeonhole;

    systemd.services.couchmail = {
      description = "Couchmail mail bridge for postfix/dovecot";
      after = [ "network.target" ] ++ lib.optional imp.enable "couchdb.service";
      wants = lib.optional imp.enable "couchdb.service";
      wantedBy = [ "multi-user.target" ];
      environment = {
        DB_PATH = "${stateDir}/couchmail.db";
        DOMAIN_PORT = toString cfg.bridgePorts.domain;
        MAILBOX_PORT = toString cfg.bridgePorts.mailbox;
        ALIAS_PORT = toString cfg.bridgePorts.alias;
        PASSWORD_PORT = toString cfg.bridgePorts.password;
        OAUTH2_PORT = toString cfg.bridgePorts.oauth2;
        SIEVE_PORT = toString cfg.bridgePorts.sieve;
      } // lib.optionalAttrs imp.enable {
        COUCH_IMPORT = "1";
        COUCH_HOST = "127.0.0.1";
        COUCH_PORT = toString imp.port;
        COUCH_USER = "mail";
      };
      serviceConfig = {
        ExecStart = "${packages.couchmail}/bin/couchmail";
        LoadCredential = [ "oauth2-client-secret:${cfg.oauth2ClientSecretFile}" ];
        EnvironmentFile = lib.mkIf imp.enable imp.bridgePasswordFile;
        User = "couchmail";
        Group = "couchmail";
        StateDirectory = "couchmail";
        StateDirectoryMode = "0700";
        UMask = "0077";
        Restart = "on-failure";
        RestartSec = 5;

        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        NoNewPrivileges = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" ];
      };
    };

    # ── Postfix virtual map integration ─────────────────────────
    services.postfix.settings.main = lib.mkIf config.services.postfix.enable {
      virtual_mailbox_domains = "tcp:127.0.0.1:${toString cfg.bridgePorts.domain}";
      virtual_mailbox_maps = "tcp:127.0.0.1:${toString cfg.bridgePorts.mailbox}";
      virtual_alias_maps = "tcp:127.0.0.1:${toString cfg.bridgePorts.alias}";
    };

    # ── Dovecot integration (2.4) ───────────────────────────────
    services.dovecot2.settings = lib.mkIf config.services.dovecot2.enable {
      # Auth: dovecot hands credentials to the bridge (OAuth2 password grant).
      # This passdb can only verify passwords, not answer lookups, so a static
      # userdb needs userdb_static_allow_all_users (postfix vets recipients).
      "passdb oauth2" = {
        driver = "oauth2";
        oauth2_grant_url = "http://127.0.0.1:${toString cfg.bridgePorts.oauth2}/token";
        oauth2_introspection_url = "http://127.0.0.1:${toString cfg.bridgePorts.oauth2}/introspect";
        oauth2_introspection_mode = "post";
        oauth2_client_id = "dovecot";
        # Bad passwords come back as active=false (see bridge /token), so
        # dovecot treats them as a password mismatch, not a temporary failure
        oauth2_active_attribute = "active";
        oauth2_active_value = "true";
        oauth2_client_secret = "<${cfg.oauth2ClientSecretFile}";
      };

      # Sieve: each user's main_script, looked up from the bridge over
      # loopback TCP (the bridge speaks the Redis protocol for this)
      "sieve_script personal" = {
        sieve_script_type = "personal";
        sieve_script_driver = "dict";
        sieve_script_name = "main_script";
        "dict redis" = {
          redis_host = "127.0.0.1";
          redis_port = cfg.bridgePorts.sieve;
          redis_password = "<${cfg.oauth2ClientSecretFile}";
        };
      };
      "protocol lmtp".mail_plugins.sieve = true;
    };

    # ── nginx (optional) ────────────────────────────────────────
    services.nginx.virtualHosts.${cfg.nginx.virtualHost} = lib.mkIf cfg.nginx.enable {
      locations."/_couchmail/" = {
        alias = "${packages.couchmail-ui}/";
        extraConfig = ''
          try_files $uri $uri/ /index.html;
        '';
      };
      locations."/_couchmail/api/" = {
        proxyPass = "http://127.0.0.1:${toString cfg.bridgePorts.password}/";
      };
    };

  }

  # ── CouchDB, only while importing ───────────────────────────
  (lib.mkIf imp.enable {
    services.couchdb = {
      enable = true;
      package = pkgs.couchdb3;
      bindAddress = "127.0.0.1";
      port = imp.port;
      databaseDir = imp.dataDir;
      extraConfigFiles = [
        (pkgs.writeText "couchmail-couchdb.ini" ''
          [couchdb]
          single_node = true
        '')
      ];
    };

    # Generate local.ini with the admin credentials
    systemd.services.couchdb.serviceConfig.ExecStartPre = lib.mkAfter [
      "+${pkgs.writeShellScript "couchdb-write-admins" ''
        set -euo pipefail
        read_env() { ${pkgs.gnugrep}/bin/grep "^$1=" "$2" | ${pkgs.coreutils}/bin/cut -d= -f2-; }
        couchdb_user=$(read_env COUCHDB_USER ${imp.credentialsFile})
        couchdb_pass=$(read_env COUCHDB_PASSWORD ${imp.credentialsFile})
        couch_pass=$(read_env COUCH_PASSWORD ${imp.bridgePasswordFile})

        # Cookie secret for Futon logins, stable across restarts. printf is a
        # builtin, so the password never appears in argv.
        cookie_secret=$(printf '%s' "couchmail-proxy-secret:$couch_pass" | ${pkgs.coreutils}/bin/sha256sum | ${pkgs.coreutils}/bin/cut -d' ' -f1)

        local_ini=${imp.dataDir}/local.ini
        {
          printf '[admins]\n'
          printf '%s = %s\n' "$couchdb_user" "$couchdb_pass"
          printf 'mail = %s\n' "$couch_pass"
          printf '\n[chttpd_auth]\n'
          printf 'secret = %s\n' "$cookie_secret"
        } > "$local_ini"
        chown couchdb:couchdb "$local_ini"
        chmod 600 "$local_ini"
      ''}"
    ];
  })]);
}
