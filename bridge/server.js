const net = require('net'),
      http = require('http'),
      fs = require('fs'),
      crypto = require('crypto'),
      events = require('events'),
      util = require('util'),
      carrier = require('carrier'),
      bcrypt = require('bcryptjs')

const USER_PREFIX = 'org.couchdb.user:'

const dbuser = process.env.COUCH_USER,
      dbpass = process.env.COUCH_PASSWORD,
      dbhost = process.env.COUCH_HOST
      dburl = `http://${dbhost}:5984/mail`
      db = require('nano')({
        url: dburl,
        requestDefaults: {
          headers: {
            Authorization: `Basic ${Buffer.from(`${dbuser}:${dbpass}`).toString('base64')}`,
          },
        },
      })

// ── Proxy auth secret ────────────────────────────────────────
// Derived from the bridge's CouchDB password; couchdb's ExecStartPre derives
// the same value for its local.ini, so nothing is shared through the
// filesystem. The `mail` user is a CouchDB admin, so anyone holding the
// password could already act as any user; the hash can't be reversed.
const proxySecret = dbpass
  ? crypto.createHash('sha256').update(`couchmail-proxy-secret:${dbpass}`).digest('hex')
  : ''

const SESSION_COOKIE = 'couchmail_session'
const SESSION_TTL = 24 * 60 * 60 // 24 hours in seconds

// ── Session cookie helpers ───────────────────────────────────
function makeSessionCookie(name, roles) {
  const payload = JSON.stringify({
    n: name,
    r: roles,
    e: Math.floor(Date.now() / 1000) + SESSION_TTL
  })
  const encoded = Buffer.from(payload).toString('base64')
  const hmac = crypto.createHmac('sha256', proxySecret).update(encoded).digest('hex')
  return `${encoded}.${hmac}`
}

function parseSessionCookie(cookie) {
  if (!cookie) return null
  const [encoded, hmac] = cookie.split('.')
  if (!encoded || !hmac) return null
  const expected = crypto.createHmac('sha256', proxySecret).update(encoded).digest('hex')
  if (!crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(expected, 'hex'))) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString())
    if (payload.e < Math.floor(Date.now() / 1000)) return null
    return { name: payload.n, roles: payload.r }
  } catch { return null }
}

function getCookieValue(req, name) {
  const header = req.headers.cookie || ''
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return match ? match[1] : null
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

// ── Dovecot password verification ────────────────────────────
// Supports {CRYPT} (bcrypt), {SSHA512}, {SSHA256}, {SHA512}, {SHA256},
// and unprefixed (default_pass_scheme, typically SSHA512).
// Async so bcrypt doesn't block the event loop (postfix lookups share it).
async function verifyDovecotPassword(password, stored) {
  // {CRYPT} prefix — bcrypt
  if (stored.startsWith('{CRYPT}')) {
    return bcrypt.compare(password, stored.slice(7))
  }
  // {BLF-CRYPT} prefix — also bcrypt
  if (stored.startsWith('{BLF-CRYPT}')) {
    return bcrypt.compare(password, stored.slice(11))
  }

  // Extract scheme from {SCHEME}hash or use default (SSHA512)
  let scheme = 'SSHA512'
  let hash = stored
  const schemeMatch = stored.match(/^\{([^}]+)\}(.*)$/)
  if (schemeMatch) {
    scheme = schemeMatch[1].toUpperCase()
    hash = schemeMatch[2]
  }

  const buf = Buffer.from(hash, 'base64')

  switch (scheme) {
    case 'SSHA512': {
      const digest = buf.slice(0, 64)
      const salt = buf.slice(64)
      const computed = crypto.createHash('sha512').update(password).update(salt).digest()
      return crypto.timingSafeEqual(digest, computed)
    }
    case 'SSHA256': {
      const digest = buf.slice(0, 32)
      const salt = buf.slice(32)
      const computed = crypto.createHash('sha256').update(password).update(salt).digest()
      return crypto.timingSafeEqual(digest, computed)
    }
    case 'SHA512': {
      const computed = crypto.createHash('sha512').update(password).digest()
      return crypto.timingSafeEqual(buf, computed)
    }
    case 'SHA256': {
      const computed = crypto.createHash('sha256').update(password).digest()
      return crypto.timingSafeEqual(buf, computed)
    }
    default:
      console.log(`Auth: unsupported password scheme: ${scheme}`)
      return false
  }
}

// Check a user's password against CouchDB. Resolves to the user doc on
// success or null on bad credentials; rejects if CouchDB itself fails, so
// callers can report a temporary error instead of a wrong password.
async function checkCredentials(name, password) {
  let doc
  try {
    doc = await db.get(USER_PREFIX + name)
  } catch (err) {
    if (err.statusCode === 404) return null
    throw err
  }
  if (!doc.dovecot_password) return null
  if (!await verifyDovecotPassword(password, doc.dovecot_password)) return null

  // Migrate legacy password hashes to bcrypt on successful login
  if (!doc.dovecot_password.startsWith('{CRYPT}') && !doc.dovecot_password.startsWith('{BLF-CRYPT}')) {
    const salt = bcrypt.genSaltSync(10)
    doc.dovecot_password = `{CRYPT}${bcrypt.hashSync(password, salt)}`
    db.insert(doc).then(() => {
      console.log(`Auth: migrated ${name} password to bcrypt`)
    }).catch(err => {
      console.log(`Auth: failed to migrate ${name} password: ${err.message}`)
    })
  }
  return doc
}

// ── CouchDB proxy auth token ────────────────────────────────
function makeCouchProxyToken(username) {
  return crypto.createHmac('sha256', proxySecret).update(username).digest('hex')
}

// This function returns a generalized handler for a postfix request (domain, alias, or mailbox)
let clientId = 0
const postfixHandler = (serviceName, getHandler) => {
  // Fail if no handler provided
  if(!getHandler) {
    console.log('postfix: ERROR, no handler provided!')
    process.exit(1)
  }

  return client => {
    // Next client
    clientId++

    const service = `${serviceName}(${clientId})`
    console.log(`${service}: Postfix client connected`)
    client.on('end', () => console.log(`${service}: Postfix client disconnected`))

    carrier.carry(client, null, 'ascii')
      .on('line', line => {
        // Make sure this is a get request and that it has a parameter
        line = line.toLowerCase()
        const tokens = line.split(' ')
        if(tokens.length == 2 && tokens[0] == 'get') {
          // Unescape the parameter value
          const reqval = decodeURIComponent(tokens[1])
          console.log(`${service}: Got get request ${reqval}`)

          // Have the subclass do its lookup
          getHandler(reqval).then(respval => {
            if(respval) {
              console.log(`${service}: responding with ${respval}`)
              client.write(`200 ${respval}\n`)
            } else {
              console.log(`${service}: responding with Not Found`)
              client.write('500 Not Found\n')
            }
          })
        } else {
          console.log(`${service}: got an unknow request line (${line})`)
          client.write('400 Unknown or unsupported request type\n')
        }
      })
      .on('end', function() {
        client.end()
      })
  }
}

// Postfix handler specialized for finding domains
const domainHandler = () =>
  postfixHandler('domain', (domain, callback) =>
    db.get(domain)
      .then(body => 'OK')
      .catch(err => {
        console.log(`domain lookup err ${err.message}`)
        return ''
      })
  )

// Postfix handler specialized for finding mailboxes
const mailboxHandler = () =>
  postfixHandler('mailbox', (username, callback) =>
    db.get(USER_PREFIX + username)
      .then(body => username)
      .catch(err => {
        console.log(`mailbox lookup err ${err.message}`)
        return ''
      })
  )

// Postfix handler specialized for finding aliases
const aliasHandler = () =>
  postfixHandler('alias', (alias, callback) =>
    db.get(`alias-${alias}`)
      .then(body => body.target)
      .catch(err => {
        console.log(`alias lookup err ${err.message}`)
        return ''
      })
  )

// Looks up a user's sieve script for dovecot. `kind` is "name" (returns a
// data ID for the named script) or "data" (returns the script for an ID).
// Resolves to null when there is no such script; rejects on CouchDB errors.
async function sieveLookup(user, kind, id) {
  const get = docId => db.get(docId).catch(err => {
    if (err.statusCode === 404) return null
    throw err
  })
  if (kind === 'name') {
    const userDoc = await get(USER_PREFIX + user)
    const scriptId = userDoc && userDoc.sieve && userDoc.sieve[id]
    const script = scriptId && await get(scriptId)
    // Dovecot caches the compiled script by this ID, so include the rev
    return script ? `${script._id}+${script._rev}` : null
  }
  if (kind === 'data') {
    const script = await get(id.split('+')[0])
    return script ? script.script : null
  }
  return null
}

// Parses one RESP command (array of bulk strings) from buf.
// Returns { args, used } or null if more data is needed; throws if malformed.
function parseRespCommand(buf) {
  const readLine = from => {
    const end = buf.indexOf('\r\n', from)
    return end < 0 ? null : { line: buf.toString('latin1', from, end), next: end + 2 }
  }
  const head = readLine(0)
  if (!head) return null
  if (head.line[0] !== '*') throw new Error(`expected array, got ${JSON.stringify(head.line)}`)
  const count = parseInt(head.line.slice(1), 10)
  if (!(count > 0 && count <= 16)) throw new Error('bad array length')
  const args = []
  let pos = head.next
  for (let i = 0; i < count; i++) {
    const len = readLine(pos)
    if (!len) return null
    if (len.line[0] !== '$') throw new Error('expected bulk string')
    const n = parseInt(len.line.slice(1), 10)
    if (!(n >= 0 && n <= 65536)) throw new Error('bad bulk length')
    if (buf.length < len.next + n + 2) return null
    args.push(buf.toString('utf8', len.next, len.next + n))
    pos = len.next + n + 2
  }
  return { args, used: pos }
}

const respBulk = value => {
  if (value == null) return '$-1\r\n'
  const data = Buffer.from(value, 'utf8')
  return Buffer.concat([Buffer.from(`$${data.length}\r\n`), data, Buffer.from('\r\n')])
}

// Serves dovecot's sieve lookups by speaking the subset of the Redis protocol
// its redis dict driver uses (AUTH, GET), so dovecot reaches the bridge over
// loopback TCP rather than a shared unix socket. Keys look like
// <user>/sieve/name/<script> and <user>/sieve/data/<id>.
const sieveHandler = client => {
  let buf = Buffer.alloc(0)
  let authed = false
  let replies = Promise.resolve() // keep replies in request order

  const handle = async args => {
    const cmd = args[0].toUpperCase()
    if (cmd === 'AUTH') {
      authed = args.length === 2 && secretMatches(args[1])
      if (!authed) console.log('Sieve: rejected connection with bad password')
      return authed ? '+OK\r\n' : '-WRONGPASS invalid password\r\n'
    }
    if (cmd === 'PING') return '+PONG\r\n'
    if (!authed) return '-NOAUTH Authentication required.\r\n'
    if (cmd !== 'GET' || args.length !== 2) return '-ERR unsupported command\r\n'

    const m = args[1].match(/^(.+)\/sieve\/(name|data)\/(.+)$/)
    if (!m) return respBulk(null)
    const [, user, kind, id] = m
    console.log(`Sieve: looking up ${kind} ${id} for ${user}`)
    try {
      return respBulk(await sieveLookup(user, kind, id))
    } catch (err) {
      console.log(`Sieve: lookup failed for ${user}: ${err.message}`)
      return '-ERR lookup failed\r\n'
    }
  }

  client.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    try {
      let parsed
      while ((parsed = parseRespCommand(buf))) {
        buf = buf.subarray(parsed.used)
        const reply = handle(parsed.args)
        replies = replies.then(() => reply).then(out => client.write(out))
      }
    } catch (err) {
      console.log(`Sieve: protocol error: ${err.message}`)
      client.destroy()
    }
  })
  client.on('error', err => console.log(`Sieve: connection error: ${err.message}`))
}

// ── HTTP server (auth + password + CouchDB proxy) ────────────
const passwordPort = parseInt(process.env.PASSWORD_PORT || '40574')
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  // ── Auth: login ──────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/auth/login') {
    res.setHeader('Content-Type', 'application/json')
    try {
      const { name, password } = JSON.parse(await readBody(req))
      if (!name || !password) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'name and password required' }))
        return
      }

      const doc = await checkCredentials(name, password)
      if (!doc) {
        res.writeHead(401)
        res.end(JSON.stringify({ error: 'Invalid credentials' }))
        return
      }

      const roles = doc.roles || []
      const cookie = makeSessionCookie(name, roles)
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}`)
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, name, roles }))
      console.log(`Auth: login success for ${name}`)
    } catch (err) {
      console.log(`Auth: login error ${err.message}`)
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'Internal error' }))
    }
    return
  }

  // ── Auth: session check ──────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/auth/session') {
    res.setHeader('Content-Type', 'application/json')
    const session = parseSessionCookie(getCookieValue(req, SESSION_COOKIE))
    if (session) {
      res.writeHead(200)
      res.end(JSON.stringify({ userCtx: { name: session.name, roles: session.roles } }))
    } else {
      res.writeHead(200)
      res.end(JSON.stringify({ userCtx: { name: null, roles: [] } }))
    }
    return
  }

  // ── Auth: logout ─────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`)
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // ── Password change ──────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/password') {
    res.setHeader('Content-Type', 'application/json')
    try {
      const { username, new_password } = JSON.parse(await readBody(req))
      if (!username || !new_password) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'username and new_password required' }))
        return
      }

      // Verify caller is the same user or an admin
      const session = parseSessionCookie(getCookieValue(req, SESSION_COOKIE))
      if (!session || (session.name !== username && !(session.roles || []).includes('admin'))) {
        res.writeHead(403)
        res.end(JSON.stringify({ error: 'Forbidden' }))
        return
      }

      const docId = USER_PREFIX + username
      const doc = await db.get(docId)

      // Hash for dovecot (bcrypt)
      const salt = bcrypt.genSaltSync(10)
      const hash = bcrypt.hashSync(new_password, salt)
      doc.dovecot_password = `{CRYPT}${hash}`

      // Set plaintext password — CouchDB hashes it on next write for cookie auth
      doc.password = new_password

      await db.insert(doc)
      console.log(`Password: updated both passwords for ${username}`)
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      console.log(`Password: error ${err.message}`)
      res.writeHead(err.statusCode || 500)
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // ── Register (invite-based) ────────────────────────────
  if (req.method === 'GET' && url.pathname === '/register') {
    res.setHeader('Content-Type', 'application/json')
    const token = url.searchParams.get('token')
    if (!token) {
      res.writeHead(400)
      res.end(JSON.stringify({ error: 'token is required' }))
      return
    }
    try {
      const invite = await db.get(`invite-${token}`).catch(() => null)
      if (!invite) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'Invalid invite token' }))
        return
      }
      if (invite.used_by) {
        res.writeHead(409)
        res.end(JSON.stringify({ error: 'Invite already used' }))
        return
      }
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, domain: invite.domain }))
    } catch (err) {
      res.writeHead(500)
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  if (req.method === 'POST' && url.pathname === '/register') {
    res.setHeader('Content-Type', 'application/json')
    try {
      const { token, name, password } = JSON.parse(await readBody(req))
      if (!token || !name || !password) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'token, name, and password required' }))
        return
      }

      // Look up invite
      const inviteId = `invite-${token}`
      const invite = await db.get(inviteId).catch(() => null)
      if (!invite) {
        res.writeHead(404)
        res.end(JSON.stringify({ error: 'Invalid invite token' }))
        return
      }
      if (invite.used_by) {
        res.writeHead(409)
        res.end(JSON.stringify({ error: 'Invite already used' }))
        return
      }

      // Verify email matches invite domain
      const domain = invite.domain
      if (!name.endsWith('@' + domain)) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: `Email must end with @${domain}` }))
        return
      }

      // Check user doesn't already exist
      const existing = await db.get(USER_PREFIX + name).catch(() => null)
      if (existing) {
        res.writeHead(409)
        res.end(JSON.stringify({ error: 'Account already exists' }))
        return
      }

      // Create user with bcrypt dovecot_password
      const salt = bcrypt.genSaltSync(10)
      const dovecotHash = `{CRYPT}${bcrypt.hashSync(password, salt)}`
      await db.insert({
        _id: USER_PREFIX + name,
        name,
        type: 'user',
        roles: [],
        password,
        dovecot_password: dovecotHash
      })

      // Mark invite as used
      invite.used_by = name
      invite.used_at = new Date().toISOString()
      await db.insert(invite)

      console.log(`Register: ${name} registered via invite ${token}`)
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true }))
    } catch (err) {
      console.log(`Register: error ${err.message}`)
      res.writeHead(err.statusCode || 500)
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // ── Sieve script (user's own) ─────────────────────────
  if (req.method === 'GET' && url.pathname === '/sieve') {
    res.setHeader('Content-Type', 'application/json')
    const session = parseSessionCookie(getCookieValue(req, SESSION_COOKIE))
    if (!session) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: 'Not authenticated' }))
      return
    }
    try {
      const userDoc = await db.get(USER_PREFIX + session.name)
      const scriptId = userDoc.sieve && userDoc.sieve.main_script
      if (!scriptId) {
        res.writeHead(200)
        res.end(JSON.stringify({ script: '', scriptId: null, scriptRev: null }))
        return
      }
      const scriptDoc = await db.get(scriptId)
      res.writeHead(200)
      res.end(JSON.stringify({ script: scriptDoc.script, scriptId: scriptDoc._id, scriptRev: scriptDoc._rev }))
    } catch (err) {
      console.log(`Sieve GET: error ${err.message}`)
      res.writeHead(err.statusCode || 500)
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  if (req.method === 'PUT' && url.pathname === '/sieve') {
    res.setHeader('Content-Type', 'application/json')
    const session = parseSessionCookie(getCookieValue(req, SESSION_COOKIE))
    if (!session) {
      res.writeHead(401)
      res.end(JSON.stringify({ error: 'Not authenticated' }))
      return
    }
    try {
      const { script, scriptId, scriptRev } = JSON.parse(await readBody(req))
      if (typeof script !== 'string') {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'script is required' }))
        return
      }

      const userDoc = await db.get(USER_PREFIX + session.name)
      let docId = scriptId || (userDoc.sieve && userDoc.sieve.main_script)
      let result

      if (docId) {
        // Update existing script doc
        result = await db.insert({ _id: docId, _rev: scriptRev, script })
      } else {
        // Create new script doc with random ID
        docId = crypto.randomBytes(16).toString('hex')
        result = await db.insert({ _id: docId, script })
        // Update user doc with sieve reference
        userDoc.sieve = { main_script: docId }
        await db.insert(userDoc)
      }

      console.log(`Sieve PUT: updated script for ${session.name}`)
      res.writeHead(200)
      res.end(JSON.stringify({ ok: true, scriptId: docId, scriptRev: result.rev }))
    } catch (err) {
      console.log(`Sieve PUT: error ${err.message}`)
      res.writeHead(err.statusCode || 500)
      res.end(JSON.stringify({ error: err.message }))
    }
    return
  }

  // ── CouchDB proxy ───────────────────────────────────────
  if (url.pathname.startsWith('/couch/')) {
    const couchPath = '/' + url.pathname.slice('/couch/'.length) + url.search
    const session = parseSessionCookie(getCookieValue(req, SESSION_COOKIE))

    const headers = { ...req.headers }
    delete headers.host
    delete headers.cookie

    if (session && proxySecret) {
      headers['X-Auth-CouchDB-UserName'] = session.name
      headers['X-Auth-CouchDB-Roles'] = session.roles.join(',')
      headers['X-Auth-CouchDB-Token'] = makeCouchProxyToken(session.name)
    }

    const proxyReq = http.request({
      hostname: '127.0.0.1',
      port: 5984,
      path: couchPath,
      method: req.method,
      headers
    }, proxyRes => {
      // Remove CouchDB's own Set-Cookie (we manage sessions)
      const resHeaders = { ...proxyRes.headers }
      delete resHeaders['set-cookie']
      res.writeHead(proxyRes.statusCode, resHeaders)
      proxyRes.pipe(res)
    })

    proxyReq.on('error', err => {
      console.log(`Proxy: error ${err.message}`)
      res.writeHead(502)
      res.end(JSON.stringify({ error: 'CouchDB unavailable' }))
    })

    req.pipe(proxyReq)
    return
  }

  // ── 404 ──────────────────────────────────────────────────
  res.setHeader('Content-Type', 'application/json')
  res.writeHead(404)
  res.end(JSON.stringify({ error: 'Not found' }))
})
httpServer.listen(passwordPort, '127.0.0.1', () => {
  console.log(`HTTP: listening on 127.0.0.1:${passwordPort}`)
})

console.log('Creating TCP listeners')
net.createServer(domainHandler())
  .on('error', err => console.log(err))
  .listen(40571)
net.createServer(mailboxHandler())
  .on('error', err => console.log(err))
  .listen(40572)
net.createServer(aliasHandler())
  .on('error', err => console.log(err))
  .listen(40573)

// ── Dovecot OAuth2 password grant ────────────────────────────
// Dovecot's oauth2 passdb POSTs the user's credentials here (RFC 6749
// password grant) and the bridge checks them, so password hashes never leave
// the bridge. Separate loopback-only listener: the main HTTP port is proxied
// by nginx and must never serve this.
const oauthPort = parseInt(process.env.OAUTH2_PORT || '40575')
const oauthClientId = process.env.OAUTH2_CLIENT_ID || 'dovecot'
const oauthSecretFile = process.env.OAUTH2_CLIENT_SECRET_FILE ||
  (process.env.CREDENTIALS_DIRECTORY && `${process.env.CREDENTIALS_DIRECTORY}/oauth2-client-secret`)
let oauthClientSecret = ''
if (oauthSecretFile) {
  try {
    oauthClientSecret = fs.readFileSync(oauthSecretFile, 'utf8').trim()
  } catch (err) {
    console.log(`OAuth2: could not read ${oauthSecretFile}: ${err.message}`)
  }
}

// Tokens only have to survive from the grant to dovecot's introspection
// call, so a per-process key and a short lifetime are enough.
const OAUTH_TOKEN_TTL = 60
const oauthTokenKey = crypto.randomBytes(32)

function makeAccessToken(name) {
  const payload = Buffer.from(JSON.stringify({
    u: name,
    e: Math.floor(Date.now() / 1000) + OAUTH_TOKEN_TTL
  })).toString('base64url')
  const mac = crypto.createHmac('sha256', oauthTokenKey).update(payload).digest('base64url')
  return `${payload}.${mac}`
}

function parseAccessToken(token) {
  const [payload, mac] = (token || '').split('.')
  if (!payload || !mac) return null
  const expected = crypto.createHmac('sha256', oauthTokenKey).update(payload).digest('base64url')
  if (mac.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null
  try {
    const { u, e } = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return e >= Math.floor(Date.now() / 1000) ? u : null
  } catch { return null }
}

// Compare HMACs so the comparison is constant-time regardless of length.
// Dovecot reads `oauth2_client_secret = <file` verbatim, trailing newline
// included, so ignore surrounding whitespace like we do for our own copy.
function secretMatches(given) {
  const h = s => crypto.createHmac('sha256', oauthTokenKey).update((s || '').trim()).digest()
  return crypto.timingSafeEqual(h(given), h(oauthClientSecret))
}

const oauthServer = http.createServer(async (req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const url = new URL(req.url, 'http://localhost')
  if (req.method !== 'POST') return reply(405, { error: 'invalid_request' })

  let form
  try {
    form = new URLSearchParams(await readBody(req))
  } catch {
    return reply(400, { error: 'invalid_request' })
  }

  // ── Token: password grant ──────────────────────────────────
  if (url.pathname === '/token') {
    if (form.get('client_id') !== oauthClientId || !secretMatches(form.get('client_secret'))) {
      console.log('OAuth2: rejected token request with bad client credentials')
      return reply(401, { error: 'invalid_client' })
    }
    if (form.get('grant_type') !== 'password') {
      return reply(400, { error: 'unsupported_grant_type' })
    }
    const name = form.get('username'), password = form.get('password')
    if (!name || !password) return reply(400, { error: 'invalid_request' })

    try {
      if (!await checkCredentials(name, password)) {
        console.log(`OAuth2: invalid credentials for ${name}`)
        // RFC 6749 says 400 invalid_grant, but Dovecot 2.4.5 reports any
        // grant error as a temporary failure (db_oauth2_lookup_passwd_grant
        // checks result->error before its invalid_grant case), which skips
        // auth penalties and confuses clients. A 200 with active=false goes
        // through oauth2_active_attribute instead and counts as a password
        // mismatch. Only dovecot (holding the client secret) can get here.
        return reply(200, {
          access_token: crypto.randomBytes(16).toString('hex'),
          token_type: 'bearer',
          email: name,
          active: 'false',
        })
      }
    } catch (err) {
      // 5xx makes dovecot report a temporary failure, not a wrong password
      console.log(`OAuth2: credential check failed for ${name}: ${err.message}`)
      return reply(503, { error: 'temporarily_unavailable' })
    }
    console.log(`OAuth2: granted token for ${name}`)
    return reply(200, {
      access_token: makeAccessToken(name),
      token_type: 'bearer',
      expires_in: OAUTH_TOKEN_TTL,
      email: name,
      active: 'true',
    })
  }

  // ── Introspection (RFC 7662) ───────────────────────────────
  if (url.pathname === '/introspect') {
    const name = parseAccessToken(form.get('token'))
    return reply(200, name ? { active: 'true', email: name } : { active: 'false' })
  }

  reply(404, { error: 'invalid_request' })
})

if (oauthClientSecret) {
  oauthServer.listen(oauthPort, '127.0.0.1', () => {
    console.log(`OAuth2: listening on 127.0.0.1:${oauthPort}`)
  })
} else {
  // Fail closed: without a client secret, dovecot logins can't be checked
  console.log('OAuth2: no client secret configured; token endpoint disabled')
}

// ── Dovecot sieve lookups ────────────────────────────────────
// Shares dovecot's client secret with the OAuth2 endpoint (Redis AUTH).
const sievePort = parseInt(process.env.SIEVE_PORT || '40576')
if (oauthClientSecret) {
  net.createServer(sieveHandler)
    .on('error', err => console.log(err))
    .listen(sievePort, '127.0.0.1', () => {
      console.log(`Sieve: listening on 127.0.0.1:${sievePort}`)
    })
} else {
  console.log('Sieve: no client secret configured; sieve lookups disabled')
}
