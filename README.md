# Couchmail

Mail management for Postfix and Dovecot, with a web UI for account and filter administration. (The name is historical: it began on CouchDB and now keeps its data in SQLite.)

## What it does

A single bridge process owns the virtual mail configuration (domains, users, aliases, invites, sieve scripts) in a SQLite database and is the one place everything authenticates against:

- **Postfix** — TCP lookup tables for domains, mailboxes, and aliases
- **Dovecot** (2.4) — loopback HTTP for password checks (OAuth2 password grant) and loopback TCP for sieve scripts (Redis protocol)
- **Web UI** — Svelte SPA for users and admins, served by nginx, talking to the bridge's JSON API

## Architecture

```
┌─────────────┐     ┌──────────────────────────────────────────────┐
│   Browser    │────▶│  nginx                                       │
│              │     │   /_couchmail/     → static UI files          │
│              │     │   /_couchmail/api/ → bridge HTTP (auth, API)  │
└─────────────┘     └──────────────────┬───────────────────────────┘
                                       │
┌─────────────┐     ┌──────────────────▼───────────────────────────┐
│   Postfix    │────▶│  bridge (server.js)                          │
│  TCP lookup  │     │   :40571 domains  :40572 mailboxes           │
│              │     │   :40573 aliases  :40574 HTTP API            │
└─────────────┘     │   :40575 OAuth2 token (dovecot logins)       │
┌─────────────┐     │   :40576 sieve lookups (Redis protocol)      │
│   Dovecot   │────▶│   all loopback-only; dovecot authenticates   │
│ oauth2+redis│     │   with a shared client secret                │
└─────────────┘     └──────────────────┬───────────────────────────┘
                                       │ in-process
                    ┌──────────────────▼───────────────────────────┐
                    │  SQLite: /var/lib/couchmail/couchmail.db      │
                    │   opened only by the bridge (and couchmail-ctl)│
                    └──────────────────────────────────────────────┘
```

### Data model

See `bridge/store.js` for the schema. Addresses and domains are stored lowercase.

| Table | Purpose |
|-------|---------|
| `domains` | Domains postfix accepts mail for |
| `users` | Mailboxes: dovecot-style password hash, global admin flag |
| `domain_admins` | Which users administer which domains |
| `aliases` | `virtual_alias_maps`; targets may be comma-separated, `@domain` catch-alls allowed |
| `invites` | Registration tokens, one per new account |
| `sieve_scripts` | Each user's scripts (dovecot reads `main_script`), versioned |

### Permissions

- **Users** change their own password and sieve script.
- **Domain admins** manage the users, aliases and invites of the domains they're assigned, but can't touch accounts that hold rights they lack (global admins, or admins of other domains).
- **Global admins** manage everything, including domains and who administers them.

The session cookie (HMAC-signed, 24h, `Secure; HttpOnly; SameSite=Strict`) only names the user; rights are read from the database on every request, so revoking them takes effect immediately, and changing a password ends that user's other sessions. API writes must be JSON, which browsers won't send cross-site without a CORS preflight.

## Web UI

Svelte SPA at `/_couchmail/`. Pages:

| Route | Access | Description |
|-------|--------|-------------|
| `#/login` | Public | Sign in |
| `#/register?token=` | Public | Create account via invite link |
| `#/dashboard` | User | Welcome, aliases pointing to you |
| `#/settings` | User | Change password |
| `#/sieve` | User | Visual sieve filter editor with raw mode |
| `#/admin/users` | Domain admin | Create/delete users, set passwords, global admin role |
| `#/admin/domains` | Domain admin | Domains; global admins add/remove them and assign domain admins |
| `#/admin/aliases` | Domain admin | CRUD email aliases |
| `#/admin/invites` | Domain admin | Generate invite links, track usage |

## NixOS module

Import and configure in your flake:

```nix
{
  inputs.couchmail.url = "github:joshperry/couchmail";

  # In your nixosSystem:
  imports = [ couchmail.nixosModules.default ];

  services.couchmail = {
    enable = true;
    domain = "example.com";
    oauth2ClientSecretFile = "/run/secrets/couchmail-dovecot";  # random string
    nginx = {
      enable = true;
      virtualHost = "example.com";  # existing nginx vhost to add locations to
    };
  };
}
```

The module sets up:
- The bridge systemd service (state in `/var/lib/couchmail`), with postfix, dovecot and HTTP listeners (all loopback TCP)
- Dovecot 2.4 `passdb oauth2`, dict-backed sieve scripts and the LMTP sieve plugin
- Postfix virtual lookup table config
- nginx locations for the UI and API
- `couchmail-ctl` for bootstrapping and maintenance

The bridge shares no files or sockets with dovecot; everything goes over
loopback TCP. Your host's dovecot config still needs a userdb; a static one
needs `userdb_static_allow_all_users = yes`, since the oauth2 passdb can only
check passwords, not answer existence lookups.

**`oauth2ClientSecretFile`** — a random string (e.g. `openssl rand -hex 32`) that dovecot uses to authenticate to the bridge, both for logins and for sieve lookups. Read by dovecot's config process and passed to the bridge as a systemd credential.

### First run

```sh
sudo -u couchmail couchmail-ctl add-domain example.com
sudo -u couchmail couchmail-ctl add-user you@example.com --admin   # password on stdin
```

Then sign in at `https://example.com/_couchmail/`. `couchmail-ctl dump` prints everything as JSON (password hashes included) for backups; `sqlite3 /var/lib/couchmail/couchmail.db .backup ...` works too.

### Moving from CouchDB

Hosts that ran the CouchDB version import it once:

```nix
services.couchmail.importFromCouchdb = {
  enable = true;
  credentialsFile = "/run/secrets/couchdb-env";     # COUCHDB_USER, COUCHDB_PASSWORD
  bridgePasswordFile = "/run/secrets/couchmail-env"; # COUCH_PASSWORD
};
```

On its first start with an empty database the bridge copies the `mail` database into SQLite in one transaction, logs `Import: imported ...` (and a warning for anything odd), and only then starts listening. CouchDB is only read. Once the import has run, turn the option off and switch again: CouchDB stops, and its data stays where it was as a fallback. Plaintext `password` fields the old UI stored are not imported; an account that had only a plaintext password gets it as a bcrypt hash.

## File structure

```
bridge/
  server.js          Listeners: postfix TCP, dovecot OAuth2 + sieve, HTTP API
  api.js             Web API routes and permissions
  store.js           SQLite schema and queries
  passwords.js       Dovecot password schemes, bcrypt hashing
  import-couch.js    One-time import from CouchDB
  ctl.js             couchmail-ctl admin CLI
  package.json

ui/
  src/
    App.svelte       Router, session management, nav
    lib/api.js       Bridge API client
    lib/sieve.js     Sieve script parser + compiler
    routes/          Page components

nix/
  module.nix         NixOS module
  test.nix           VM test (import, dovecot, postfix, API permissions)
  bridge.nix         Bridge package (buildNpmPackage)
  ui.nix             UI package (Vite build)
```

## License

MIT
