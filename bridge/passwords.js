const crypto = require('crypto')
const bcrypt = require('bcryptjs')

// New hashes are bcrypt in dovecot's {CRYPT} form
async function hashPassword(password) {
  return `{CRYPT}${await bcrypt.hash(password, 10)}`
}

// ── Dovecot password verification ────────────────────────────
// Supports {CRYPT} (bcrypt), {SSHA512}, {SSHA256}, {SHA512}, {SHA256},
// and unprefixed (default_pass_scheme, typically SSHA512).
// Async so bcrypt doesn't block the event loop (postfix lookups share it).
async function verifyPassword(password, stored) {
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
  const equal = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b)

  switch (scheme) {
    case 'SSHA512': {
      const digest = buf.subarray(0, 64)
      const salt = buf.subarray(64)
      return equal(digest, crypto.createHash('sha512').update(password).update(salt).digest())
    }
    case 'SSHA256': {
      const digest = buf.subarray(0, 32)
      const salt = buf.subarray(32)
      return equal(digest, crypto.createHash('sha256').update(password).update(salt).digest())
    }
    case 'SHA512':
      return equal(buf, crypto.createHash('sha512').update(password).digest())
    case 'SHA256':
      return equal(buf, crypto.createHash('sha256').update(password).digest())
    default:
      console.log(`Auth: unsupported password scheme: ${scheme}`)
      return false
  }
}

module.exports = { hashPassword, verifyPassword }
