// The renderer-side adapter for the right column. When boxes.js is loaded first, these functions call its
// renderStatus/renderSystem and the stubs go unused.
(function () {
  const bar = (pct, n = 10) => { const f = Math.round(Math.max(0, Math.min(100, pct)) / 100 * n); return '▮'.repeat(f) + '<span class="off">' + '▯'.repeat(n - f) + '</span>' }
  const cls = (p) => (p >= 85 ? 'hp' : p >= 60 ? 'hy' : 'hg')
  const pad = (s, n) => String(s).padEnd(n, ' ')
  const row = (k, pct, txt) => '<div class="bl"><span class="k">' + pad(k, 6) + '</span><span class="' + cls(pct) + '">' + bar(pct) + '</span> <span class="' + cls(pct) + ' hb">' + Math.round(pct) + '%</span> ' + (txt || '') + '</div>'
  const dur = (m) => (m >= 60 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm' : m + 'm')
  const stub = {
    renderStatus(d) {
      if (!d) return '<div class="bl"><span class="k">no data</span></div>'
      const lim = (k) => (d.limits || []).find((l) => l.kind === k)
      const f = lim('five_hour'), w = lim('seven_day')
      return '<div class="bl"><span class="k">' + pad('effort', 7) + '</span><span class="ho hb">' + (d.effort || '-') + '</span> · <span class="ho hb">' + (d.model || '-') + '</span></div>' +
        '<div class="bl"><span class="k">' + pad('time', 7) + '</span>today ' + dur(d.todayMin || 0) + ' · week ' + dur(d.weekMin || 0) + '</div>' +
        (f ? row('5h', f.pct) : '') + (w ? row('wk', w.pct) : '')
    },
    renderSystem(d) {
      if (!d) return '<div class="bl"><span class="k">no data</span></div>'
      const up = Math.floor((d.upSec || 0) / 60)
      return row('ram', d.ram.pct, (+d.ram.usedG).toFixed(1) + '/' + (+d.ram.totalG).toFixed(1) + 'G') + row('disk', d.disk.pct, d.disk.freeG + 'G free') +
        '<div class="bl"><span class="k">' + pad('up', 6) + '</span><span class="hb">' + (up >= 1440 ? Math.floor(up / 1440) + 'd ' + Math.floor(up % 1440 / 60) + 'h' : Math.floor(up / 60) + 'h ' + (up % 60) + 'm') + '</span></div>'
    },
  }
  const pick = (n) => (window.OverseerBoxes && window.OverseerBoxes[n]) || (window.Boxes && window.Boxes[n]) || stub[n]
  window.BoxesAdapter = {
    status: (d) => pick('renderStatus')(d),
    system: (d) => pick('renderSystem')(d),
  }
})()
