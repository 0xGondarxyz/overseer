'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const sys = require('../../src/main/providers/system')
const time = require('../../src/main/providers/time')
const status = require('../../src/main/providers/status')

const MIN = 60_000
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

const MEM = 'MemTotal:       23810108 kB\nMemFree:         1000000 kB\nMemAvailable:    9866400 kB\n'

test('system parsing', () => {
  const r = sys.parseMeminfo(MEM)
  assert.equal(Math.round(r.pct), 59)
  assert.equal(r.usedG.toFixed(1), '13.3')
  assert.equal(r.totalG.toFixed(1), '22.7')
  assert.deepEqual(sys.parseDf('Avail Use%\n36507222016   85%\n'), { pct: 85, freeG: 34 })
  assert.throws(() => sys.parseDf('garbage'))
  assert.throws(() => sys.parseMeminfo('nothing'))
  assert.deepEqual(sys.parsePower('100\n', '1\n'), { pct: 100, plugged: true })
  assert.deepEqual(sys.parsePower('', '1'), { pct: null, plugged: true })
  assert.deepEqual(sys.parsePower('55', '0'), { pct: 55, plugged: false })
  assert.deepEqual(sys.parsePower('', ''), { pct: null, plugged: null })
})

test('getSystem reads this machine', async () => {
  const s = await sys.getSystem()
  assert.ok(s, 'not null')
  assert.ok(s.ram.pct > 0 && s.ram.pct <= 100)
  assert.ok(s.disk.pct >= 0 && s.disk.freeG >= 0)
  assert.ok(s.upSec > 0 && s.now > 0)
})

// time: transcript rule
test('transcript rule: prompt boundary not counted, 11 minute gap cut, 10 minute gap counted', () => {
  const ev = [
    { t: 0, prompt: true }, { t: 5_000, prompt: false }, { t: 5_000 + 10 * MIN, prompt: false },
    { t: 5_000 + 21 * MIN, prompt: false }, { t: 7_000 + 21 * MIN, prompt: false },
    { t: 40 * MIN, prompt: true }, { t: 40 * MIN + 3_000, prompt: false },
  ]
  assert.deepEqual(time.transcriptSpans(ev), [
    { s: 0, e: 5_000 + 10 * MIN },
    { s: 21 * MIN + 5_000, e: 21 * MIN + 7_000 },
    { s: 40 * MIN, e: 40 * MIN + 3_000 },
  ])
})

test('transcript rule: spans 30 s apart merge across a prompt', () => {
  const ev = [{ t: 0, prompt: false }, { t: 10_000, prompt: false }, { t: 30_000, prompt: true }, { t: 40_000, prompt: false }]
  assert.deepEqual(time.transcriptSpans(ev), [{ s: 0, e: 40_000 }])
})

test('day keys and week start on Monday', () => {
  assert.equal(time.dayKey(at(2026, 10, 1, 23, 59)), '2026-10-01')
  assert.equal(time.dayKey(at(2026, 10, 2, 0, 0)), '2026-10-02')
  assert.equal(time.weekStartKey(at(2026, 10, 4, 12)), '2026-09-28') // Sunday
  assert.equal(time.weekStartKey(at(2026, 10, 5, 0, 1)), '2026-10-05') // Monday
})

test('a span across midnight splits into two days', () => {
  const parts = time.splitAtMidnight({ s: at(2026, 10, 1, 23, 55), e: at(2026, 10, 2, 0, 5) })
  assert.deepEqual(parts.map(p => time.dayKey(p.s)), ['2026-10-01', '2026-10-02'])
})

test('work at 01:00 counts for the new day', () => {
  const span = [{ s: at(2026, 10, 2, 0, 50), e: at(2026, 10, 2, 1, 10) }]
  assert.deepEqual(time.totals([span], at(2026, 10, 2, 1, 30)), { todayMin: 20, weekMin: 20 })
})

test('totals: yesterday is not today but is this week', () => {
  const span = [{ s: at(2026, 10, 1, 10), e: at(2026, 10, 1, 10, 5) }, { s: at(2026, 10, 2, 10), e: at(2026, 10, 2, 10, 3) }]
  assert.deepEqual(time.totals([span], at(2026, 10, 2, 12)), { todayMin: 3, weekMin: 8 })
})

test('parseTranscript: prompts, tool results, headless', () => {
  const line = o => JSON.stringify(o)
  const text = [
    line({ type: 'user', timestamp: '2026-10-02T10:00:00.000Z', message: { content: 'hi' } }),
    line({ type: 'assistant', timestamp: '2026-10-02T10:00:05.000Z' }),
    line({ type: 'user', timestamp: '2026-10-02T10:00:06.000Z', message: { content: [{ type: 'tool_result' }] } }),
    'not json "timestamp"',
  ].join('\n')
  const r = time.parseTranscript(text)
  assert.equal(r.headless, false)
  assert.deepEqual(r.events.map(e => e.prompt), [true, false, false])
  assert.equal(time.parseTranscript(line({ entrypoint: 'sdk-cli', timestamp: '2026-10-02T10:00:00Z' })).headless, true)
})

test('getTime reads transcripts under a root, skips headless and old files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-time-'))
  const now = Date.now()
  const iso = ms => new Date(ms).toISOString()
  const mk = (name, entries, old) => {
    const p = path.join(root, name)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, entries.map(e => JSON.stringify(e)).join('\n'))
    if (old) fs.utimesSync(p, new Date(now - 20 * 86400_000), new Date(now - 20 * 86400_000))
  }
  const t0 = now - 20 * MIN
  mk('a/s1.jsonl', [
    { type: 'user', timestamp: iso(t0), message: { content: 'go' } },
    { type: 'assistant', timestamp: iso(t0 + 5 * MIN) },
  ])
  mk('a/s1/subagents/agent-1.jsonl', [{ type: 'assistant', timestamp: iso(t0 + 5 * MIN) }, { type: 'assistant', timestamp: iso(t0 + 8 * MIN) }])
  mk('b/headless.jsonl', [{ entrypoint: 'sdk-cli', timestamp: iso(t0) }, { type: 'assistant', timestamp: iso(t0 + MIN) }])
  mk('c/old.jsonl', [{ type: 'user', timestamp: iso(t0), message: { content: 'x' } }, { type: 'assistant', timestamp: iso(t0 + 9 * MIN) }], true)
  const r = await time.getTime(now, root)
  // spans: 0..5 and 5..8 min merge to 8 minutes (at midnight edge a split can cost nothing extra)
  assert.ok(r.weekMin >= 7 && r.weekMin <= 8, `weekMin ${r.weekMin}`)
  assert.ok(r.todayMin <= r.weekMin)
  fs.rmSync(root, { recursive: true, force: true })
})

test('status: limits parse', () => {
  const l = status.parseLimits({ rateLimits: [{ kind: 'five_hour', percentUsed: 4, resetsAt: 'x' }, { kind: 'other', percentUsed: 1 }, { kind: 'seven_day', percentUsed: 39, resetsAt: 'y' }] })
  assert.deepEqual(l, [{ kind: 'five_hour', pct: 4, resetsAt: 'x' }, { kind: 'seven_day', pct: 39, resetsAt: 'y' }])
  assert.deepEqual(status.parseLimits(null), [])
})

test('getStatus reads the session file and never throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-status-'))
  fs.mkdirSync(path.join(dir, 'sessions'))
  fs.writeFileSync(path.join(dir, 'sessions', 'abc-1.json'), JSON.stringify({ effort: 'xhigh', model: 'claude-opus-5-5', context: { percent: 8 } }))
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify({ rateLimits: [{ kind: 'five_hour', percentUsed: 4, resetsAt: '2026-11-16T17:40:00.000Z' }] }))
  const s = await status.getStatus('abc-1', { cacheDir: dir })
  assert.equal(s.effort, 'xhigh')
  assert.equal(s.model, 'claude-opus-5-5')
  assert.equal(s.limits.length, 1)
  assert.equal(typeof s.todayMin, 'number')
  const none = await status.getStatus('../evil', { cacheDir: dir })
  assert.equal(none.effort, null)
  assert.equal((await status.getStatus(undefined, { cacheDir: '/nonexistent' })).limits.length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

