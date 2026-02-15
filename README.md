# Couchmail

CouchDB-backed mail management for Postfix and Dovecot, with a web UI for account and filter administration.

## What it does

Couchmail stores virtual mail configuration (domains, users, aliases, sieve scripts) in a single CouchDB database and exposes it to mail services through protocol-specific interfaces:

- **Postfix** — TCP lookup tables for domains, mailboxes, and aliases
- **Dovecot** — Unix socket for password authentication and sieve script retrieval
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
└─────────────┘     │   unix socket: dovecot auth + sieve          │
                    └──────────────────┬───────────────────────────┘
┌─────────────┐                       │
│   Dovecot   │────▶  (unix socket)   │
│  dict proxy │                       │
└─────────────┘     ┌─────────────────▼────────────────────────────┐
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
    nginx = {
      enable = true;
      virtualHost = "example.com";  # existing nginx vhost to add locations to
    };
  };
}
```

The module sets up:
- CouchDB with proxy auth and single-node config
- Bridge systemd service with dovecot socket and postfix TCP listeners
- Dovecot dict auth and sieve plugin config
- Postfix virtual lookup table config
- nginx locations for UI, API, and CouchDB proxy
- Proxy auth secret generation and persistence

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

The bridge authenticates to CouchDB as `mail` (a CouchDB admin created by the module). The `COUCH_PASSWORD` is the password for this admin account.

## File structure

```
bridge/
  server.js          Node.js bridge — postfix TCP, dovecot unix socket, HTTP API
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
