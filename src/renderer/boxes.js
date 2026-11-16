'use strict'
// Status and System boxes as HTML strings. Works in the renderer and in node.
;(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory()
  else root.OverseerBoxes = factory()
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const pad = (s, n) => String(s).padEnd(n)
  const lpad = (s, n) => String(s).padStart(n)
  const span = (cls, text) => `<span class="${cls}">${esc(text)}</span>`
  const line = inner => `<div class="bl">${inner}</div>`
  const key = (k, n = 6) => span('k', pad(k, n))

  // load color: green under 50, yellow under 80, pink at 80 and over
  const load = p => (p >= 80 ? 'hp' : p >= 50 ? 'hy' : 'hg')
  const BAR_W = 7
  const bar = (p, c) => {
    const n = Math.max(1, Math.min(BAR_W, Math.round((p / 100) * BAR_W)))
    return span(c, '━'.repeat(n)) + span('off', '─'.repeat(BAR_W - n))
  }
  // label, % and bar in one color, then an already-escaped extra
  const row = (k, p, extra, c) =>
    line(key(k) + span(c + ' hb', lpad(Math.round(p) + '%', 5)) + ' ' + bar(p, c) + (extra ? ' ' + extra : ''))

  const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max']
  /** `xhigh` becomes ['▮▮▮▮▯', 'xhigh']; an unknown effort has no bars. */
  function effortParts(effort) {
    const n = EFFORT.indexOf(effort) + 1
    return n === 0 ? ['', effort] : ['▮'.repeat(n) + '▯'.repeat(EFFORT.length - n), effort]
  }
  const effortLine = effort => effortParts(effort).filter(Boolean).join(' ')

  /** `claude-opus-5-5` becomes `Opus 5.5`; any other shape shows as is. */
  function prettyModel(model) {
    const id = String(model).replace(/\[.*\]$/, '')
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id)
    if (!m) return id
    const name = m[1].charAt(0).toUpperCase() + m[1].slice(1)
    return m[3] ? `${name} ${m[2]}.${m[3]}` : `${name} ${m[2]}`
  }

  /** 258 minutes becomes `4h18m`; under an hour `18m`. */
  const dur = min => {
    const m = Math.max(0, Math.floor(min))
    return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
  }
  const hhmm = iso => {
    const t = new Date(iso)
    return Number.isNaN(t.getTime()) ? '' : `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  }
  const uptime = sec => {
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60)
    return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`
  }
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const clock = ms => {
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${DAYS[d.getDay()]} ${d.getDate()}`
  }
  const shortDate = date => { const [, m, d] = date.split('-').map(Number); return `${MONTHS[(m || 1) - 1] || '?'} ${d || 0}` }
  const daysBetween = (a, b) => {
    const n = s => { const [y, m, d] = s.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000) }
    return n(b) - n(a)
  }
  const none = text => line(span('k', text))

  // ---- Status
  function renderStatus(d) {
    if (!d) return none('no data')
    const out = []
    if (d.effort || d.model) {
      const parts = []
      if (d.effort) {
        const [bars, name] = effortParts(d.effort)
        parts.push((bars ? span('ho', bars) + ' ' : '') + span('ho hb', name))
      }
      if (d.model) parts.push(span('ho hb', prettyModel(d.model)))
      out.push(line(key('effort', 7) + parts.join(' · ')))
    }
    out.push(line(key('time', 7) + esc(`today ${dur(d.todayMin || 0)} · week ${dur(d.weekMin || 0)}`)))
    const names = { five_hour: '5h', seven_day: 'wk' }
    for (const l of d.limits || []) {
      const at = l.kind === 'five_hour' && l.resetsAt ? hhmm(l.resetsAt) : ''
      out.push(row(names[l.kind], l.pct, at ? span('k', '↻ ' + at) : '', load(l.pct)))
    }
    return out.join('')
  }

  // ---- System
  function renderSystem(d) {
    if (!d) return none('no data')
    const out = [
      row('ram', d.ram.pct, esc(`${d.ram.usedG.toFixed(1)}/${d.ram.totalG.toFixed(1)}G`), load(d.ram.pct)),
      row('disk', d.disk.pct, esc(`${d.disk.freeG}G free`), load(d.disk.pct)),
    ]
    const plug = d.power.plugged === null ? '' : d.power.plugged ? 'plugged in' : 'on battery'
    out.push(
      d.power.pct === null
        ? line(key('power') + esc(plug || 'no battery'))
        : row('power', d.power.pct, esc(plug), load(100 - d.power.pct)),
    )
    out.push(line(key('up') + span('hb', uptime(d.upSec))))
    return out.join('')
  }

  // ---- Boxes with header
  const BOXES = { status: ['useBox', 'Status'], system: ['sysBox', 'System'] }

  function renderBox(kind, d) {
    const [id, title] = BOXES[kind]
    let left = span('bt', title)
    let meta = ''
    let body = ''
    if (kind === 'status') {
      body = renderStatus(d)
    } else if (kind === 'system') {
      meta = d ? `<span>${esc(clock(d.now))}</span>` : ''
      body = renderSystem(d)
    }
    return (
      `<div class="box" id="${id}" data-kind="${kind}">` +
      `<div class="bh">${left}<span class="bh-r">${meta}<button type="button" class="bx" data-box="${id}">[ × ]</button></span></div>` +
      `<div class="bb">${body}</div></div>`
    )
  }

  return { renderStatus, renderSystem, renderBox, effortLine, prettyModel, dur, uptime, clock, shortDate, load, esc }
})
