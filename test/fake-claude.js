#!/usr/bin/env node
'use strict'
// Stand-in for claude in tests. Prints its args and cwd, sets an OSC title, sends hooks to the hub socket.
// Lines typed: `ask` -> PreToolUse AskUserQuestion, `agent` -> Agent Pre then Post after 2 s, `exit` -> quit, else reply.
const net = require('net')
const fs = require('fs')
const path = require('path')
const os = require('os')
const FX = path.join(__dirname, 'fixtures')
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FX, n + '.json'), 'utf8'))
const args = process.argv.slice(2)
const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null }
const sessionId = val('--session-id') || val('--resume') || require('crypto').randomUUID()
const cwd = process.cwd()
if (args.includes('--version') || args[0] === '-v') {
  process.stdout.write('fake-claude 0.0.0 args=' + args.join(' ') + '\n')
  if (process.env.OVERSEER_FAKE_LOG) fs.appendFileSync(process.env.OVERSEER_FAKE_LOG, JSON.stringify({ tab: process.env.OVERSEER_TAB, cwd, args, event: 'version' }) + '\n')
  process.exit(0)
}
const sock = process.env.OVERSEER_SOCK || `${process.env.XDG_RUNTIME_DIR || os.tmpdir()}/overseer-${process.getuid()}.sock`
const log = (o) => { if (process.env.OVERSEER_FAKE_LOG) fs.appendFileSync(process.env.OVERSEER_FAKE_LOG, JSON.stringify({ tab: process.env.OVERSEER_TAB, cwd, args, ...o }) + '\n') }

function hook(name, over = {}) {
  const p = { ...fx(name.file), session_id: sessionId, cwd, transcript_path: `/tmp/fake/${sessionId}.jsonl`, ...over }
  delete p._synthetic
  const s = net.connect(sock)
  s.on('error', () => {})
  s.on('connect', () => s.end(JSON.stringify({ type: 'hook', tab: process.env.OVERSEER_TAB || '', event: p.hook_event_name, payload: p }) + '\n'))
}

process.stdout.write(`\x1b]0;fake: ${path.basename(cwd)}\x07`)
process.stdout.write(`fake-claude cwd=${cwd}\r\nargs=${args.join(' ')}\r\n> `)
log({ event: 'start' })
const resumed = args.includes('--resume')
hook({ file: resumed ? 'hook-SessionStart-resume' : 'hook-SessionStart' }, { source: resumed ? 'resume' : 'startup' })

process.stdout.on('resize', () => { log({ event: 'resize', cols: process.stdout.columns, rows: process.stdout.rows }) })
process.on('SIGWINCH', () => log({ event: 'resize', cols: process.stdout.columns, rows: process.stdout.rows }))

process.stdin.setRawMode && process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
let line = ''
process.stdin.on('data', (d) => {
  for (const ch of d) {
    if (ch === '\r' || ch === '\n') { const l = line; line = ''; submit(l) } else if (ch === '\x7f') line = line.slice(0, -1)
    else if (ch >= ' ') line += ch
  }
})

function submit(l) {
  log({ event: 'line', line: l })
  process.stdout.write('\r\n')
  if (l === 'exit') { hook({ file: 'hook-SessionEnd' }); setTimeout(() => process.exit(0), 100); return }
  hook({ file: 'hook-UserPromptSubmit' }, { prompt: l })
  if (l === 'ask') { setTimeout(() => hook({ file: 'hook-PreToolUse-AskUserQuestion' }), 100); process.stdout.write('asking...\r\n'); return }
  if (l === 'agent') {
    setTimeout(() => hook({ file: 'hook-PreToolUse-Agent' }), 100)
    setTimeout(() => { hook({ file: 'hook-PostToolUse-Agent' }); stop('agent done') }, 2000)
    return
  }
  setTimeout(() => stop(l), 300)
}
function stop(l) {
  process.stdout.write(`reply: ${l}\r\n> `)
  hook({ file: 'hook-Stop' }, { last_assistant_message: 'reply: ' + l })
}
setInterval(() => {}, 1 << 30)
