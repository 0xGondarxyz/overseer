'use strict'
// The one place that connects the right column to data. Each function returns a plain object (or null) and never throws.
const os = require('os')
const fs = require('fs')
const path = require('path')

function tryRequire(p) { try { return require(p) } catch { return null } }

const stub = {
  async getSystem() {
    const total = os.totalmem(), free = os.freemem()
    return { ram: { pct: Math.round((1 - free / total) * 100), usedG: +((total - free) / 2 ** 30).toFixed(1), totalG: +(total / 2 ** 30).toFixed(1) },
      disk: { pct: 90, freeG: 23 }, power: { pct: null, plugged: null }, upSec: Math.round(os.uptime()), now: Date.now() }
  },
  async getStatus(sessionId) {
    const cache = process.env.OVERSEER_CACHE || path.join(os.homedir(), '.cache', 'overseer')
    let s = {}, u = {}
    try { s = JSON.parse(fs.readFileSync(path.join(cache, 'sessions', sessionId + '.json'), 'utf8')) } catch {}
    try { u = JSON.parse(fs.readFileSync(path.join(cache, 'usage.json'), 'utf8')) } catch {}
    return { effort: s.effort || null, model: s.model || null, todayMin: 0, weekMin: 0,
      limits: (u.rateLimits || []).map((r) => ({ kind: r.kind, pct: r.percentUsed, resetsAt: r.resetsAt })) }
  },
}

const system = tryRequire('./providers/system')
const status = tryRequire('./providers/status')

// Tests (and the README screenshots) never read ~/.claude: fixed sample data with realistic line lengths.
const fixture = {
  getSystem: async () => ({ ram: { pct: 62, usedG: 19.4, totalG: 31.3 }, disk: { pct: 91, freeG: 23 }, power: { pct: 84, plugged: true }, upSec: 93784, now: Date.now() }),
  getStatus: async () => ({ effort: 'xhigh', model: 'claude-opus-5-5', todayMin: 258, weekMin: 1210, limits: [{ kind: 'five_hour', pct: 41, resetsAt: '2026-11-16T21:00:00' }, { kind: 'seven_day', pct: 67 }] }),
}
if (process.env.OVERSEER_TEST) module.exports = fixture
else module.exports = {
  getSystem: () => (system && system.getSystem ? system.getSystem() : stub.getSystem()).catch(() => null),
  getStatus: (sessionId) => (status && status.getStatus ? status.getStatus(sessionId) : stub.getStatus(sessionId)).catch(() => null),
}
