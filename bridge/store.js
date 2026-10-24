// SQLite storage for couchmail. The bridge is the only process that opens
// this database; postfix, dovecot and the web UI all go through the bridge.
//
// Addresses and domains are stored lowercase. A user's or alias's domain is
// derived from its address rather than a foreign key, so a mailbox can exist
// for a domain that isn't (or is no longer) accepted for delivery, exactly as
// it could in CouchDB. Writes through the API check the domain exists.

const { DatabaseSync } = require('node:sqlite')
const crypto = require('crypto')

const SCHEMA_VERSION = 1

const SCHEMA = `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  -- Domains postfix accepts mail for (virtual_mailbox_domains)
  CREATE TABLE domains (
    name TEXT PRIMARY KEY CHECK (name = lower(name) AND name <> ''),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
  ) STRICT;

  CREATE TABLE users (
    address TEXT PRIMARY KEY CHECK (address = lower(address) AND instr(address, '@') > 1),
    domain TEXT NOT NULL GENERATED ALWAYS AS (substr(address, instr(address, '@') + 1)) VIRTUAL,
    -- Dovecot-style scheme-prefixed hash, e.g. {CRYPT}$2a$...; NULL can't log in
    password_hash TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
    -- Bumped on password change; sessions carry it so old ones stop working
    session_epoch INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ'))
  ) STRICT;
  CREATE INDEX users_domain ON users (domain);

  -- Which domains a user administers (users, aliases and invites there)
  CREATE TABLE domain_admins (
    user TEXT NOT NULL REFERENCES users (address) ON DELETE CASCADE ON UPDATE CASCADE,
    domain TEXT NOT NULL REFERENCES domains (name) ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY (user, domain)
  ) STRICT;

  -- virtual_alias_maps; address may be a catch-all like @example.com
  CREATE TABLE aliases (
    address TEXT PRIMARY KEY CHECK (address = lower(address) AND instr(address, '@') > 0),
    domain TEXT NOT NULL GENERATED ALWAYS AS (substr(address, instr(address, '@') + 1)) VIRTUAL,
    target TEXT NOT NULL CHECK (target <> ''),
    description TEXT NOT NULL DEFAULT ''
  ) STRICT;
  CREATE INDEX aliases_domain ON aliases (domain);

  CREATE TABLE invites (
    token TEXT PRIMARY KEY,
    domain TEXT NOT NULL REFERENCES domains (name) ON DELETE CASCADE ON UPDATE CASCADE,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ')),
    used_by TEXT,
    used_at TEXT
  ) STRICT;

  -- Dovecot looks scripts up by name, then fetches by "<id>+<version>", and
  -- caches the compiled script under that ID, so version changes on update
  CREATE TABLE sieve_scripts (
    id INTEGER PRIMARY KEY,
    user TEXT NOT NULL REFERENCES users (address) ON DELETE CASCADE ON UPDATE CASCADE,
    name TEXT NOT NULL,
    script TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    UNIQUE (user, name)
  ) STRICT;
`

class Conflict extends Error {}
class NotFound extends Error {}
class Invalid extends Error {}

const norm = s => String(s || '').trim().toLowerCase()
const domainOf = address => address.slice(address.indexOf('@') + 1)
const isAddress = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)
const isDomain = s => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(s)

function open(path) {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')

  const version = db.prepare('PRAGMA user_version').get().user_version
  if (version === 0) {
    transaction(db, () => {
      db.exec(SCHEMA)
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
        .run('session_key', crypto.randomBytes(32).toString('hex'))
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    })
  } else if (version > SCHEMA_VERSION) {
    throw new Error(`database schema ${version} is newer than this bridge (${SCHEMA_VERSION})`)
  }
  return new Store(db)
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

// SQLite constraint errors carry their message in err.message
function mapConstraint(err, messages) {
  if (err.code === 'ERR_SQLITE_ERROR' && /constraint failed/.test(err.message)) {
    if (/UNIQUE|PRIMARY KEY/.test(err.message)) throw new Conflict(messages.unique || 'Already exists')
    if (/FOREIGN KEY/.test(err.message)) throw new Invalid(messages.foreign || 'Unknown reference')
    throw new Invalid(messages.check || 'Invalid value')
  }
  throw err
}

class Store {
  constructor(db) {
    this.db = db
    this.q = {}
  }

  // Cached prepared statements
  stmt(sql) {
    return this.q[sql] || (this.q[sql] = this.db.prepare(sql))
  }

  transaction(fn) { return transaction(this.db, fn) }

  meta(key) {
    const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key)
    return row ? row.value : null
  }

  setMeta(key, value) {
    this.stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  isEmpty() {
    return !this.stmt(`SELECT 1 FROM domains UNION ALL SELECT 1 FROM users
                       UNION ALL SELECT 1 FROM aliases LIMIT 1`).get()
  }

  // ── Postfix lookups ────────────────────────────────────────
  hasDomain(name) {
    return !!this.stmt('SELECT 1 FROM domains WHERE name = ?').get(norm(name))
  }

  hasUser(address) {
    return !!this.stmt('SELECT 1 FROM users WHERE address = ?').get(norm(address))
  }

  aliasTarget(address) {
    const row = this.stmt('SELECT target FROM aliases WHERE address = ?').get(norm(address))
    return row ? row.target : null
  }

  // ── Users ──────────────────────────────────────────────────
  getUser(address) {
    const row = this.stmt(`SELECT address, domain, password_hash, is_admin, session_epoch
                           FROM users WHERE address = ?`).get(norm(address))
    if (!row) return null
    return {
      address: row.address,
      domain: row.domain,
      passwordHash: row.password_hash,
      isAdmin: row.is_admin === 1,
      sessionEpoch: row.session_epoch,
      adminDomains: this.adminDomains(row.address),
    }
  }

  adminDomains(address) {
    return this.stmt('SELECT domain FROM domain_admins WHERE user = ? ORDER BY domain')
      .all(norm(address)).map(r => r.domain)
  }

  // Users in the given domains (null = all), with their domain-admin grants
  listUsers(domains) {
    const rows = domains
      ? this.stmt(`SELECT address, domain, is_admin, password_hash IS NOT NULL AS has_password
                   FROM users WHERE domain IN (SELECT value FROM json_each(?)) ORDER BY domain, address`)
          .all(JSON.stringify(domains))
      : this.stmt(`SELECT address, domain, is_admin, password_hash IS NOT NULL AS has_password
                   FROM users ORDER BY domain, address`).all()
    return rows.map(r => ({
      address: r.address,
      domain: r.domain,
      isAdmin: r.is_admin === 1,
      hasPassword: r.has_password === 1,
      adminDomains: this.adminDomains(r.address),
    }))
  }

  createUser({ address, passwordHash, isAdmin = false }) {
    address = norm(address)
    if (!isAddress(address)) throw new Invalid('Invalid email address')
    try {
      this.stmt('INSERT INTO users (address, password_hash, is_admin) VALUES (?, ?, ?)')
        .run(address, passwordHash, isAdmin ? 1 : 0)
    } catch (err) {
      mapConstraint(err, { unique: 'Account already exists' })
    }
  }

  // Changing the password also ends the user's existing web sessions
  setPassword(address, passwordHash) {
    const r = this.stmt('UPDATE users SET password_hash = ?, session_epoch = session_epoch + 1 WHERE address = ?')
      .run(passwordHash, norm(address))
    if (r.changes === 0) throw new NotFound('No such user')
  }

  // Rehash after a legacy-scheme login; keeps sessions
  upgradePasswordHash(address, oldHash, newHash) {
    this.stmt('UPDATE users SET password_hash = ? WHERE address = ? AND password_hash = ?')
      .run(newHash, norm(address), oldHash)
  }

  setAdmin(address, isAdmin) {
    const r = this.stmt('UPDATE users SET is_admin = ? WHERE address = ?').run(isAdmin ? 1 : 0, norm(address))
    if (r.changes === 0) throw new NotFound('No such user')
  }

  deleteUser(address) {
    const r = this.stmt('DELETE FROM users WHERE address = ?').run(norm(address))
    if (r.changes === 0) throw new NotFound('No such user')
  }

  // ── Domains ────────────────────────────────────────────────
  listDomains(domains) {
    const sql = `SELECT d.name,
                   (SELECT count(*) FROM users u WHERE u.domain = d.name) AS users,
                   (SELECT count(*) FROM aliases a WHERE a.domain = d.name) AS aliases,
                   (SELECT json_group_array(user) FROM domain_admins da WHERE da.domain = d.name) AS admins
                 FROM domains d`
    const rows = domains
      ? this.stmt(`${sql} WHERE d.name IN (SELECT value FROM json_each(?)) ORDER BY d.name`).all(JSON.stringify(domains))
      : this.stmt(`${sql} ORDER BY d.name`).all()
    return rows.map(r => ({ name: r.name, users: r.users, aliases: r.aliases, admins: JSON.parse(r.admins) }))
  }

  createDomain(name) {
    name = norm(name)
    if (!isDomain(name)) throw new Invalid('Invalid domain name')
    try {
      this.stmt('INSERT INTO domains (name) VALUES (?)').run(name)
    } catch (err) {
      mapConstraint(err, { unique: 'Domain already exists' })
    }
  }

  // Refuses while mailboxes or aliases remain, so mail isn't silently dropped
  deleteDomain(name) {
    name = norm(name)
    return this.transaction(() => {
      const busy = this.stmt(`SELECT (SELECT count(*) FROM users WHERE domain = ?) +
                                     (SELECT count(*) FROM aliases WHERE domain = ?) AS n`).get(name, name).n
      if (busy) throw new Conflict('Domain still has users or aliases')
      const r = this.stmt('DELETE FROM domains WHERE name = ?').run(name)
      if (r.changes === 0) throw new NotFound('No such domain')
    })
  }

  addDomainAdmin(domain, user) {
    try {
      this.stmt('INSERT INTO domain_admins (user, domain) VALUES (?, ?) ON CONFLICT DO NOTHING')
        .run(norm(user), norm(domain))
    } catch (err) {
      mapConstraint(err, { foreign: 'No such user or domain' })
    }
  }

  removeDomainAdmin(domain, user) {
    const r = this.stmt('DELETE FROM domain_admins WHERE user = ? AND domain = ?').run(norm(user), norm(domain))
    if (r.changes === 0) throw new NotFound('Not a domain admin')
  }

  // ── Aliases ────────────────────────────────────────────────
  listAliases(domains) {
    return domains
      ? this.stmt(`SELECT address, domain, target, description FROM aliases
                   WHERE domain IN (SELECT value FROM json_each(?)) ORDER BY domain, address`)
          .all(JSON.stringify(domains)).map(r => ({ ...r }))
      : this.stmt('SELECT address, domain, target, description FROM aliases ORDER BY domain, address')
          .all().map(r => ({ ...r }))
  }

  // Aliases delivering to this address (target may be a comma-separated list)
  aliasesFor(address) {
    address = norm(address)
    return this.stmt('SELECT address, target, description FROM aliases ORDER BY address').all()
      .filter(r => r.target.split(',').some(t => norm(t) === address))
      .map(r => ({ address: r.address, description: r.description }))
  }

  createAlias({ address, target, description = '' }) {
    address = norm(address)
    target = String(target || '').trim()
    if (!/^[^@\s]*@[^@\s]+\.[^@\s]+$/.test(address)) throw new Invalid('Invalid alias address')
    if (!target) throw new Invalid('Target is required')
    try {
      this.stmt('INSERT INTO aliases (address, target, description) VALUES (?, ?, ?)')
        .run(address, target, String(description || '').trim())
    } catch (err) {
      mapConstraint(err, { unique: 'Alias already exists' })
    }
  }

  updateAlias(address, { target, description = '' }) {
    target = String(target || '').trim()
    if (!target) throw new Invalid('Target is required')
    const r = this.stmt('UPDATE aliases SET target = ?, description = ? WHERE address = ?')
      .run(target, String(description || '').trim(), norm(address))
    if (r.changes === 0) throw new NotFound('No such alias')
  }

  deleteAlias(address) {
    const r = this.stmt('DELETE FROM aliases WHERE address = ?').run(norm(address))
    if (r.changes === 0) throw new NotFound('No such alias')
  }

  // ── Invites ────────────────────────────────────────────────
  listInvites(domains) {
    const cols = 'token, domain, created_by, created_at, used_by, used_at'
    return (domains
      ? this.stmt(`SELECT ${cols} FROM invites WHERE domain IN (SELECT value FROM json_each(?))
                   ORDER BY created_at DESC`).all(JSON.stringify(domains))
      : this.stmt(`SELECT ${cols} FROM invites ORDER BY created_at DESC`).all()
    ).map(r => ({ ...r }))
  }

  getInvite(token) {
    const row = this.stmt('SELECT token, domain, used_by FROM invites WHERE token = ?').get(String(token))
    return row ? { ...row } : null
  }

  createInvite(domain, createdBy) {
    const token = crypto.randomBytes(16).toString('hex')
    try {
      this.stmt('INSERT INTO invites (token, domain, created_by) VALUES (?, ?, ?)').run(token, norm(domain), createdBy)
    } catch (err) {
      mapConstraint(err, { foreign: 'No such domain' })
    }
    return token
  }

  deleteInvite(token) {
    const r = this.stmt('DELETE FROM invites WHERE token = ?').run(String(token))
    if (r.changes === 0) throw new NotFound('No such invite')
  }

  // Creates the user and marks the invite used in one transaction, so an
  // invite can't be redeemed twice
  redeemInvite(token, address, passwordHash) {
    address = norm(address)
    return this.transaction(() => {
      const invite = this.getInvite(token)
      if (!invite) throw new NotFound('Invalid invite token')
      if (invite.used_by) throw new Conflict('Invite already used')
      if (domainOf(address) !== invite.domain) throw new Invalid(`Email must end with @${invite.domain}`)
      this.createUser({ address, passwordHash })
      this.stmt(`UPDATE invites SET used_by = ?, used_at = strftime('%Y-%m-%dT%H:%M:%fZ') WHERE token = ?`)
        .run(address, invite.token)
    })
  }

  // ── Sieve ──────────────────────────────────────────────────
  getSieve(user, name) {
    const row = this.stmt('SELECT id, script, version FROM sieve_scripts WHERE user = ? AND name = ?')
      .get(norm(user), name)
    return row ? { id: row.id, script: row.script, version: row.version } : null
  }

  getSieveById(user, id) {
    const row = this.stmt('SELECT script FROM sieve_scripts WHERE user = ? AND id = ?').get(norm(user), id)
    return row ? row.script : null
  }

  // version is the one the caller last saw (null for a new script); a stale
  // version means someone else saved in between
  putSieve(user, name, script, version) {
    user = norm(user)
    return this.transaction(() => {
      const current = this.getSieve(user, name)
      if ((current ? current.version : null) !== (version ?? null)) throw new Conflict('Script was changed elsewhere; reload')
      if (current) {
        this.stmt('UPDATE sieve_scripts SET script = ?, version = version + 1 WHERE id = ?').run(script, current.id)
        return current.version + 1
      }
      try {
        this.stmt('INSERT INTO sieve_scripts (user, name, script) VALUES (?, ?, ?)').run(user, name, script)
      } catch (err) {
        mapConstraint(err, { foreign: 'No such user' })
      }
      return 1
    })
  }

  // ── Backup ─────────────────────────────────────────────────
  dump() {
    const all = sql => this.db.prepare(sql).all().map(r => ({ ...r }))
    return {
      schema: SCHEMA_VERSION,
      domains: all('SELECT name, created_at FROM domains ORDER BY name'),
      users: all('SELECT address, password_hash, is_admin, created_at FROM users ORDER BY address'),
      domain_admins: all('SELECT user, domain FROM domain_admins ORDER BY domain, user'),
      aliases: all('SELECT address, target, description FROM aliases ORDER BY address'),
      invites: all('SELECT token, domain, created_by, created_at, used_by, used_at FROM invites ORDER BY created_at'),
      sieve_scripts: all('SELECT user, name, script, version FROM sieve_scripts ORDER BY user, name'),
    }
  }
}

module.exports = { open, Conflict, NotFound, Invalid, norm, domainOf, isAddress, isDomain }
