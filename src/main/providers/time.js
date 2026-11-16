'use strict'
// Today and week minutes of Claude working time. Counts working time with a transcript backfill rule over ~/.claude/projects/**/*.jsonl changed in the last 8 days.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CLAUDE_GAP = 30_000
const TOOL_CAP = 600_000
const EIGHT_DAYS = 8 * 86400_000

const pad2 = n => String(n).padStart(2, '0')
const dayKey = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` }
const startOfNextDay = ms => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() }

/** Monday of the week, local time. */
function weekStartKey(ms) {
  const d = new Date(ms)
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
  return dayKey(m.getTime())
}

/** Sorts by start and joins spans whose gap is at most `gap` ms. */
function mergeGap(list, gap) {
  const sorted = [...list].sort((a, b) => a.s - b.s)
  const out = []
  for (const x of sorted) {
    const last = out[out.length - 1]
    if (last && x.s - last.e <= gap) last.e = Math.max(last.e, x.e)
    else out.push({ s: x.s, e: x.e })
  }
  return out
}

const sum = list => list.reduce((n, x) => n + Math.max(0, x.e - x.s), 0)

/** Cuts a span at every local midnight it crosses. */
function splitAtMidnight(span) {
  const out = []
  let s = span.s
  while (span.e > s) {
    const next = startOfNextDay(s)
    if (span.e <= next) { out.push({ s, e: span.e }); break }
    out.push({ s, e: next })
    s = next
  }
  return out
}

/** Claude working time: a step into a non-prompt entry no longer than TOOL_CAP counts. */
function transcriptSpans(events) {
  const sorted = [...events].sort((a, b) => a.t - b.t)
  const out = []
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]
    const b = sorted[i]
    if (!b.prompt && b.t - a.t <= TOOL_CAP && b.t > a.t) out.push({ s: a.t, e: b.t })
  }
  return mergeGap(out, CLAUDE_GAP)
}

/** Parses a transcript's text into { headless, events:[{t,prompt}] }. */
function parseTranscript(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const isTs = line.includes('"timestamp"')
    if (!isTs && !line.includes('"sdk-cli"')) continue
    let d
    try { d = JSON.parse(line) } catch { continue }
    if (d.entrypoint === 'sdk-cli') return { headless: true, events: [] }
    if (!isTs || typeof d.timestamp !== 'string') continue
    const t = Date.parse(d.timestamp)
    if (!Number.isFinite(t)) continue
    let prompt = false
    if (d.type === 'user' && !d.isMeta) {
      const c = d.message && d.message.content
      if (typeof c === 'string') prompt = true
      else if (Array.isArray(c)) prompt = !c.some(b => b && b.type === 'tool_result')
    }
    events.push({ t, prompt })
  }
  return { headless: false, events }
}

/** Today and week minutes from spans of any number of transcripts. */
function totals(spanLists, now) {
  const today = dayKey(now)
  const week = weekStartKey(now)
  const pieces = spanLists.flat().flatMap(splitAtMidnight)
  const within = pred => Math.floor(sum(mergeGap(pieces.filter(p => pred(dayKey(p.s))), CLAUDE_GAP)) / 60_000)
  return { todayMin: within(k => k === today), weekMin: within(k => k >= week) }
}

function walk(dir, since, out) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, since, out)
    else if (e.name.endsWith('.jsonl')) {
      try { const st = fs.statSync(p); if (st.mtimeMs >= since) out.push({ p, mtimeMs: st.mtimeMs }) } catch { /* gone */ }
    }
  }
}

const cache = new Map() // path -> { mtimeMs, spans }

async function getTime(now = Date.now(), root = path.join(os.homedir(), '.claude', 'projects')) {
  try {
    const files = []
    walk(root, now - EIGHT_DAYS, files)
    const live = new Set(files.map(f => f.p))
    for (const k of cache.keys()) if (!live.has(k)) cache.delete(k)
    const lists = []
    for (const f of files) {
      let hit = cache.get(f.p)
      if (!hit || hit.mtimeMs !== f.mtimeMs) {
        const scan = parseTranscript(await fs.promises.readFile(f.p, 'utf8'))
        hit = { mtimeMs: f.mtimeMs, spans: scan.headless ? [] : transcriptSpans(scan.events) }
        cache.set(f.p, hit)
      }
      lists.push(hit.spans)
    }
    return totals(lists, now)
  } catch {
    return null
  }
}

module.exports = { getTime, parseTranscript, transcriptSpans, splitAtMidnight, mergeGap, totals, dayKey, weekStartKey }
