# End-to-end test: CouchDB + couchmail bridge + Dovecot 2.4.
# Covers OAuth2 password-grant auth (incl. legacy hash migration and CouchDB
# outages) and sieve scripts served over the bridge's dict socket.
flake:

{ pkgs, ... }:

let
  domain = "example.com";
  vhosts = "/var/spool/mail/vhosts";
  # Test-only credentials
  secrets = pkgs.runCommand "couchmail-test-secrets" { } ''
    mkdir -p $out
    printf 'COUCHDB_USER=admin\nCOUCHDB_PASSWORD=adminpass\n' > $out/couchdb.env
    printf 'COUCH_PASSWORD=bridgepass\n' > $out/bridge.env
    printf 'test-client-secret\n' > $out/oauth2-secret
  '';
in
pkgs.testers.runNixOSTest {
  name = "couchmail";

  nodes.machine = { config, ... }: {
    imports = [ flake.nixosModules.default ];

    virtualisation.memorySize = 2048;

    services.couchmail = {
      enable = true;
      inherit domain;
      couchdbCredentialsFile = "${secrets}/couchdb.env";
      bridgePasswordFile = "${secrets}/bridge.env";
      oauth2ClientSecretFile = "${secrets}/oauth2-secret";
    };

    users.users.vmail = {
      uid = 5000;
      group = "vmail";
      home = vhosts;
      isSystemUser = true;
    };
    users.groups.vmail.gid = 5000;
    systemd.tmpfiles.rules = [ "d ${vhosts} 0770 vmail vmail -" ];

    # Same mail layout as a real couchmail host
    services.dovecot2 = {
      enable = true;
      enablePAM = false;
      settings = {
        dovecot_config_version = config.services.dovecot2.package.version;
        dovecot_storage_version = config.services.dovecot2.package.version;
        protocols = {
          imap = true;
          lmtp = true;
        };
        mail_driver = "maildir";
        mail_path = "${vhosts}/%{user | domain}/%{user | username}/.maildir";
        "userdb static" = {
          fields = {
            uid = 5000;
            gid = 5000;
            home = "${vhosts}/%{user | domain}/%{user | username}";
          };
          # passdb oauth2 can't answer existence lookups (postfix vets recipients)
          userdb_static_allow_all_users = true;
        };
        ssl = "no";
        first_valid_uid = 5000;
        last_valid_uid = 5000;
        "service lmtp"."inet_listener lmtp" = {
          listen = "127.0.0.1";
          port = 24;
        };
      };
    };
  };

  testScript = ''
    import base64, hashlib, json, os, shlex, urllib.parse

    COUCH = "curl -sf -u admin:adminpass http://127.0.0.1:5984"
    MAILDIR = "${vhosts}/${domain}/alice/.maildir"

    def doc_url(doc_id):
        return f"{COUCH}/mail/{urllib.parse.quote(doc_id, safe=str())}"

    def couch_put(doc_id, doc):
        machine.succeed(f"{doc_url(doc_id)} -X PUT -H 'Content-Type: application/json' -d '{json.dumps(doc)}'")

    def imap_login(user, password):
        # Prints the tagged LOGIN response
        script = (
            "import imaplib,sys\n"
            "m=imaplib.IMAP4('127.0.0.1')\n"
            "try:\n"
            f"  print(m.login({user!r},{password!r})[0])\n"
            "except imaplib.IMAP4.error as e:\n"
            "  print('NO', e)\n"
        )
        return machine.succeed(f"${pkgs.python3}/bin/python3 -c {shlex.quote(script)}").strip()

    def lmtp_deliver(rcpt, subject):
        script = (
            "import smtplib\n"
            "s=smtplib.LMTP('127.0.0.1',24)\n"
            f"s.sendmail('sender@other.test',[{rcpt!r}],'Subject: {subject}\\r\\n\\r\\nbody\\r\\n')\n"
            "s.quit()\n"
        )
        machine.succeed(f"${pkgs.python3}/bin/python3 -c {shlex.quote(script)}")

    machine.wait_for_unit("couchdb.service")
    machine.wait_until_succeeds(f"{COUCH}/_up")

    # Seed alice with a legacy {SSHA512} hash and a sieve script
    salt = os.urandom(8)
    ssha = base64.b64encode(hashlib.sha512(b"alicepass" + salt).digest() + salt).decode()
    machine.succeed(f"{COUCH}/mail -X PUT")
    couch_put("script-alice", {
        "script": 'require ["fileinto", "mailbox"];\nif header :contains "subject" "FILTERME" { fileinto :create "Filtered"; }\n',
    })
    couch_put("org.couchdb.user:alice@${domain}", {
        "name": "alice@${domain}", "type": "user", "roles": [],
        "dovecot_password": "{SSHA512}" + ssha,
        "sieve": {"main_script": "script-alice"},
    })

    machine.wait_for_unit("couchmail.service")
    machine.wait_for_unit("dovecot.service")
    machine.wait_for_open_port(40575)
    machine.wait_for_open_port(143)

    with subtest("token endpoint is loopback-only and checks the client secret"):
        machine.fail("ss -ltnH 'sport = :40575' | grep -v 127.0.0.1")
        out = machine.succeed("curl -s -o /dev/null -w '%{http_code}' -d grant_type=password -d username=alice@${domain} -d password=alicepass -d client_id=dovecot -d client_secret=wrong http://127.0.0.1:40575/token")
        assert out == "401", out

    with subtest("IMAP login goes through the OAuth2 password grant"):
        # Must be a real auth failure (penalties, fail2ban), not a temporary one
        for user, pw in [("alice@${domain}", "wrongpass"), ("nobody@${domain}", "alicepass")]:
            out = imap_login(user, pw)
            assert out.startswith("NO") and "AUTHENTICATIONFAILED" in out, f"{user}: {out}"
        assert imap_login("alice@${domain}", "alicepass") == "OK"
        machine.succeed("journalctl -u couchmail | grep 'OAuth2: granted token for alice@${domain}'")

    with subtest("legacy hash is migrated to bcrypt on first login"):
        machine.wait_until_succeeds(f"{doc_url('org.couchdb.user:alice@${domain}')} | grep -q CRYPT")
        assert imap_login("alice@${domain}", "alicepass") == "OK"

    with subtest("sieve script from CouchDB is applied on LMTP delivery"):
        lmtp_deliver("alice@${domain}", "hello")
        lmtp_deliver("alice@${domain}", "please FILTERME now")
        machine.wait_until_succeeds(f"ls {MAILDIR}/new | grep -q .")
        machine.wait_until_succeeds(f"ls {MAILDIR}/.Filtered/new | grep -q .")
        assert machine.succeed(f"ls {MAILDIR}/new | wc -l").strip() == "1"
        machine.succeed(f"grep -l FILTERME {MAILDIR}/.Filtered/new/*")
        machine.succeed("journalctl -u couchmail | grep 'looking up sieve for alice@${domain}'")

    with subtest("CouchDB outage is a temporary failure, not a wrong password"):
        # Kill rather than stop: stopping would also stop the bridge (Requires=)
        machine.succeed("systemctl kill -s KILL couchdb.service")
        machine.wait_until_fails(f"{COUCH}/_up")
        machine.succeed("systemctl is-active couchmail.service")
        out = imap_login("alice@${domain}", "alicepass")
        assert out.startswith("NO") and "UNAVAILABLE" in out, out
        machine.succeed("journalctl -u couchmail | grep 'OAuth2: credential check failed'")
        machine.systemctl("start couchdb.service")
        machine.wait_until_succeeds(f"{COUCH}/_up")
        assert imap_login("alice@${domain}", "alicepass") == "OK"
  '';
}
