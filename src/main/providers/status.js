'use strict'
// Status provider: limits, effort, model, time. Reads only ~/.cache/overseer.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { getTime } = require('./time')

const CACHE = path.join(os.homedir(), '.cache', 'overseer')

const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** usage.json rateLimits to [{kind, pct, resetsAt}]. */
function parseLimits(usage) {
  const list = usage && Array.isArray(usage.rateLimits) ? usage.rateLimits : []
  return list
    .filter(r => r && (r.kind === 'five_hour' || r.kind === 'seven_day') && Number.isFinite(Number(r.percentUsed)))
    .map(r => ({ kind: r.kind, pct: Number(r.percentUsed), resetsAt: r.resetsAt ?? null }))
}

async function getStatus(sessionId, opts = {}) {
  try {
    const cache = opts.cacheDir || CACHE
    const session = sessionId && /^[\w-]+$/.test(sessionId) ? readJson(path.join(cache, 'sessions', `${sessionId}.json`)) : null
    const time = (await getTime()) || { todayMin: 0, weekMin: 0 }
    const limits = parseLimits(readJson(path.join(cache, 'usage.json')))
    return {
      effort: session && typeof session.effort === 'string' ? session.effort : null,
      model: session && typeof session.model === 'string' ? session.model : null,
      todayMin: time.todayMin,
      weekMin: time.weekMin,
      limits,
    }
  } catch {
    return null
  }
}

module.exports = { getStatus, parseLimits }
