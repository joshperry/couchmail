flake:

{ config, lib, pkgs, ... }:

let
  cfg = config.services.couchmail;
  packages = flake.packages.${pkgs.stdenv.hostPlatform.system};
in
{
  options.services.couchmail = {
    enable = lib.mkEnableOption "Couchmail — CouchDB mail bridge with web UI";

    domain = lib.mkOption {
      type = lib.types.str;
      example = "6bit.com";
      description = "Primary mail domain";
    };

    couchdbDataDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/couchdb";
      description = "CouchDB data directory";
    };

    couchdbCredentialsFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        Environment file for CouchDB admin credentials.
        Should contain COUCHDB_USER and COUCHDB_PASSWORD.
      '';
    };

    bridgePasswordFile = lib.mkOption {
      type = lib.types.path;
      description = ''
        Environment file for the couchmail bridge.
        Should contain COUCH_PASSWORD.
      '';
    };

    couchdbPort = lib.mkOption {
      type = lib.types.port;
      default = 5984;
      description = "Port for CouchDB to listen on";
    };

    bridgePorts = {
      domain = lib.mkOption {
        type = lib.types.port;
        default = 40571;
        description = "TCP port for postfix virtual_mailbox_domains lookup";
      };
      mailbox = lib.mkOption {
        type = lib.types.port;
        default = 40572;
        description = "TCP port for postfix virtual_mailbox_maps lookup";
      };
      alias = lib.mkOption {
        type = lib.types.port;
        default = 40573;
        description = "TCP port for postfix virtual_alias_maps lookup";
      };
      password = lib.mkOption {
        type = lib.types.port;
        default = 40574;
        description = "HTTP port for bridge (auth, password, CouchDB proxy)";
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

    nginx = {
      enable = lib.mkEnableOption "nginx reverse proxy for CouchDB";
      virtualHost = lib.mkOption {
        type = lib.types.str;
        default = "mail.${cfg.domain}";
        description = "nginx virtual host name for CouchDB proxy";
      };
    };
  };

  config = lib.mkIf cfg.enable {

    # ── CouchDB service ─────────────────────────────────────────
    services.couchdb = {
      enable = true;
      package = pkgs.couchdb3;
      bindAddress = "127.0.0.1";
      port = cfg.couchdbPort;
      databaseDir = cfg.couchdbDataDir;
      extraConfigFiles = [
        (pkgs.writeText "couchmail-couchdb.ini" ''
          [chttpd]
          authentication_handlers = {chttpd_auth, proxy_authentication_handler}, {chttpd_auth, cookie_authentication_handler}, {chttpd_auth, default_authentication_handler}

          [chttpd_auth]
          proxy_use_secret = true

          [couchdb]
          single_node = true
        '')
      ];
    };

    # Generate local.ini with admin credentials and proxy secret
    systemd.services.couchdb.serviceConfig.ExecStartPre = lib.mkAfter [
      "+${pkgs.writeShellScript "couchdb-write-admins" ''
        set -euo pipefail
        read_env() { ${pkgs.gnugrep}/bin/grep "^$1=" "$2" | ${pkgs.coreutils}/bin/cut -d= -f2-; }
        couchdb_user=$(read_env COUCHDB_USER ${cfg.couchdbCredentialsFile})
        couchdb_pass=$(read_env COUCHDB_PASSWORD ${cfg.couchdbCredentialsFile})
        couch_pass=$(read_env COUCH_PASSWORD ${cfg.bridgePasswordFile})

        # Proxy auth secret, derived from the bridge's password exactly as the
        # bridge derives it, so it never has to be shared through a file.
        # printf is a builtin, so the password never appears in argv.
        proxy_secret=$(printf '%s' "couchmail-proxy-secret:$couch_pass" | ${pkgs.coreutils}/bin/sha256sum | ${pkgs.coreutils}/bin/cut -d' ' -f1)

        local_ini=${cfg.couchdbDataDir}/local.ini
        {
          printf '[admins]\n'
          printf '%s = %s\n' "$couchdb_user" "$couchdb_pass"
          printf 'mail = %s\n' "$couch_pass"
          printf '\n[chttpd_auth]\n'
          printf 'secret = %s\n' "$proxy_secret"
        } > "$local_ini"
        chown couchdb:couchdb "$local_ini"
        chmod 600 "$local_ini"
      ''}"
    ];

    # ── Couchmail bridge ────────────────────────────────────────
    users.users.couchmail = {
      isSystemUser = true;
      group = "couchmail";
    };
    users.groups.couchmail = { };

    systemd.services.couchmail = {
      description = "CouchDB mail bridge for postfix/dovecot";
      requires = [ "couchdb.service" ];
      after = [ "couchdb.service" "network.target" ];
      wantedBy = [ "multi-user.target" ];
      environment = {
        COUCH_HOST = "localhost";
        COUCH_USER = "mail";
        PASSWORD_PORT = toString cfg.bridgePorts.password;
        OAUTH2_PORT = toString cfg.bridgePorts.oauth2;
        SIEVE_PORT = toString cfg.bridgePorts.sieve;
      };
      serviceConfig = {
        ExecStart = "${packages.couchmail}/bin/couchmail";
        LoadCredential = [ "oauth2-client-secret:${cfg.oauth2ClientSecretFile}" ];
        EnvironmentFile = cfg.bridgePasswordFile;
        User = "couchmail";
        Group = "couchmail";
        Restart = "on-failure";
        RestartSec = 5;
      };
    };

    # ── Postfix virtual map integration ─────────────────────────
    services.postfix.settings.main = lib.mkIf config.services.postfix.enable {
      virtual_mailbox_domains = "tcp:localhost:${toString cfg.bridgePorts.domain}";
      virtual_mailbox_maps = "tcp:localhost:${toString cfg.bridgePorts.mailbox}";
      virtual_alias_maps = "tcp:localhost:${toString cfg.bridgePorts.alias}";
    };

    # ── Dovecot integration (2.4) ───────────────────────────────
    assertions = [{
      assertion = !config.services.dovecot2.enable
        || lib.versionAtLeast config.services.dovecot2.package.version "2.4";
      message = "services.couchmail requires Dovecot 2.4 (passdb oauth2 and 2.4 sieve settings).";
    }];

    # Sieve storage and the LMTP sieve plugin need pigeonhole's modules
    environment.systemPackages = lib.mkIf config.services.dovecot2.enable [
      config.services.dovecot2.package.passthru.dovecot_pigeonhole
    ];

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
      locations."/mail/" = {
        proxyPass = "http://127.0.0.1:${toString cfg.bridgePorts.password}/couch/mail/";
      };
    };
  };
}
