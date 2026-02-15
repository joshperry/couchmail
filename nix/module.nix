flake:

{ config, lib, pkgs, ... }:

let
  cfg = config.services.couchmail;
  packages = flake.packages.${pkgs.system};
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
        description = "HTTP port for password change endpoint";
      };
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
      package = packages.couchdb;
      bindAddress = "127.0.0.1";
      port = cfg.couchdbPort;
      databaseDir = cfg.couchdbDataDir;
      extraConfigFiles = [
        (pkgs.writeText "couchmail-couchdb.ini" ''
          [chttpd]
          authentication_handlers = {chttpd_auth, cookie_authentication_handler}, {chttpd_auth, default_authentication_handler}

          [chttpd_auth]
          authentication_db = mail

          [couchdb]
          single_node = true
        '')
      ];
    };

    # Generate local.ini with admin credentials from sops
    systemd.services.couchdb.serviceConfig.ExecStartPre = lib.mkAfter [
      "+${pkgs.writeShellScript "couchdb-write-admins" ''
        set -euo pipefail
        read_env() { ${pkgs.gnugrep}/bin/grep "^$1=" "$2" | ${pkgs.coreutils}/bin/cut -d= -f2-; }
        couchdb_user=$(read_env COUCHDB_USER ${cfg.couchdbCredentialsFile})
        couchdb_pass=$(read_env COUCHDB_PASSWORD ${cfg.couchdbCredentialsFile})
        couch_pass=$(read_env COUCH_PASSWORD ${cfg.bridgePasswordFile})
        local_ini=${cfg.couchdbDataDir}/local.ini
        {
          printf '[admins]\n'
          printf '%s = %s\n' "$couchdb_user" "$couchdb_pass"
          printf 'mail = %s\n' "$couch_pass"
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
      after = [ "couchdb.service" "network.target" ];
      wantedBy = [ "multi-user.target" ];
      environment = {
        COUCH_HOST = "localhost";
        COUCH_USER = "mail";
        PASSWORD_PORT = toString cfg.bridgePorts.password;
      };
      serviceConfig = {
        ExecStart = "${packages.couchmail}/bin/couchmail";
        RuntimeDirectory = "couchmail";
        EnvironmentFile = cfg.bridgePasswordFile;
        User = "couchmail";
        Group = "couchmail";
        Restart = "on-failure";
        RestartSec = 5;
      };
    };

    # ── Dovecot dict auth config ────────────────────────────────
    environment.etc."dovecot/dovecot-dict-auth.conf.ext".text = ''
      uri = proxy:/run/couchmail/dovecot-auth.sock:auth
      password_key = %u
      user_key = %u
      default_pass_scheme = SSHA512
    '';

    # ── Postfix virtual map integration ─────────────────────────
    services.postfix.config = lib.mkIf config.services.postfix.enable {
      virtual_mailbox_domains = "tcp:localhost:${toString cfg.bridgePorts.domain}";
      virtual_mailbox_maps = "tcp:localhost:${toString cfg.bridgePorts.mailbox}";
      virtual_alias_maps = "tcp:localhost:${toString cfg.bridgePorts.alias}";
    };

    # ── Dovecot integration ─────────────────────────────────────
    services.dovecot2.extraConfig = lib.mkIf config.services.dovecot2.enable ''
      # Auth via couchmail dict proxy
      passdb {
        driver = dict
        args = /etc/dovecot/dovecot-dict-auth.conf.ext
      }

      # Sieve via couchmail
      plugin {
        sieve = dict:proxy:/run/couchmail/dovecot-auth.sock:sieve;name=main_script
      }
    '';

    # ── nginx (optional) ────────────────────────────────────────
    services.nginx.virtualHosts.${cfg.nginx.virtualHost} = lib.mkIf cfg.nginx.enable {
      locations."/_couchmail/" = {
        alias = "${packages.couchmail-ui}/";
        extraConfig = ''
          try_files $uri $uri/ /index.html;
        '';
      };
      locations."/_session" = {
        proxyPass = "http://127.0.0.1:${toString cfg.couchdbPort}/_session";
      };
      locations."/mail/" = {
        proxyPass = "http://127.0.0.1:${toString cfg.couchdbPort}/mail/";
      };
      locations."/_couchmail/api/password" = {
        proxyPass = "http://127.0.0.1:${toString cfg.bridgePorts.password}/password";
      };
    };
  };
}
