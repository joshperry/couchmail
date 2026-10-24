// couchmail-ctl: bootstrap and maintenance commands on the bridge's database.
// Run as the couchmail user (e.g. `sudo -u couchmail couchmail-ctl ...`).
// Passwords are read from stdin, never from argv.

const store = require('./store')
const { hashPassword } = require('./passwords')

const usage = `usage: couchmail-ctl <command> [args]

  add-domain <domain>
  add-user <address> [--admin]       password on stdin
  set-password <address>             password on stdin
  set-admin <address> <true|false>
  add-domain-admin <domain> <address>
  list                               domains, users and aliases
  dump                               everything as JSON (includes password hashes)

DB_PATH selects the database (default /var/lib/couchmail/couchmail.db).`

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => data += chunk)
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')))
    process.stdin.on('error', reject)
  })
}

async function readPassword() {
  if (process.stdin.isTTY) process.stderr.write('Password (then Ctrl-D): ')
  const password = await readStdin()
  if (password.length < 8) throw new store.Invalid('Password must be at least 8 characters')
  return password
}

async function main(argv) {
  const [cmd, ...args] = argv
  const need = n => { if (args.length < n) throw new store.Invalid(usage) }
  const db = store.open(process.env.DB_PATH || '/var/lib/couchmail/couchmail.db')

  switch (cmd) {
    case 'add-domain':
      need(1)
      db.createDomain(args[0])
      break
    case 'add-user': {
      need(1)
      const address = store.norm(args[0])
      if (!db.hasDomain(store.domainOf(address))) {
        throw new store.Invalid(`${store.domainOf(address)} is not a mail domain; add-domain it first`)
      }
      db.createUser({ address, passwordHash: await hashPassword(await readPassword()), isAdmin: args.includes('--admin') })
      break
    }
    case 'set-password':
      need(1)
      db.setPassword(args[0], await hashPassword(await readPassword()))
      break
    case 'set-admin':
      need(2)
      if (!['true', 'false'].includes(args[1])) throw new store.Invalid(usage)
      db.setAdmin(args[0], args[1] === 'true')
      break
    case 'add-domain-admin':
      need(2)
      db.addDomainAdmin(args[0], args[1])
      break
    case 'list':
      for (const d of db.listDomains(null)) {
        console.log(`${d.name}  (${d.users} users, ${d.aliases} aliases${d.admins.length ? `, admins: ${d.admins.join(', ')}` : ''})`)
      }
      for (const u of db.listUsers(null)) {
        console.log(`user   ${u.address}${u.isAdmin ? '  [admin]' : ''}${u.hasPassword ? '' : '  [no password]'}`)
      }
      for (const a of db.listAliases(null)) console.log(`alias  ${a.address} -> ${a.target}`)
      break
    case 'dump':
      console.log(JSON.stringify(db.dump(), null, 2))
      break
    default:
      console.error(usage)
      process.exit(cmd ? 2 : 0)
  }
}

main(process.argv.slice(2)).catch(err => {
  console.error(err instanceof store.Invalid || err instanceof store.Conflict || err instanceof store.NotFound
    ? err.message : err.stack)
  process.exit(1)
})
