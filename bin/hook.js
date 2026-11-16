#!/usr/bin/env node
'use strict'
// Claude hook command: forward stdin JSON to the hub. Prints nothing, always exits 0.
const net = require('net')
const os = require('os')
const done = () => process.exit(0)
setTimeout(done, 1500).unref()
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(input)
    const uid = process.getuid ? process.getuid() : 0
    const path = process.env.OVERSEER_SOCK || `${process.env.XDG_RUNTIME_DIR || os.tmpdir()}/overseer-${uid}.sock`
    const msg = JSON.stringify({ type: 'hook', tab: process.env.OVERSEER_TAB || '', event: payload.hook_event_name, payload }) + '\n'
    const s = net.connect(path)
    s.setTimeout(1000, () => { s.destroy(); done() })
    s.on('error', done)
    s.on('connect', () => s.end(msg, done))
    s.on('close', done)
  } catch { done() }
})
process.stdin.on('error', done)
