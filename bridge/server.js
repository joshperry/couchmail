const net = require('net'),
      fs = require('fs'),
      events = require('events'),
      util = require('util'),
      carrier = require('carrier')

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
//        log: (id, args) => {
//          console.log(id, args)
//        },
      })

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
    db.get(username)
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
                  const body = await db.get(vars.user)
                  console.log(`Dovecot: Found entry in db for ${body._id}`)
                  client.write('O')
                  client.write(JSON.stringify({ password : body.password }))
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
                  db.get(vars.user)
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
