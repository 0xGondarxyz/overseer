'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const { scrub } = require('../../src/main/env')
const { claudeArgs } = require('../../src/main/pty')
const { createStore, usableBounds } = require('../../src/main/store')
const ov = require('../../src/main/overseer')
const { newTab } = require('../../src/main/state')

test('scrub strips inherited session env, keeps the rest', () => {
  const env = scrub({
    CLAUDECODE: '1', CLAUDE_PID: '9', CLAUDE_EFFORT: 'high', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_EXECPATH: '/x', CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_SESSION_ID: 'a', CLAUDE_CODE_MESSAGING_SOCKET: 's',
    PATH: '/bin', HOME: '/h', CLAUDE_CODE_PLUGIN_DIRS: '/p', ANTHROPIC_FOO: 'k',
  })
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_FOO', 'CLAUDE_CODE_PLUGIN_DIRS', 'HOME', 'PATH'])
})
test('claudeArgs: model once in overseer mode, resume/continue/new', () => {
  const base = { hooksFile: '/u/hooks.json', root: '/r' }
  const o = claudeArgs({ ...base, model: 'opus', mode: { kind: 'overseer', sessionId: 's', prompt: 'hi' } })
  assert.equal(o.filter((a) => a === '--model').length, 1); assert.equal(o[o.length - 1], 'hi')
  assert.deepEqual(claudeArgs({ ...base, mode: { kind: 'continue', sessionId: 'abc' } }).slice(-2), ['--resume', 'abc'])
  assert.equal(claudeArgs({ ...base, mode: { kind: 'continue' } }).pop(), '--continue')
  const n = claudeArgs({ ...base, mode: { kind: 'new', sessionId: 'u' } })
  assert.deepEqual(n.slice(0, 4), ['--settings', '/u/hooks.json', '--plugin-dir', '/r/bridge']); assert.deepEqual(n.slice(-2), ['--session-id', 'u'])
})
test('store saves after delay, flush writes now, load round-trips', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovs-'))
  const s = createStore(dir, 30)
  assert.equal(s.load(), null)
  s.save({ a: 1 }); assert.equal(fs.existsSync(s.file), false)
  await new Promise((r) => setTimeout(r, 80))
  assert.deepEqual(s.load(), { a: 1 })
  s.save({ a: 2 }); s.flush(); assert.deepEqual(s.load(), { a: 2 })
})
test('usableBounds keeps only bounds on a connected display', () => {
  const d = [{ id: 7, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]
  const b = { x: 100, y: 100, width: 1000, height: 700, displayId: 7 }
  assert.deepEqual(usableBounds(b, d), b)
  assert.equal(usableBounds({ ...b, displayId: 9 }, d), null)
  assert.equal(usableBounds({ ...b, x: 5000 }, d), null)
  assert.equal(usableBounds(null, d), null)
})
test('hooks config has all events, silent command, no env override', () => {
  const c = ov.buildHooksConfig({ node: '/n/node', root: '/r' })
  assert.deepEqual(Object.keys(c.hooks).sort(), ['Notification', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit'])
  assert.equal(c.hooks.PreToolUse[0].matcher, 'AskUserQuestion|Task|Agent'); assert.equal(c.hooks.Stop[0].hooks[0].command, '"/n/node" "/r/bin/hook.js"')
  assert.equal(c.hooks.Stop[0].hooks[0].timeout, 5); assert.equal(c.env, undefined)
})
test('tabs.md has one block per tab: process, claude ids only when claude runs, screen text', () => {
  const a = { ...newTab({ id: 1, cwd: '/p/a', now: 0 }), status: 'working', since: 0, sessionId: 'sid1', transcriptPath: '/t/1.jsonl', lastReply: 'x'.repeat(500), subagents: [{ desc: 'Find', start: 0, running: true }], fg: 'claude' }
  const b = { ...newTab({ id: 2, cwd: '/p/b', now: 0 }), fg: 'opencode', sessionId: 'old' }
  const md = ov.renderTabsMd([a, b], 12 * 60000, { 1: 'hello a', 2: 'OPENCODE-MARKER' })
  assert.match(md, /## 1\. a\n- folder: \/p\/a\n- running now: claude \(claude\)\n- status: working 12m\n- session id: sid1\n- transcript: \/t\/1\.jsonl\n- subagents: Find \(12m\)/)
  assert.match(md, /## 2\. b\n- folder: \/p\/b\n- running now: opencode\n- status: plain shell\n- session id: -/)
  assert.match(md, /```text\nOPENCODE-MARKER\n```/); assert.match(md, /```text\nhello a\n```/)
  assert.ok(md.includes('x'.repeat(300)) && !md.includes('x'.repeat(301)))
})
test('shell args: fish gets -C with the shim first; prompt file is quoted for fish and bash', () => {
  const { shellArgs, claudeWithPromptFile } = require('../../src/main/pty')
  assert.deepEqual(shellArgs('/usr/bin/fish', '/r/bin/shim'), ['-C', "set -gx PATH '/r/bin/shim' $PATH"])
  assert.deepEqual(shellArgs('/bin/bash', '/s'), [])
  assert.equal(claudeWithPromptFile('/usr/bin/fish', "/t/it's.txt"), "claude (cat '/t/it\\'s.txt' | string collect)")
  assert.equal(claudeWithPromptFile('/bin/bash', '/t/a.txt'), `claude "$(cat '/t/a.txt')"`)
})
test('state: _shell returns a claude tab to a plain shell; _cwd renames only unnamed tabs without OSC', () => {
  const { reduce } = require('../../src/main/state')
  let t = { ...newTab({ id: 1, cwd: '/p/a' }), status: 'done', subagents: [{ running: true }] }
  t = reduce(t, { event: '_shell' }); assert.equal(t.status, 'notStarted'); assert.deepEqual(t.subagents, [])
  assert.equal(reduce(t, { event: '_cwd', cwd: '/x/y' }).title, 'y')
  assert.equal(reduce({ ...t, renamed: true, title: 'Mine' }, { event: '_cwd', cwd: '/x/y' }).title, 'Mine')
  assert.equal(reduce({ ...t, hasOsc: true }, { event: '_cwd', cwd: '/x/y' }).title, 'a')
})
test('claude shim: passes info subcommands unchanged, adds flags otherwise, never uses PATH', () => {
  const { execFileSync } = require('child_process')
  const shim = path.join(__dirname, '..', '..', 'bin', 'shim', 'claude')
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ovsh-')), 'real')
  fs.writeFileSync(fake, '#!/bin/sh\necho "$@"\n', { mode: 0o755 })
  const run = (...a) => execFileSync(shim, a, { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', OVERSEER_REAL_CLAUDE: fake, OVERSEER_HOOKS: '/h.json', OVERSEER_APP: '/app' } }).trim()
  assert.equal(run('--version'), '--version'); assert.equal(run('mcp', 'list'), 'mcp list'); assert.equal(run('-h'), '-h')
  assert.equal(run('-r', 'x'), '--settings /h.json --plugin-dir /app/bridge -r x'); assert.equal(run(), '--settings /h.json --plugin-dir /app/bridge')
})
test('claude shim: says why and exits 127 when the real binary is missing', () => {
  const shim = path.join(__dirname, '..', '..', 'bin', 'shim', 'claude')
  const noEnv = spawnSync(shim, [], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  assert.equal(noEnv.status, 127); assert.match(noEnv.stderr, /OVERSEER_REAL_CLAUDE is not set/)
  const badPath = spawnSync(shim, [], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', OVERSEER_REAL_CLAUDE: '/nope/claude' } })
  assert.equal(badPath.status, 127); assert.match(badPath.stderr, /missing or not executable/)
})
test('first prompt names the tabs.md path', () => assert.match(ov.firstPrompt('/c'), /Read \/c\/tabs\.md and give me one short line per open tab/))
test('readBridge reads context percent, model, effort', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovb-')); fs.mkdirSync(path.join(dir, 'sessions'))
  fs.writeFileSync(path.join(dir, 'sessions', 's1.json'), JSON.stringify({ context: { percent: 8 }, model: 'm', effort: 'medium' }))
  assert.deepEqual(ov.readBridge('s1', dir), { contextPct: 8, model: 'm', effort: 'medium' }); assert.equal(ov.readBridge('nope', dir), null)
})

test('writePrompt fills the template placeholders and writes into the cache dir', () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'ovp-'))
  const root = path.resolve(__dirname, '..', '..')
  const file = ov.writePrompt({ root, node: '/n/node', cacheDir: cache, homeDir: '/h/demo' })
  const text = fs.readFileSync(file, 'utf8')
  assert.equal(path.dirname(file), cache)
  assert.ok(text.includes('/n/node ' + path.join(root, 'bin', 'overseer.js')))
  assert.ok(text.includes(path.join(cache, 'tabs.md')) && text.includes('/h/demo'))
  assert.ok(!/\{\{\w+\}\}/.test(text))
  fs.rmSync(cache, { recursive: true, force: true })
})
