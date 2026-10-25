const net = require('net'),
      http = require('http'),
      fs = require('fs'),
      crypto = require('crypto'),
      carrier = require('carrier'),
      store = require('./store'),
      { createApi, checkCredentials } = require('./api'),
      { importFromCouch, couchFromEnv } = require('./import-couch')

const dbPath = process.env.DB_PATH || '/var/lib/couchmail/couchmail.db'
const db = store.open(dbPath)
console.log(`Store: opened ${dbPath}`)

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
          let respval
          try {
            respval = getHandler(reqval)
          } catch (err) {
            // 400 tells postfix to defer rather than treat it as not found
            console.log(`${service}: lookup failed: ${err.message}`)
            client.write('400 Lookup failed\n')
            return
          }
          if(respval) {
            console.log(`${service}: responding with ${respval}`)
            client.write(`200 ${respval}\n`)
          } else {
            console.log(`${service}: responding with Not Found`)
            client.write('500 Not Found\n')
          }
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
  postfixHandler('domain', domain => db.hasDomain(domain) ? 'OK' : '')

// Postfix handler specialized for finding mailboxes
const mailboxHandler = () =>
  postfixHandler('mailbox', username => db.hasUser(username) ? username : '')

// Postfix handler specialized for finding aliases
const aliasHandler = () =>
  postfixHandler('alias', alias => db.aliasTarget(alias) || '')

// Looks up a user's sieve script for dovecot. `kind` is "name" (returns a
// data ID for the named script) or "data" (returns the script for an ID).
// Returns null when there is no such script; throws on database errors.
function sieveLookup(user, kind, id) {
  if (kind === 'name') {
    const script = db.getSieve(user, id)
    // Dovecot caches the compiled script by this ID, so include the version
    return script ? `${script.id}+${script.version}` : null
  }
  if (kind === 'data') {
    const scriptId = Number(id.split('+')[0])
    return Number.isSafeInteger(scriptId) ? db.getSieveById(user, scriptId) : null
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

  const handle = args => {
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
      return respBulk(sieveLookup(user, kind, id))
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
        client.write(handle(parsed.args))
      }
    } catch (err) {
      console.log(`Sieve: protocol error: ${err.message}`)
      client.destroy()
    }
  })
  client.on('error', err => console.log(`Sieve: connection error: ${err.message}`))
}

// ── Dovecot OAuth2 password grant ────────────────────────────
// Dovecot's oauth2 passdb POSTs the user's credentials here (RFC 6749
// password grant) and the bridge checks them, so password hashes never leave
// the bridge. Separate loopback-only listener: the API port is proxied
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
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
      if (!await checkCredentials(db, name, password)) {
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

// ── Listeners ────────────────────────────────────────────────
// All loopback-only. The API port is proxied by nginx at /_couchmail/api/;
// the others are for postfix and dovecot and must never be exposed.
const ports = {
  api: parseInt(process.env.PASSWORD_PORT || '40574'),
  domain: parseInt(process.env.DOMAIN_PORT || '40571'),
  mailbox: parseInt(process.env.MAILBOX_PORT || '40572'),
  alias: parseInt(process.env.ALIAS_PORT || '40573'),
  // Shares dovecot's client secret with the OAuth2 endpoint (Redis AUTH)
  sieve: parseInt(process.env.SIEVE_PORT || '40576'),
}

function listen(server, port, name) {
  server.on('error', err => console.log(`${name}: ${err.message}`))
  server.listen(port, '127.0.0.1', () => console.log(`${name}: listening on 127.0.0.1:${port}`))
}

// With COUCH_IMPORT=1, an empty database is first filled from the old
// CouchDB `mail` database. Nothing listens until that has finished, so
// nothing is ever served from a half-imported database.
async function main() {
  if (process.env.COUCH_IMPORT === '1') {
    const imported = db.meta('imported_from_couchdb')
    if (imported) {
      console.log(`Import: already imported from CouchDB at ${imported}`)
    } else if (!db.isEmpty()) {
      console.log('Import: database already has data; not importing from CouchDB')
    } else {
      await importFromCouch(db, couchFromEnv(process.env))
    }
  }

  listen(http.createServer(createApi(db)), ports.api, 'HTTP')
  listen(net.createServer(domainHandler()), ports.domain, 'postfix domain')
  listen(net.createServer(mailboxHandler()), ports.mailbox, 'postfix mailbox')
  listen(net.createServer(aliasHandler()), ports.alias, 'postfix alias')

  if (oauthClientSecret) {
    listen(oauthServer, oauthPort, 'OAuth2')
    listen(net.createServer(sieveHandler), ports.sieve, 'Sieve')
  } else {
    // Fail closed: without a client secret, dovecot can't be authenticated
    console.log('OAuth2: no client secret configured; token endpoint and sieve lookups disabled')
  }
}

main().catch(err => {
  // Exit so systemd restarts us, e.g. if CouchDB wasn't up yet for the import
  console.log(`Startup failed: ${err.stack || err.message}`)
  process.exit(1)
})
