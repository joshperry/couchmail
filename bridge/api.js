// Web API for the couchmail UI (served under /_couchmail/api/ by nginx).
//
// Permissions: a global admin manages everything; a domain admin manages the
// users, aliases and invites of the domains they're assigned; everyone else
// manages only their own password and sieve script. The session cookie only
// names the user, so permissions are read from the database on each request
// and take effect immediately.

const crypto = require('crypto')
const { Conflict, NotFound, Invalid, norm, domainOf } = require('./store')
const { verifyPassword, hashPassword } = require('./passwords')

class Forbidden extends Error {}
class Unauthorized extends Error {}

const SESSION_COOKIE = 'couchmail_session'
const SESSION_TTL = 24 * 60 * 60 // seconds
const MIN_PASSWORD = 8

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > limit) reject(new Invalid('Request too large'))
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function getCookieValue(req, name) {
  const header = req.headers.cookie || ''
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return match ? match[1] : null
}

function createApi(store) {
  const sessionKey = Buffer.from(store.meta('session_key'), 'hex')

  // ── Sessions ───────────────────────────────────────────────
  function makeSessionCookie(user) {
    const payload = Buffer.from(JSON.stringify({
      n: user.address,
      s: user.sessionEpoch,
      e: Math.floor(Date.now() / 1000) + SESSION_TTL,
    })).toString('base64url')
    const mac = crypto.createHmac('sha256', sessionKey).update(payload).digest('base64url')
    return `${payload}.${mac}`
  }

  // The logged-in user, or null if the cookie is missing, forged, expired,
  // or from before a password change
  function sessionUser(req) {
    const [payload, mac] = (getCookieValue(req, SESSION_COOKIE) || '').split('.')
    if (!payload || !mac) return null
    const expected = crypto.createHmac('sha256', sessionKey).update(payload).digest('base64url')
    if (mac.length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
    let session
    try {
      session = JSON.parse(Buffer.from(payload, 'base64url').toString())
    } catch { return null }
    if (!(session.e >= Math.floor(Date.now() / 1000))) return null
    const user = store.getUser(session.n)
    return user && user.sessionEpoch === session.s ? user : null
  }

  // ── Permissions ────────────────────────────────────────────
  // Domains the user may administer; null means all of them
  const scope = user => user.isAdmin ? null : user.adminDomains
  const canManageDomain = (user, domain) => user.isAdmin || user.adminDomains.includes(norm(domain))

  function requireAdmin(user) {
    if (!user.isAdmin) throw new Forbidden('Admins only')
  }
  function requireDomainAdmin(user) {
    if (!user.isAdmin && user.adminDomains.length === 0) throw new Forbidden('Admins only')
  }
  function requireDomain(user, domain) {
    if (!canManageDomain(user, domain)) throw new Forbidden(`You don't administer ${domain}`)
  }
  // Managing an account (password, deletion) needs its domain, and can't
  // reach anyone with rights the manager lacks: otherwise a domain admin
  // could take over a global admin, or the admin of another domain, who
  // happens to have an address in their domain
  function requireCanManageUser(user, address) {
    requireDomain(user, domainOf(address))
    const target = store.getUser(address)
    if (!target || user.isAdmin) return
    if (target.isAdmin || !target.adminDomains.every(d => canManageDomain(user, d))) {
      throw new Forbidden(`${target.address} has admin rights you don't`)
    }
  }

  function checkNewPassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
      throw new Invalid(`Password must be at least ${MIN_PASSWORD} characters`)
    }
  }

  const userCtx = user => ({
    name: user.address,
    roles: user.isAdmin ? ['admin'] : [],
    adminDomains: user.adminDomains,
  })

  // ── Routes ─────────────────────────────────────────────────
  // [method, path pattern, handler({ user, body, params, url, res })]
  // Handlers for routes not marked public get the session's user or a 401.
  const routes = []
  const route = (method, pattern, handler, opts = {}) => {
    const keys = []
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)' }) + '$')
    routes.push({ method, re, keys, handler, public: !!opts.public })
  }

  // Auth
  route('POST', '/auth/login', async ({ body, res }) => {
    const { name, password } = body
    if (!name || !password) throw new Invalid('name and password required')
    const user = await checkCredentials(store, name, password)
    if (!user) {
      console.log(`Auth: login failed for ${name}`)
      throw new Unauthorized('Invalid credentials')
    }
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${makeSessionCookie(user)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL}`)
    console.log(`Auth: login success for ${user.address}`)
    return { ok: true, ...userCtx(user) }
  }, { public: true })

  route('GET', '/auth/session', ({ req }) => {
    const user = sessionUser(req)
    return { userCtx: user ? userCtx(user) : { name: null, roles: [], adminDomains: [] } }
  }, { public: true })

  route('POST', '/auth/logout', ({ res }) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`)
    return { ok: true }
  }, { public: true })

  // The logged-in user's own account
  route('GET', '/me', ({ user }) => ({
    ...userCtx(user),
    domain: user.domain,
    aliases: store.aliasesFor(user.address),
  }))

  // Change a password: your own, or (as an admin) one in a domain you manage
  route('POST', '/password', async ({ user, body }) => {
    const target = norm(body.username || user.address)
    checkNewPassword(body.new_password)
    if (target !== user.address) requireCanManageUser(user, target)
    store.setPassword(target, await hashPassword(body.new_password))
    console.log(`Password: ${user.address} changed the password for ${target}`)
    return { ok: true }
  })

  // Registration by invite
  route('GET', '/register', ({ url }) => {
    const invite = store.getInvite(url.searchParams.get('token') || '')
    if (!invite) throw new NotFound('Invalid invite token')
    if (invite.used_by) throw new Conflict('Invite already used')
    return { ok: true, domain: invite.domain }
  }, { public: true })

  route('POST', '/register', async ({ body }) => {
    const { token, name, password } = body
    if (!token || !name || !password) throw new Invalid('token, name, and password required')
    checkNewPassword(password)
    store.redeemInvite(token, name, await hashPassword(password))
    console.log(`Register: ${norm(name)} registered via invite ${String(token).slice(0, 8)}…`)
    return { ok: true }
  }, { public: true })

  // The user's own sieve script
  route('GET', '/sieve', ({ user }) => {
    const s = store.getSieve(user.address, 'main_script')
    return s ? { script: s.script, version: s.version } : { script: '', version: null }
  })

  route('PUT', '/sieve', ({ user, body }) => {
    if (typeof body.script !== 'string') throw new Invalid('script is required')
    const version = store.putSieve(user.address, 'main_script', body.script, body.version ?? null)
    console.log(`Sieve: ${user.address} saved main_script (version ${version})`)
    return { ok: true, version }
  })

  // ── Admin: domains ─────────────────────────────────────────
  route('GET', '/admin/domains', ({ user }) => {
    requireDomainAdmin(user)
    return { domains: store.listDomains(scope(user)) }
  })

  route('POST', '/admin/domains', ({ user, body }) => {
    requireAdmin(user)
    store.createDomain(body.name)
    console.log(`Admin: ${user.address} added domain ${norm(body.name)}`)
    return { ok: true }
  })

  route('DELETE', '/admin/domains/:domain', ({ user, params }) => {
    requireAdmin(user)
    store.deleteDomain(params.domain)
    console.log(`Admin: ${user.address} removed domain ${params.domain}`)
    return { ok: true }
  })

  route('PUT', '/admin/domains/:domain/admins/:user', ({ user, params }) => {
    requireAdmin(user)
    store.addDomainAdmin(params.domain, params.user)
    console.log(`Admin: ${user.address} made ${params.user} an admin of ${params.domain}`)
    return { ok: true }
  })

  route('DELETE', '/admin/domains/:domain/admins/:user', ({ user, params }) => {
    requireAdmin(user)
    store.removeDomainAdmin(params.domain, params.user)
    console.log(`Admin: ${user.address} removed ${params.user} as admin of ${params.domain}`)
    return { ok: true }
  })

  // ── Admin: users ───────────────────────────────────────────
  route('GET', '/admin/users', ({ user }) => {
    requireDomainAdmin(user)
    return { users: store.listUsers(scope(user)) }
  })

  route('POST', '/admin/users', async ({ user, body }) => {
    const address = norm(body.address)
    requireDomain(user, domainOf(address))
    if (body.isAdmin) requireAdmin(user)
    if (!store.hasDomain(domainOf(address))) throw new Invalid(`${domainOf(address)} is not a mail domain`)
    checkNewPassword(body.password)
    store.createUser({ address, passwordHash: await hashPassword(body.password), isAdmin: !!body.isAdmin })
    console.log(`Admin: ${user.address} created user ${address}`)
    return { ok: true }
  })

  route('PATCH', '/admin/users/:address', ({ user, params, body }) => {
    requireAdmin(user)
    if (typeof body.isAdmin !== 'boolean') throw new Invalid('isAdmin must be true or false')
    if (norm(params.address) === user.address && !body.isAdmin) throw new Invalid("You can't remove your own admin role")
    store.setAdmin(params.address, body.isAdmin)
    console.log(`Admin: ${user.address} set admin=${body.isAdmin} for ${params.address}`)
    return { ok: true }
  })

  route('DELETE', '/admin/users/:address', ({ user, params }) => {
    const address = norm(params.address)
    if (address === user.address) throw new Invalid("You can't delete your own account")
    requireCanManageUser(user, address)
    store.deleteUser(address)
    console.log(`Admin: ${user.address} deleted user ${address}`)
    return { ok: true }
  })

  // ── Admin: aliases ─────────────────────────────────────────
  route('GET', '/admin/aliases', ({ user }) => {
    requireDomainAdmin(user)
    return { aliases: store.listAliases(scope(user)) }
  })

  route('POST', '/admin/aliases', ({ user, body }) => {
    const address = norm(body.address)
    requireDomain(user, domainOf(address))
    store.createAlias({ address, target: body.target, description: body.description })
    console.log(`Admin: ${user.address} created alias ${address}`)
    return { ok: true }
  })

  route('PUT', '/admin/aliases/:address', ({ user, params, body }) => {
    requireDomain(user, domainOf(norm(params.address)))
    store.updateAlias(params.address, { target: body.target, description: body.description })
    console.log(`Admin: ${user.address} updated alias ${params.address}`)
    return { ok: true }
  })

  route('DELETE', '/admin/aliases/:address', ({ user, params }) => {
    requireDomain(user, domainOf(norm(params.address)))
    store.deleteAlias(params.address)
    console.log(`Admin: ${user.address} deleted alias ${params.address}`)
    return { ok: true }
  })

  // ── Admin: invites ─────────────────────────────────────────
  route('GET', '/admin/invites', ({ user }) => {
    requireDomainAdmin(user)
    return { invites: store.listInvites(scope(user)) }
  })

  route('POST', '/admin/invites', ({ user, body }) => {
    requireDomain(user, body.domain)
    const token = store.createInvite(body.domain, user.address)
    console.log(`Admin: ${user.address} created an invite for ${norm(body.domain)}`)
    return { ok: true, token }
  })

  route('DELETE', '/admin/invites/:token', ({ user, params }) => {
    const invite = store.getInvite(params.token)
    if (!invite) throw new NotFound('No such invite')
    requireDomain(user, invite.domain)
    store.deleteInvite(params.token)
    return { ok: true }
  })

  // ── Dispatch ───────────────────────────────────────────────
  const STATUS = [[Invalid, 400], [Unauthorized, 401], [Forbidden, 403], [NotFound, 404], [Conflict, 409]]

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const reply = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }

    let matched = null, params = {}
    for (const r of routes) {
      const m = r.re.exec(url.pathname)
      if (!m) continue
      if (r.method !== req.method) { matched = matched || 'method'; continue }
      matched = r
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]) })
      break
    }
    if (!matched) return reply(404, { error: 'Not found' })
    if (matched === 'method') return reply(405, { error: 'Method not allowed' })

    try {
      let body = {}
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // POSTs must be JSON: browsers won't send that (or PUT/PATCH/DELETE)
        // cross-site without a CORS preflight, which backs up SameSite
        // against CSRF
        const json = /^application\/json\b/.test(req.headers['content-type'] || '')
        if (req.method === 'POST' && !json) throw new Invalid('Content-Type must be application/json')
        const text = await readBody(req)
        if (text) {
          if (!json) throw new Invalid('Content-Type must be application/json')
          try { body = JSON.parse(text) } catch { throw new Invalid('Invalid JSON') }
          if (!body || typeof body !== 'object') throw new Invalid('Invalid JSON')
        }
      }
      const user = matched.public ? null : sessionUser(req)
      if (!matched.public && !user) throw new Unauthorized('Not authenticated')
      reply(200, await matched.handler({ req, res, url, params, body, user }))
    } catch (err) {
      const status = (STATUS.find(([cls]) => err instanceof cls) || [])[1]
      if (status) return reply(status, { error: err.message })
      console.log(`API: ${req.method} ${url.pathname} failed: ${err.stack || err.message}`)
      reply(500, { error: 'Internal error' })
    }
  }
}

// Check a user's password. Resolves to the user on success or null on bad
// credentials; rejects if the database itself fails, so dovecot can report a
// temporary error instead of a wrong password. Legacy hashes are upgraded
// to bcrypt on a successful login.
async function checkCredentials(store, name, password) {
  const user = store.getUser(name)
  if (!user || !user.passwordHash) return null
  if (!await verifyPassword(password, user.passwordHash)) return null
  if (!/^\{(CRYPT|BLF-CRYPT)\}/.test(user.passwordHash)) {
    store.upgradePasswordHash(user.address, user.passwordHash, await hashPassword(password))
    console.log(`Auth: migrated ${user.address} password to bcrypt`)
  }
  return user
}

module.exports = { createApi, checkCredentials }
