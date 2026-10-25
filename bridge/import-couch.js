// One-time import of couchmail's CouchDB `mail` database into SQLite.
// Runs at bridge startup when COUCH_IMPORT is set and the SQLite database is
// still empty; everything happens in one transaction, so a failed import
// leaves nothing behind and the next start tries again. CouchDB is only read.
// `couchmail-ctl import-couchdb` runs the same import without the bridge.

const bcrypt = require('bcryptjs')
const { norm } = require('./store')

const USER_PREFIX = 'org.couchdb.user:'

// CouchDB connection from COUCH_* variables
function couchFromEnv(env) {
  if (!env.COUCH_PASSWORD) throw new Error('COUCH_PASSWORD is not set')
  return {
    host: env.COUCH_HOST || '127.0.0.1',
    port: parseInt(env.COUCH_PORT || '5984'),
    user: env.COUCH_USER || 'mail',
    password: env.COUCH_PASSWORD,
  }
}

async function fetchAllDocs({ host, port, user, password }) {
  const url = `http://${host}:${port}/mail/_all_docs?include_docs=true`
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` },
  }).catch(err => { throw new Error(`CouchDB at ${host}:${port}: ${err.cause?.message || err.message}`) })
  if (!res.ok) throw new Error(`CouchDB ${url.replace(/\?.*/, '')}: HTTP ${res.status}`)
  return (await res.json()).rows.map(r => r.doc).filter(Boolean)
}

// Classifies CouchDB docs the same way the old bridge and UI did
function classify(docs) {
  const byId = new Map(docs.map(d => [d._id, d]))
  const out = { domains: [], users: [], aliases: [], invites: [], byId }
  for (const doc of docs) {
    const id = doc._id
    if (id.startsWith('_design/')) continue
    else if (id.startsWith(USER_PREFIX)) out.users.push(doc)
    else if (id.startsWith('alias-')) out.aliases.push(doc)
    else if (id.startsWith('invite-')) out.invites.push(doc)
    else if (id.includes('.')) out.domains.push(doc)
    // Anything else is a sieve script, picked up through its user
  }
  return out
}

async function importFromCouch(store, couch, log = console.log) {
  const docs = await fetchAllDocs(couch)
  const { domains, users, aliases, invites, byId } = classify(docs)
  const stats = { domains: 0, users: 0, admins: 0, aliases: 0, invites: 0, sieve: 0 }
  const warn = msg => log(`Import: WARNING: ${msg}`)
  // A row the schema rejects is skipped with a warning rather than failing
  // the whole import, which would keep the bridge (and mail auth) down
  const tryRow = (what, fn) => {
    try { fn(); return true } catch (err) { warn(`skipping ${what}: ${err.message}`); return false }
  }

  store.transaction(() => {
    const db = store.db
    for (const doc of domains) {
      if (tryRow(`domain ${doc._id}`, () =>
        db.prepare('INSERT INTO domains (name) VALUES (?) ON CONFLICT DO NOTHING').run(norm(doc._id)))) stats.domains++
    }

    const seen = new Set()
    for (const doc of users) {
      const address = norm(doc.name || doc._id.slice(USER_PREFIX.length))
      if (!address.includes('@')) { warn(`skipping user ${doc._id}: not an email address`); continue }
      if (seen.has(address)) { warn(`skipping duplicate user ${doc._id}`); continue }
      seen.add(address)

      let hash = doc.dovecot_password || null
      if (!hash && doc.password) {
        // Created by the old admin page, which stored only a plaintext
        // password, so this account could never log in; honour what the
        // admin set rather than importing the plaintext
        hash = `{CRYPT}${bcrypt.hashSync(doc.password, 10)}`
        warn(`${address} had only a plaintext password; imported it as bcrypt`)
      }
      if (!hash) warn(`${address} has no password and can't log in until one is set`)

      const roles = doc.roles || []
      const isAdmin = roles.includes('admin') || roles.includes('_admin')
      const other = roles.filter(r => r !== 'admin' && r !== '_admin')
      if (other.length) warn(`${address}: dropping unknown roles ${other.join(', ')}`)

      if (!tryRow(`user ${doc._id}`, () =>
        db.prepare('INSERT INTO users (address, password_hash, is_admin) VALUES (?, ?, ?)')
          .run(address, hash, isAdmin ? 1 : 0))) continue
      stats.users++
      if (isAdmin) stats.admins++

      for (const [name, scriptId] of Object.entries(doc.sieve || {})) {
        const script = byId.get(scriptId)
        if (!script || typeof script.script !== 'string') {
          warn(`${address}: sieve script ${name} points at missing doc ${scriptId}`)
          continue
        }
        if (tryRow(`${address}'s sieve script ${name}`, () =>
          db.prepare('INSERT INTO sieve_scripts (user, name, script) VALUES (?, ?, ?)').run(address, name, script.script))) stats.sieve++
      }
    }

    for (const doc of aliases) {
      const address = norm(doc._id.slice('alias-'.length))
      const target = String(doc.target || '').trim()
      if (!target) { warn(`skipping alias ${address}: no target`); continue }
      if (tryRow(`alias ${doc._id}`, () =>
        db.prepare('INSERT INTO aliases (address, target, description) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
          .run(address, target, String(doc.description || '')))) stats.aliases++
    }

    for (const doc of invites) {
      const domain = norm(doc.domain)
      if (!store.hasDomain(domain)) { warn(`skipping invite for unknown domain ${domain}`); continue }
      if (tryRow(`invite ${doc._id}`, () =>
        db.prepare(`INSERT INTO invites (token, domain, created_by, created_at, used_by, used_at)
                    VALUES (?, ?, ?, coalesce(?, strftime('%Y-%m-%dT%H:%M:%fZ')), ?, ?)`)
          .run(doc._id.slice('invite-'.length), domain, doc.created_by || null, doc.created_at || null,
               doc.used_by ? norm(doc.used_by) : null, doc.used_at || null))) stats.invites++
    }

    store.setMeta('imported_from_couchdb', new Date().toISOString())
  })

  log(`Import: imported ${stats.domains} domains, ${stats.users} users (${stats.admins} admins), ` +
      `${stats.aliases} aliases, ${stats.invites} invites, ${stats.sieve} sieve scripts from CouchDB`)
  return stats
}

module.exports = { importFromCouch, couchFromEnv }
