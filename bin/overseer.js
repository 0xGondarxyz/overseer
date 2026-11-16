#!/usr/bin/env node
'use strict'
// overseer CLI: list | send <n|title> <text...> | new --cwd <dir> [--title <t>] [--prompt-file <f>] | close <n|title...> | toggle
const net = require('net')
const os = require('os')

function sockPath() {
  const uid = process.getuid ? process.getuid() : 0
  return process.env.OVERSEER_SOCK || `${process.env.XDG_RUNTIME_DIR || os.tmpdir()}/overseer-${uid}.sock`
}

function call(cmd, args) {
  return new Promise((resolve, reject) => {
    const s = net.connect(sockPath())
    let buf = ''
    s.setEncoding('utf8')
    s.on('connect', () => s.write(JSON.stringify({ type: 'cli', cmd, args }) + '\n'))
    s.on('data', (d) => (buf += d))
    s.on('end', () => { try { resolve(JSON.parse(buf)) } catch { reject(new Error('bad reply')) } })
    s.on('error', () => reject(new Error('Overseer is not running (cannot reach ' + sockPath() + ')')))
  })
}

function fmtList(tabs) {
  return tabs.map((t) => `${t.n}. ${t.title} | ${t.cwd} | ${t.status} ${t.since || ''} | ${t.sessionId || '-'} | ${t.transcriptPath || '-'}`).join('\n')
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  let args
  if (cmd === 'list' || cmd === 'toggle') args = {}
  else if (cmd === 'send' && rest.length >= 2) args = { tab: rest[0], text: rest.slice(1).join(' ') }
  else if (cmd === 'close' && rest.length) args = { tabs: rest }
  else if (cmd === 'new') {
    args = {}
    for (let i = 0; i < rest.length; i += 2) {
      const k = { '--cwd': 'cwd', '--title': 'title', '--prompt-file': 'promptFile' }[rest[i]]
      if (!k || rest[i + 1] === undefined) { console.error('usage: overseer new --cwd <dir> [--title <t>] [--prompt-file <f>]'); process.exit(2) }
      args[k] = k === 'title' ? rest[i + 1] : require('path').resolve(rest[i + 1])
    }
  } else {
    console.error('usage: overseer list | send <n|title> <text...> | new --cwd <dir> [--title <t>] [--prompt-file <f>] | close <n|title...> | toggle')
    process.exit(2)
  }
  const r = await call(cmd, args)
  if (!r.ok) { console.error('error: ' + r.error); process.exit(1) }
  console.log(cmd === 'list' && Array.isArray(r.data) ? fmtList(r.data) : typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? 'ok'))
}
main().catch((e) => { console.error('error: ' + e.message); process.exit(1) })
