'use strict'
// System provider: ram, disk, power, uptime.
const fs = require('node:fs')
const { execFile } = require('node:child_process')

const GIB = 2 ** 30

function parseMeminfo(text) {
  const kb = key => {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(text)
    if (!m) throw new Error(`no ${key} in /proc/meminfo`)
    return Number(m[1]) * 1024
  }
  const total = kb('MemTotal')
  const used = total - kb('MemAvailable')
  return { pct: total > 0 ? (used / total) * 100 : 0, usedG: used / GIB, totalG: total / GIB }
}

/** `df -B1 --output=avail,pcent /` output (header optional) to { pct, freeG }. */
function parseDf(text) {
  const line = text.trim().split('\n').pop().trim()
  const [free, pct] = line.split(/\s+/)
  if (free === undefined || pct === undefined || !pct.endsWith('%')) throw new Error('unreadable df line')
  return { pct: parseInt(pct, 10), freeG: Math.round(Number(free) / GIB) }
}

/** capacity files' text and AC online files' text; empty string means the file set is absent. */
function parsePower(bat, ac) {
  const first = bat.trim().split('\n')[0]
  const n = first === '' ? NaN : Number(first)
  const lines = ac.trim() === '' ? null : ac.trim().split('\n')
  return {
    pct: Number.isFinite(n) ? n : null,
    plugged: lines === null ? null : lines.some(l => l.trim() === '1'),
  }
}

const readDir = dir => {
  try { return fs.readdirSync(dir) } catch { return [] }
}

function readPower() {
  const base = '/sys/class/power_supply'
  const read = prefix => readDir(base).filter(n => n.startsWith(prefix)).map(n => {
    try { return fs.readFileSync(`${base}/${n}/${prefix === 'BAT' ? 'capacity' : 'online'}`, 'utf8').trim() } catch { return '' }
  }).filter(Boolean).join('\n')
  return parsePower(read('BAT'), read('AC'))
}

const df = () => new Promise((resolve, reject) => {
  execFile('df', ['-B1', '--output=avail,pcent', '/'], { timeout: 3000 }, (err, out) => (err ? reject(err) : resolve(out)))
})

async function getSystem() {
  try {
    const ram = parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8'))
    const upSec = Math.floor(Number(fs.readFileSync('/proc/uptime', 'utf8').split(' ')[0]) || 0)
    const disk = parseDf(await df())
    return { ram, disk, power: readPower(), upSec, now: Date.now() }
  } catch {
    return null
  }
}

module.exports = { getSystem, parseMeminfo, parseDf, parsePower }
