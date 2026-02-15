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
const proxySecretFile = process.env.COUCH_PROXY_SECRET_FILE
let proxySecret = ''
if (proxySecretFile) {
  try {
    proxySecret = fs.readFileSync(proxySecretFile, 'utf8').trim()
    console.log('Proxy: loaded proxy auth secret')
  } catch (err) {
    console.log(`Proxy: could not read ${proxySecretFile}: ${err.message}`)
  }
}

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
// and unprefixed (default_pass_scheme, typically SSHA512)
function verifyDovecotPassword(password, stored) {
  // {CRYPT} prefix — bcrypt
  if (stored.startsWith('{CRYPT}')) {
    return bcrypt.compareSync(password, stored.slice(7))
  }
  // {BLF-CRYPT} prefix — also bcrypt
  if (stored.startsWith('{BLF-CRYPT}')) {
    return bcrypt.compareSync(password, stored.slice(11))
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

// This processes escaped values in stored dovecot data
const dovecotEscape = (str) => {
  return str.replace(/\x01/g,'\x011')
    .replace(/\n/g,'\x01n')
    .replace(/\t/g, '\x01t')
}

// Handles authentication requests in the dovecot auth format
const dovecotAuthHandler = () => {
  // Dovecot makes one request per connection
  const CMD_HELLO = 'H'
  const CMD_LOOKUP = 'L'

  const vars = {}

  return async client => {
    console.log('Dovecot: client connected')
    client.on('end', () => { console.log('Dovecot: client disconnected') })

    carrier.carry(client, null, 'ascii')
      .on('line', async line => {
        console.log(`Dovecot: got request line (${line})`)
        const cmd = line[0]

        switch(cmd) {
          case CMD_HELLO:
            // Each connection is for a specific table and user, cache these values on hello
            const vals = line.substring(1).split('\t')
            vars.table = vals[4]
            vars.user = vals[3]
            break

          case CMD_LOOKUP:
            switch(vars.table) {
              case 'auth':
                vars.user = line.split('/')[1].split('\t')[0]
                console.log(`Dovecot: looking up auth for ${vars.user}`)
                try {
                  const body = await db.get(USER_PREFIX + vars.user)
                  console.log(`Dovecot: Found entry in db for ${body._id}`)
                  client.write('O')
                  client.write(JSON.stringify({ password : body.dovecot_password }))
                  client.write('\n')
                } catch(err) {
                  console.log(`Dovecot: responding with Not Found (${err})`)
                  client.write('N\n')
                }
                break

              case 'sieve':
                console.log(`Dovecot: looking up sieve for ${vars.user}`)
                const paths = line.split('\t')[0].split('/')
                if(paths[2] === 'name') {
                  // Dovecot caches the compiled script based on the ID we return
                  // so let's return a composite key based on the _id and _rev of the script
                  db.get(USER_PREFIX + vars.user)
                    .then(body =>
                      db.get(body.sieve[paths[3]])
                        .then(body => {
                          console.log(`Dovecot: Found entry in db for ${body._id}`)
                          client.write('O')
                          client.write(`${body._id}+${body._rev}`)
                          client.write('\n')
                        })
                        .catch(err => {
                          console.log('Dovecot: could not find the script document for the user')
                          client.write('N\n')
                        })
                    ).catch(err => {
                      console.log('Dovecot: could not find script with that name for user')
                      client.write('N\n')
                    })
                } else if(paths[2] === 'data') {
                  db.get(paths[3].split('+')[0])
                    .then(body => {
                      console.log(`Dovecot: Found entry in db for ${body._id}`)
                      client.write('O')
                      client.write(dovecotEscape(body.script))
                      client.write('\n')
                    })
                    .catch(err => {
                      console.log('Dovecot: could not find script with that id')
                      client.write('N\n')
                    })
                }
                break
            }
            break
        }
      })
      .on('end', function() {
        client.end()
      })
  }
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

      const doc = await db.get(USER_PREFIX + name).catch(() => null)
      if (!doc || !doc.dovecot_password) {
        res.writeHead(401)
        res.end(JSON.stringify({ error: 'Invalid credentials' }))
        return
      }

      if (!verifyDovecotPassword(password, doc.dovecot_password)) {
        res.writeHead(401)
        res.end(JSON.stringify({ error: 'Invalid credentials' }))
        return
      }

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

console.log('Dovecot: creating Unix listener')
const dovecotSocket = process.env.COUCH_AUTH_SOCK || '/var/run/couchmail/dovecot-auth.sock'
const dovecotServer = net.createServer(dovecotAuthHandler())
  .on('error', err => console.log(err))
const startDovecotServer = () => {
  console.log('Dovecot: starting handler')
  const oldumask = process.umask(0o000)
  dovecotServer.listen(dovecotSocket, () => { process.umask(oldumask) })
}

// See if the socket file already exists
console.log('Dovecot: check for socket')
if(fs.existsSync(dovecotSocket)) {
  // Attempt to connect to a server process that is possibly already listening
  console.log('Dovecot: auth socket already exists')
  new net.Socket()
    .on('error', function(e) {
      console.log(`Dovecot: could not connect to socket ${e.code}`)
      if (e.code == 'ECONNREFUSED') {
        // No other server listening so delete the file
        console.log('Dovecot: deleting unused server socket')
        fs.unlinkSync(dovecotSocket)
        startDovecotServer()
      } else {
        console.log('Some error besides conn refused happened when trying to check for an existing daemon', e)
        process.exit(1)
      }
    })
    .connect({path: dovecotSocket}, function() {
      // If a connection is successful, another instance is already running
      console.log('Server already running, giving up...')
      process.exit(1)
    })
} else {
  startDovecotServer()
}
