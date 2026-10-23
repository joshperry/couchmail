# Couchmail

CouchDB-backed mail management for Postfix and Dovecot, with a web UI for account and filter administration.

## What it does

Couchmail stores virtual mail configuration (domains, users, aliases, sieve scripts) in a single CouchDB database and exposes it to mail services through protocol-specific interfaces:

- **Postfix** — TCP lookup tables for domains, mailboxes, and aliases
- **Dovecot** (2.4) — loopback HTTP for password checks (OAuth2 password grant) and loopback TCP for sieve scripts (Redis protocol)
- **Web UI** — Svelte SPA for users and admins, served by nginx

## Architecture

```
┌─────────────┐     ┌──────────────────────────────────────────────┐
│   Browser    │────▶│  nginx                                       │
│              │     │   /_couchmail/     → static UI files          │
│              │     │   /_couchmail/api/ → bridge HTTP (auth, API)  │
│              │     │   /mail/           → bridge CouchDB proxy     │
└─────────────┘     └──────────────────┬───────────────────────────┘
                                       │
┌─────────────┐     ┌──────────────────▼───────────────────────────┐
│   Postfix    │────▶│  bridge (server.js)                          │
│  TCP lookup  │     │   :40571 domains  :40572 mailboxes           │
│              │     │   :40573 aliases  :40574 HTTP                │
└─────────────┘     │   :40575 OAuth2 token (dovecot logins)       │
┌─────────────┐     │   :40576 sieve lookups (Redis protocol)      │
│   Dovecot   │────▶│   all loopback-only; dovecot authenticates   │
│ oauth2+redis│     │   with a shared client secret                │
└─────────────┘     └──────────────────┬───────────────────────────┘
                                       │
                    ┌──────────────────▼───────────────────────────┐
                    │  CouchDB (:5984)                              │
                    │   mail database — all docs in one place       │
                    └──────────────────────────────────────────────┘
```

### Data model

Everything lives in the `mail` database. Document types are distinguished by `_id` prefix:

| Prefix | Example | Purpose |
|--------|---------|---------|
| `org.couchdb.user:` | `org.couchdb.user:josh@6bit.com` | User account (auth, password, sieve ref) |
| `alias-` | `alias-info@6bit.com` | Email alias → target |
| `invite-` | `invite-a1b2c3d4e5f6...` | Registration invite token |
| *(bare domain)* | `6bit.com` | Virtual mail domain |
| *(hex id)* | `f47ac10b58cc4372...` | Sieve script body |

### Authentication flow

The bridge manages its own session cookies (HMAC-signed, 24h TTL). When proxying requests to CouchDB, it injects `X-Auth-CouchDB-*` proxy auth headers so CouchDB sees the user's identity and roles without exposing credentials to the browser.

## Web UI

Svelte SPA at `/_couchmail/`. Pages:

| Route | Access | Description |
|-------|--------|-------------|
| `#/login` | Public | Sign in |
| `#/register?token=` | Public | Create account via invite link |
| `#/dashboard` | User | Welcome, aliases pointing to you |
| `#/settings` | User | Change password |
| `#/sieve` | User | Visual sieve filter editor with raw mode |
| `#/admin/users` | Admin | Create/delete users |
| `#/admin/domains` | Admin | Add/remove virtual domains |
| `#/admin/aliases` | Admin | CRUD email aliases |
| `#/admin/invites` | Admin | Generate invite links, track usage |

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
    couchdbCredentialsFile = "/run/secrets/couchdb-env";  # COUCHDB_USER, COUCHDB_PASSWORD
    bridgePasswordFile = "/run/secrets/couchmail-env";    # COUCH_PASSWORD
    oauth2ClientSecretFile = "/run/secrets/couchmail-dovecot";  # random string
    nginx = {
      enable = true;
      virtualHost = "example.com";  # existing nginx vhost to add locations to
    };
  };
}
```

The module sets up:
- CouchDB with proxy auth and single-node config
- Bridge systemd service with postfix, dovecot and HTTP listeners (all TCP)
- Dovecot 2.4 `passdb oauth2`, dict-backed sieve scripts and the LMTP sieve plugin
- Postfix virtual lookup table config
- nginx locations for UI, API, and CouchDB proxy

The bridge shares no files or sockets with dovecot or CouchDB; everything
goes over loopback TCP. Your host's dovecot config still needs a userdb; a
static one needs `userdb_static_allow_all_users = yes`, since the oauth2
passdb can only check passwords, not answer existence lookups.

### Credentials files

**`couchdbCredentialsFile`** — sourced as environment:
```
COUCHDB_USER=admin
COUCHDB_PASSWORD=secret
```

**`bridgePasswordFile`** — sourced as environment:
```
COUCH_PASSWORD=bridge-password
```

The bridge authenticates to CouchDB as `mail` (a CouchDB admin created by the module). The `COUCH_PASSWORD` is the password for this admin account. The CouchDB proxy-auth secret is derived from it on both sides, so it needs no file of its own.

**`oauth2ClientSecretFile`** — a random string (e.g. `openssl rand -hex 32`) that dovecot uses to authenticate to the bridge, both for logins and for sieve lookups. Read by dovecot's config process and passed to the bridge as a systemd credential.

## File structure

```
bridge/
  server.js          Node.js bridge — postfix TCP, dovecot OAuth2 + sieve, HTTP API
  package.json

ui/
  src/
    App.svelte       Router, session management, nav
    lib/couch.js     CouchDB client (login, CRUD, allDocs)
    lib/sieve.js     Sieve script parser + compiler
    routes/          Page components

design/
  mail-validation.json   CouchDB validate_doc_update design doc

scripts/
  migrate-users.sh       One-time migration from old doc format

nix/
  module.nix         NixOS module
  bridge.nix         Bridge package (buildNpmPackage)
  ui.nix             UI package (Vite build)
```

## License

MIT
