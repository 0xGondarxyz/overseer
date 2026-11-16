'use strict'
const net = require('net')
const fs = require('fs')
const os = require('os')
const { EventEmitter } = require('events')

function sockPath() {
  if (process.env.OVERSEER_SOCK) return process.env.OVERSEER_SOCK
  const uid = process.getuid ? process.getuid() : 0
  return `${process.env.XDG_RUNTIME_DIR || os.tmpdir()}/overseer-${uid}.sock`
}

/**
 * Unix socket hub, newline-delimited JSON.
 * Emits 'hook' ({tab,event,payload}). CLI requests go to handler(req) -> Promise<data>.
 */
class Hub extends EventEmitter {
  constructor({ path = sockPath(), handler } = {}) {
    super()
    this.path = path
    this.handler = handler || (async () => { throw new Error('no cli handler') })
    this.server = null
  }

  start() {
    try { fs.unlinkSync(this.path) } catch {}
    return new Promise((resolve, reject) => {
      this.server = net.createServer((conn) => {
        let buf = ''
        conn.setEncoding('utf8')
        conn.on('data', (d) => {
          buf += d
          let i
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i)
            buf = buf.slice(i + 1)
            if (line.trim()) this._line(conn, line)
          }
        })
        conn.on('error', () => {})
      })
      this.server.once('error', reject)
      this.server.listen(this.path, () => resolve(this.path))
    })
  }

  _line(conn, line) {
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.type === 'hook') {
      this.emit('hook', { tab: msg.tab, event: msg.event, payload: msg.payload })
      conn.end()
    } else if (msg.type === 'cli') {
      Promise.resolve()
        .then(() => this.handler(msg))
        .then((data) => ({ ok: true, data }), (e) => ({ ok: false, error: String((e && e.message) || e) }))
        .then((r) => conn.end(JSON.stringify(r) + '\n'))
    } else conn.end()
  }

  stop() {
    try { this.server && this.server.close() } catch {}
    try { fs.unlinkSync(this.path) } catch {}
  }
}

module.exports = { Hub, sockPath }
