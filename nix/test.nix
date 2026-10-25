# End-to-end test: couchmail bridge (SQLite) + Dovecot 2.4, starting from a
# CouchDB `mail` database that the bridge imports once. Every check after
# the import runs with CouchDB stopped. Covers the import, OAuth2
# password-grant auth (incl. legacy hash migration), sieve over the bridge's
# Redis endpoint, postfix lookups, and the web API's permission model.
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

  nodes.machine = { config, lib, ... }: {
    imports = [ flake.nixosModules.default ];

    virtualisation.memorySize = 2048;

    services.couchmail = {
      enable = true;
      inherit domain;
      oauth2ClientSecretFile = "${secrets}/oauth2-secret";
      importFromCouchdb = {
        enable = true;
        credentialsFile = "${secrets}/couchdb.env";
        bridgePasswordFile = "${secrets}/bridge.env";
      };
    };
    # Started by the test once CouchDB has been seeded
    systemd.services.couchmail.wantedBy = lib.mkForce [ ];

    # The follow-up deploy: import done, CouchDB gone
    specialisation.imported.configuration = {
      services.couchmail.importFromCouchdb.enable = lib.mkForce false;
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
    API = "http://127.0.0.1:40574"
    DB = "/var/lib/couchmail/couchmail.db"
    MAILDIR = "${vhosts}/${domain}/alice/.maildir"

    def couch_put(doc_id, doc):
        url = f"{COUCH}/mail/{urllib.parse.quote(doc_id, safe=str())}"
        machine.succeed(f"{url} -X PUT -H 'Content-Type: application/json' -d {shlex.quote(json.dumps(doc))}")

    def ssha512(password):
        salt = os.urandom(8)
        return "{SSHA512}" + base64.b64encode(hashlib.sha512(password.encode() + salt).digest() + salt).decode()

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

    def postfix_get(port, key):
        script = (
            "import socket,sys\n"
            f"s=socket.create_connection(('127.0.0.1',{port}))\n"
            f"s.sendall(b'get {key}\\n')\n"
            "sys.stdout.write(s.makefile().readline())\n"
        )
        return machine.succeed(f"${pkgs.python3}/bin/python3 -c {shlex.quote(script)}").strip()

    def ctl(*args, stdin=None):
        cmd = "runuser -u couchmail -- couchmail-ctl " + " ".join(shlex.quote(a) for a in args)
        if stdin is not None:
            cmd = f"printf %s {shlex.quote(stdin)} | {cmd}"
        return machine.succeed(cmd)

    # Web API helpers. Cookies are passed by hand: the session cookie is
    # Secure, so curl's cookie jar wouldn't send it over plain HTTP.
    def login(user, password):
        out = machine.succeed(
            f"curl -s -D - -o /dev/null -H 'Content-Type: application/json' "
            f"-d {shlex.quote(json.dumps({'name': user, 'password': password}))} {API}/auth/login"
        )
        for line in out.splitlines():
            if line.lower().startswith("set-cookie:"):
                return line.split(":", 1)[1].split(";")[0].strip()
        raise Exception(f"login failed for {user}: {out}")

    def api(cookie, method, path, body=None):
        # Returns (status, json)
        cmd = f"curl -s -w '\\n%{{http_code}}' -X {method} -b {shlex.quote(cookie)} {API}{path}"
        if body is not None:
            cmd += f" -H 'Content-Type: application/json' -d {shlex.quote(json.dumps(body))}"
        out = machine.succeed(cmd).rsplit("\n", 1)
        return int(out[1]), json.loads(out[0])

    machine.wait_for_unit("couchdb.service")
    machine.wait_until_succeeds(f"{COUCH}/_up")

    # Seed CouchDB the way the old couchmail stored things
    machine.succeed(f"{COUCH}/mail -X PUT")
    couch_put("${domain}", {})
    couch_put("script-alice", {
        "script": 'require ["fileinto", "mailbox"];\nif header :contains "subject" "FILTERME" { fileinto :create "Filtered"; }\n',
    })
    couch_put("org.couchdb.user:alice@${domain}", {
        "name": "alice@${domain}", "type": "user", "roles": [],
        "dovecot_password": ssha512("alicepass"),
        "password": "alicepass",
        "sieve": {"main_script": "script-alice"},
    })
    couch_put("org.couchdb.user:root@${domain}", {
        "name": "root@${domain}", "type": "user", "roles": ["admin"],
        "dovecot_password": ssha512("rootpass1"),
    })
    # Made by the old admin page: plaintext only, so it could never log in
    couch_put("org.couchdb.user:bob@${domain}", {
        "name": "bob@${domain}", "type": "user", "roles": [],
        "password": "bobpass12", "dovecot_password": str(),
    })
    couch_put("alias-info@${domain}", {"target": "alice@${domain}", "description": "General"})
    # Junk the schema rejects is skipped, not fatal
    couch_put("alias-nonsense", {"target": "alice@${domain}"})
    couch_put("invite-abc123", {"domain": "${domain}", "created_by": "root@${domain}",
                                "created_at": "2026-01-01T00:00:00.000Z", "used_by": None, "used_at": None})

    with subtest("import dry run touches neither CouchDB nor the bridge's database"):
        out = machine.succeed("cd /tmp && couchmail-ctl import-couchdb --couch-env ${secrets}/bridge.env 2>&1")
        assert "Import: imported 1 domains, 3 users (1 admins), 1 aliases, 1 invites, 1 sieve scripts" in out, out
        assert "user   root@${domain}  [admin]" in out, out
        assert "Dry run: nothing was written" in out, out
        machine.fail(f"test -e {DB}")
        machine.succeed("couchmail-ctl import-couchdb --couch-env ${secrets}/bridge.env --into /tmp/trial.db")
        machine.succeed("DB_PATH=/tmp/trial.db couchmail-ctl list | grep -q 'alias  info@${domain}'")
        machine.fail("couchmail-ctl import-couchdb --couch-env ${secrets}/bridge.env --into /tmp/trial.db")
        machine.fail(f"test -e {DB}")

    with subtest("bridge imports CouchDB once, then runs without it"):
        machine.systemctl("start couchmail.service")
        machine.wait_for_open_port(40575)
        machine.succeed("journalctl -u couchmail | grep 'Import: imported 1 domains, 3 users (1 admins), 1 aliases, 1 invites, 1 sieve scripts'")
        machine.succeed("journalctl -u couchmail | grep 'bob@${domain} had only a plaintext password'")
        machine.succeed("journalctl -u couchmail | grep 'skipping alias alias-nonsense'")
        # Switch to the config without the import, as a host would next
        machine.succeed("/run/current-system/specialisation/imported/bin/switch-to-configuration test")
        machine.fail("systemctl is-active couchdb.service")
        machine.systemctl("restart couchmail.service")
        machine.wait_for_open_port(40575)
        machine.succeed("systemctl is-active couchmail.service")
        machine.fail("systemctl is-active couchdb.service")
        machine.fail("systemctl show -p Environment couchmail.service | grep COUCH")
        # Plaintext passwords stayed behind in CouchDB
        machine.fail(f"grep -a -e alicepass -e bobpass12 {DB}*")
        machine.succeed("stat -c %a /var/lib/couchmail | grep -x 700")

    machine.wait_for_unit("dovecot.service")
    machine.wait_for_open_port(143)

    with subtest("postfix lookups"):
        assert postfix_get(40571, "${domain}") == "200 OK"
        assert postfix_get(40571, "nope.test") == "500 Not Found"
        assert postfix_get(40572, "Alice@${domain}") == "200 alice@${domain}"
        assert postfix_get(40572, "nobody@${domain}") == "500 Not Found"
        assert postfix_get(40573, "info%40${domain}") == "200 alice@${domain}"

    with subtest("token endpoint is loopback-only and checks the client secret"):
        machine.fail("curl -sf -d 'grant_type=password&client_id=dovecot&client_secret=wrong&username=alice@${domain}&password=alicepass' http://127.0.0.1:40575/token")
        machine.succeed("curl -sf -d 'grant_type=password&client_id=dovecot&client_secret=test-client-secret&username=alice@${domain}&password=alicepass' http://127.0.0.1:40575/token | grep -q access_token")

    with subtest("IMAP login goes through the OAuth2 password grant"):
        assert imap_login("alice@${domain}", "alicepass") == "OK"
        out = imap_login("alice@${domain}", "wrongpass")
        assert out.startswith("NO") and "AUTHENTICATIONFAILED" in out, out
        assert imap_login("bob@${domain}", "bobpass12") == "OK"

    with subtest("legacy hash is migrated to bcrypt on first login"):
        users = {u["address"]: u for u in json.loads(ctl("dump"))["users"]}
        assert users["alice@${domain}"]["password_hash"].startswith("{CRYPT}"), users
        assert users["root@${domain}"]["password_hash"].startswith("{SSHA512}"), users
        machine.succeed("journalctl -u couchmail | grep 'Auth: migrated alice@${domain} password to bcrypt'")

    with subtest("sieve script is applied on LMTP delivery"):
        lmtp_deliver("alice@${domain}", "FILTERME please")
        machine.wait_until_succeeds(f"ls {MAILDIR}/.Filtered/new | grep -q .", timeout=60)
        machine.succeed(f"grep -l FILTERME {MAILDIR}/.Filtered/new/*")
        machine.succeed("journalctl -u couchmail | grep 'Sieve: looking up name main_script for alice@${domain}'")

    with subtest("bridge has no filesystem links and listens on loopback only"):
        machine.fail("ss -xlpn | grep -i -e couchmail -e node")
        machine.fail("test -e /run/couchmail")
        machine.fail("test -e /run/couchmail-secrets")
        listening = machine.succeed("ss -ltnH 'sport >= :40571 and sport <= :40576'").split()
        local = {f for f in listening if ":4057" in f and not f.endswith(":*")}
        assert local == {f"127.0.0.1:{p}" for p in range(40571, 40577)}, listening

    with subtest("sieve lookups require dovecot's secret"):
        def resp(*cmds):
            script = (
                "import socket,sys,time\n"
                "def enc(a): return b'*%d\\r\\n' % len(a) + bytes().join(b'$%d\\r\\n%s\\r\\n' % (len(x), x) for x in a)\n"
                "s=socket.create_connection(('127.0.0.1',40576))\n"
                f"cmds={[[a.encode() for a in c] for c in cmds]!r}\n"
                "s.sendall(bytes().join(enc(c) for c in cmds))\n"
                "time.sleep(1)\n"
                "sys.stdout.write(s.recv(65536).decode())\n"
            )
            return machine.succeed(f"${pkgs.python3}/bin/python3 -c {shlex.quote(script)}").split("\r\n")
        key = "alice@${domain}/sieve/name/main_script"
        out = resp(["GET", key])
        assert out[0].startswith("-NOAUTH"), out
        out = resp(["AUTH", "wrong"], ["GET", key])
        assert out[0] == "-WRONGPASS invalid password" and out[1].startswith("-NOAUTH"), out
        out = resp(["AUTH", "test-client-secret"], ["GET", key], ["GET", "nobody@${domain}/sieve/name/main_script"])
        assert out[0] == "+OK" and out[1].startswith("$") and out[3] == "$-1", out
        # A script ID only resolves for its owner
        out = resp(["AUTH", "test-client-secret"], ["GET", f"bob@${domain}/sieve/data/{out[2]}"])
        assert out[1] == "$-1", out

    with subtest("couchmail-ctl manages the database as the couchmail user"):
        ctl("add-domain", "other.test")
        ctl("add-user", "carol@other.test", stdin="carolpass")
        machine.fail("runuser -u couchmail -- couchmail-ctl add-user x@unknown.test </dev/null")
        assert "carol@other.test" in ctl("list")
        assert imap_login("carol@other.test", "carolpass") == "OK"

    with subtest("web API enforces global and domain admin rights"):
        root = login("root@${domain}", "rootpass1")
        status, _ = api(root, "PUT", "/admin/domains/${domain}/admins/bob@${domain}")
        assert status == 200
        bob = login("bob@${domain}", "bobpass12")
        alice = login("alice@${domain}", "alicepass")

        status, body = api(bob, "GET", "/admin/users")
        assert status == 200 and {u["domain"] for u in body["users"]} == {"${domain}"}, body
        status, body = api(root, "GET", "/admin/users")
        assert {u["domain"] for u in body["users"]} == {"${domain}", "other.test"}, body
        assert api(alice, "GET", "/admin/users")[0] == 403

        # Domain admins manage their own domain only
        assert api(bob, "POST", "/admin/aliases", {"address": "sales@${domain}", "target": "bob@${domain}"})[0] == 200
        assert postfix_get(40573, "sales@${domain}") == "200 bob@${domain}"
        assert api(bob, "POST", "/admin/aliases", {"address": "sales@other.test", "target": "bob@${domain}"})[0] == 403
        assert api(bob, "POST", "/admin/users", {"address": "dave@other.test", "password": "davepass1"})[0] == 403
        assert api(bob, "POST", "/admin/users", {"address": "dave@${domain}", "password": "davepass1", "isAdmin": True})[0] == 403
        assert api(bob, "POST", "/admin/users", {"address": "dave@${domain}", "password": "davepass1"})[0] == 200
        assert imap_login("dave@${domain}", "davepass1") == "OK"
        assert api(bob, "POST", "/admin/domains", {"name": "evil.test"})[0] == 403

        # ...and can't take over accounts with more rights than they have
        assert api(bob, "POST", "/password", {"username": "root@${domain}", "new_password": "pwned123"})[0] == 403
        assert api(bob, "DELETE", "/admin/users/root@${domain}")[0] == 403
        assert api(bob, "POST", "/password", {"username": "dave@${domain}", "new_password": "davepass2"})[0] == 200
        assert imap_login("dave@${domain}", "davepass2") == "OK"

        # Revoking domain admin takes effect without logging out
        assert api(root, "DELETE", "/admin/domains/${domain}/admins/bob@${domain}")[0] == 200
        assert api(bob, "GET", "/admin/users")[0] == 403

        # Cross-site form posts are refused
        out = machine.succeed(f"curl -s -o /dev/null -w '%{{http_code}}' -b {shlex.quote(root)} -d 'domain=${domain}' {API}/admin/invites")
        assert out == "400", out

    with subtest("invites, sieve editing and sessions"):
        status, body = api("x=y", "GET", "/register?token=abc123")
        assert status == 200 and body["domain"] == "${domain}", body
        assert api("x=y", "POST", "/register", {"token": "abc123", "name": "erin@other.test", "password": "erinpass1"})[0] == 400
        assert api("x=y", "POST", "/register", {"token": "abc123", "name": "erin@${domain}", "password": "erinpass1"})[0] == 200
        assert api("x=y", "POST", "/register", {"token": "abc123", "name": "fred@${domain}", "password": "fredpass1"})[0] == 409
        assert imap_login("erin@${domain}", "erinpass1") == "OK"

        status, body = api(alice, "GET", "/sieve")
        assert status == 200 and "FILTERME" in body["script"] and body["version"] == 1, body
        new = 'require ["fileinto", "mailbox"];\nif header :contains "subject" "SORTME" { fileinto :create "Sorted"; }\n'
        assert api(alice, "PUT", "/sieve", {"script": new, "version": 1})[0] == 200
        assert api(alice, "PUT", "/sieve", {"script": new, "version": 1})[0] == 409
        lmtp_deliver("alice@${domain}", "SORTME now")
        machine.wait_until_succeeds(f"ls {MAILDIR}/.Sorted/new | grep -q .", timeout=60)

        status, body = api(alice, "GET", "/me")
        assert body["aliases"] == [{"address": "info@${domain}", "description": "General"}], body

        # Changing a password ends existing sessions
        assert api(alice, "POST", "/password", {"new_password": "alicepass2"})[0] == 200
        assert api(alice, "GET", "/me")[0] == 401
        assert imap_login("alice@${domain}", "alicepass2") == "OK"
  '';
}
