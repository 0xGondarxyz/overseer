'use strict'
;(() => {
  const $ = (s) => document.querySelector(s)
  const ov = window.ov
  let S = { tabs: [], activeId: null, bell: true, panelKey: { key: 'w', ctrl: true }, homeDir: '', ov: { alive: false, shown: false, status: 'asleep' } }
  const terms = new Map()      // id -> { term, fit, host, inner, sent, alive }
  const els = new Map()        // tab id -> element
  let editing = null, confirmId = null, confirmTimer = null, dragId = null
  let mergeMode = false
  const mergeSel = new Set()
  let lastActive = null, lastOvShown = false, lastOvAlive = false, lastStatusKey = ''
  const tabsEl = $('#tabs'), addBtn = $('#addBtn')

  const fmt = (ms) => { const m = Math.max(0, Math.floor(ms / 60000)); if (m < 60) return m + 'm'; const h = Math.floor(m / 60); return h < 24 ? h + 'h' : Math.floor(h / 24) + 'd' }
  const base = (p) => (p || '').split('/').filter(Boolean).pop() || p
  const plain = (t) => t.status === 'notStarted' || t.status === 'exited'
  const stateOf = (t) => (plain(t) ? 'shell' : t.status)
  const timeText = (t) => (plain(t) ? (t.fg || 'shell') : t.status + ' ' + fmt(Date.now() - t.since))
  const shortCwd = (p) => { const h = S.homeDir; return h && p && (p === h || p.startsWith(h + '/')) ? '~' + p.slice(h.length) : p }
  const get = (id) => S.tabs.find((t) => t.id === id)

  // ---------- keys ----------
  // Only these keys are taken by the app; everything else goes to the pty (Ctrl+W is the overseer panel key, S.panelKey).
  function hotName(e) {
    if (e.altKey || e.metaKey) return null
    const k = e.key, lk = String(k).toLowerCase(), P = S.panelKey
    if (P && lk === P.key && !!e.ctrlKey === !!P.ctrl && !!e.shiftKey === !!P.shift) return 'ov'
    if (e.shiftKey && !e.ctrlKey && (k === 'ArrowLeft' || k === 'ArrowRight')) return k === 'ArrowLeft' ? 'prev' : 'next'
    if (!e.ctrlKey && !e.shiftKey && k === 'F2') return 'rename'
    if (e.ctrlKey && e.shiftKey) return { t: 'newtab', w: 'closetab', c: 'copy', v: 'paste' }[lk] || (k === '+' ? 'zoomIn' : null)
    if (e.ctrlKey) return k === '=' || k === '+' ? 'zoomIn' : k === '-' ? 'zoomOut' : k === '0' ? 'zoomReset' : null
    return null
  }
  function focusedTerm() {
    const el = document.activeElement
    for (const [id, e] of terms) if (el && e.inner.contains(el)) return id
    return S.ov.shown && terms.has('overseer') && !terms.has(S.activeId) ? 'overseer' : S.activeId
  }
  function doCopy(id) { const e = terms.get(id); const t = e && e.term.getSelection(); if (t) ov.send('clip:write', t) }
  async function doPaste(id) { const e = terms.get(id); const t = await ov.invoke('clip:read'); if (e && t) e.term.paste(t) }
  function requestClose(id) {
    const cur = get(id)
    if (cur && cur.fg && confirmId !== id) { confirmId = id; clearTimeout(confirmTimer); confirmTimer = setTimeout(() => { confirmId = null; render() }, 4000); render(); return }
    confirmId = null
    ov.send('tab:close', id)
  }
  function act(name) {
    if (name === 'ov') return ov.send('ov:toggle')
    if (name === 'rename') return rename(S.activeId)
    if (name === 'newtab') return ov.send('tab:add', null)
    if (name === 'closetab') return requestClose(S.activeId)
    if (name === 'copy') return doCopy(focusedTerm())
    if (name === 'paste') return doPaste(focusedTerm())
    if (name === 'zoomIn') return ov.send('zoom', 'in')
    if (name === 'zoomOut') return ov.send('zoom', 'out')
    if (name === 'zoomReset') return ov.send('zoom', 'reset')
    const n = S.tabs.length
    if (!n) return
    const i = S.tabs.findIndex((t) => t.id === S.activeId)
    ov.send('tab:select', S.tabs[(i + (name === 'next' ? 1 : -1) + n) % n].id)
  }
  window.addEventListener('keydown', (e) => {
    const h = hotName(e)
    if (!h) return
    if (editing && (h === 'prev' || h === 'next')) return
    e.preventDefault(); e.stopPropagation()
    act(h)
  }, true)
  ov.on('hotkey', act)

  // ---------- terminals ----------
  function ensureTerm(id) {
    let e = terms.get(id)
    if (e) return e
    const isOv = id === 'overseer'
    let host, inner
    if (isOv) { host = $('#ovTerm'); inner = $('#ovTermInner') } else {
      host = document.createElement('div'); host.className = 'term-host'; host.dataset.id = id
      inner = document.createElement('div'); inner.className = 'term-inner'
      host.appendChild(inner); $('#terms').appendChild(host)
    }
    const term = new Terminal({
      // terminal profile: Hack Nerd Font Mono 14 pt (18.67 px), natural line height
      fontFamily: '"Hack Nerd Font Mono", "JetBrains Mono", monospace', fontSize: 18.67, lineHeight: 1.0, cursorBlink: true, scrollback: 5000,
      // Gruvbox Dark, standard values
      theme: {
        background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828', selectionBackground: 'rgba(235,219,178,.25)',
        black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
        brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
      },
    })
    const fit = new FitAddon.FitAddon()
    term.loadAddon(fit)
    term.open(inner)
    term.onData((d) => ov.send('pty:write', id, d))
    if (!isOv) term.onTitleChange((t) => ov.send('tab:title', id, t))
    // Kitty keyboard protocol, "disambiguate" flag only (what Konsole gives Claude Code): Claude asks
    // with CSI ? u, then Ctrl+Enter / Shift+Enter / Alt+Enter arrive as CSI 13;<mods> u, so
    // "ctrl+enter to send now" and Shift+Enter newline work like in Konsole.
    let kflags = 0
    const kstack = []
    term.parser.registerCsiHandler({ prefix: '?', final: 'u' }, () => { ov.send('pty:write', id, `\x1b[?${kflags}u`); return true })
    term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, (p) => { kstack.push(kflags); kflags = (Number(p[0]) || 0) & 1; return true })
    term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, (p) => { for (let n = Number(p[0]) || 1; n > 0; n--) kflags = kstack.length ? kstack.pop() : 0; return true })
    term.parser.registerCsiHandler({ prefix: '=', final: 'u' }, (p) => { const f = (Number(p[0]) || 0) & 1, m = Number(p[1]) || 1; kflags = m === 1 ? f : m === 2 ? kflags | f : kflags & ~f; return true })
    term.attachCustomKeyEventHandler((ev) => {
      if (hotName(ev)) return false
      if ((kflags & 1) && ev.key === 'Enter' && (ev.ctrlKey || ev.shiftKey || ev.altKey) && !ev.metaKey) {
        if (ev.type === 'keydown') { ev.preventDefault(); ov.send('pty:write', id, `\x1b[13;${1 + (ev.shiftKey ? 1 : 0) + (ev.altKey ? 2 : 0) + (ev.ctrlKey ? 4 : 0)}u`) }
        return false
      }
      return true
    })
    term.onSelectionChange(() => { const t = term.getSelection(); if (t) ov.send('clip:primary', t) })
    // middle-click pastes the PRIMARY selection (Konsole style); a mouse-reporting program gets the click unless Shift is held
    inner.addEventListener('mousedown', (ev) => { if (ev.button === 1) ev.preventDefault() }, true)
    inner.addEventListener('mouseup', async (ev) => {
      if (ev.button !== 1 || (term.modes.mouseTrackingMode !== 'none' && !ev.shiftKey)) return
      ev.preventDefault(); ev.stopPropagation()
      const t = await ov.invoke('clip:readPrimary'); if (t) term.paste(t)
    }, true)
    inner.addEventListener('contextmenu', (ev) => { ev.preventDefault(); showCtx(ev.clientX, ev.clientY, id) })
    // dropping files pastes their paths, like Konsole; Claude Code turns an image path into [Image #n]
    inner.addEventListener('dragover', (ev) => { if (ev.dataTransfer && [...ev.dataTransfer.types].includes('Files')) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy' } })
    inner.addEventListener('drop', (ev) => {
      const files = ev.dataTransfer ? [...ev.dataTransfer.files] : []
      if (!files.length) return
      ev.preventDefault(); ev.stopPropagation()
      const paths = files.map((f) => ov.pathForFile(f)).filter(Boolean)
      if (paths.length) { term.paste(dropText(paths)); term.focus() }
    })
    new ResizeObserver(() => refitSoon(id)).observe(inner)
    e = { term, fit, host, inner, sent: null, alive: false, kbd: () => kflags }
    terms.set(id, e)
    return e
  }
  // dropped paths as Konsole pastes them: plain when safe, single-quoted otherwise, space after
  function dropText(paths) {
    const q = (p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : "'" + p.replace(/'/g, "'\\''") + "'")
    return paths.map(q).join(' ') + ' '
  }
  function showCtx(x, y, id) {
    const m = $('#ctx'), e = terms.get(id)
    m.dataset.id = id
    m.querySelector('[data-a="copy"]').disabled = !(e && e.term.hasSelection())
    m.hidden = false
    m.style.left = Math.min(x, innerWidth - m.offsetWidth - 4) + 'px'
    m.style.top = Math.min(y, innerHeight - m.offsetHeight - 4) + 'px'
  }
  $('#ctx').addEventListener('click', (ev) => {
    const b = ev.target.closest('button'); if (!b) return
    const id = $('#ctx').dataset.id
    $('#ctx').hidden = true
    if (b.dataset.a === 'copy') doCopy(id); else doPaste(id)
    const e = terms.get(id); if (e) e.term.focus()
  })
  window.addEventListener('mousedown', (ev) => { if (!ev.target.closest('#ctx')) $('#ctx').hidden = true }, true)
  const pending = new Set()
  let refitTimer = null
  function refitSoon(id) {
    pending.add(id)
    clearTimeout(refitTimer)
    refitTimer = setTimeout(() => { const ids = [...pending]; pending.clear(); ids.forEach(refit) }, 50)
  }
  function refit(id) {
    const e = terms.get(id)
    if (!e || e.inner.clientWidth < 20 || e.inner.clientHeight < 20) return
    try { e.fit.fit() } catch { return }
    const { cols, rows } = e.term
    if (!e.sent || e.sent.cols !== cols || e.sent.rows !== rows) { e.sent = { cols, rows }; ov.send('pty:resize', id, cols, rows) }
  }
  function onDisplay() {
    terms.forEach((e, id) => {
      try { if (e.term.clearTextureAtlas) e.term.clearTextureAtlas(); e.term.refresh(0, e.term.rows - 1) } catch {}
      refitSoon(id)
    })
  }
  function watchDpr() {
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { onDisplay(); watchDpr() }, { once: true })
  }
  watchDpr()
  ov.on('display', onDisplay)
  ov.on('pty:data', (id, d) => ensureTerm(id).term.write(d))

  // ---------- tabs ----------
  function tabEl(t) {
    let el = els.get(t.id)
    if (el) return el
    el = document.createElement('div')
    el.className = 'tab'; el.setAttribute('role', 'tab'); el.tabIndex = 0; el.draggable = true
    el.innerHTML = '<span class="sig"></span><span class="t-stack"><span class="t-title"></span><span class="t-meta"><span class="t-repo"></span><span class="t-time"></span><span class="t-ag"></span></span></span><button type="button" class="t-x" aria-label="Close tab">×</button>'
    const id = t.id
    el.addEventListener('click', (e) => { if (e.target.closest('.t-x') || e.target.closest('input')) return; ov.send('tab:select', id); const x = terms.get(id); if (x) x.term.focus() })
    el.addEventListener('keydown', (e) => { if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ov.send('tab:select', id) } })
    el.querySelector('.t-title').addEventListener('dblclick', (e) => { e.stopPropagation(); rename(id) })
    el.querySelector('.t-x').addEventListener('click', (e) => { e.stopPropagation(); requestClose(id) })
    // middle-click on the tab strip closes the tab, same rule as ×
    el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault() })
    el.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); requestClose(id) } })
    el.addEventListener('dragstart', (e) => { if (editing === id) { e.preventDefault(); return } dragId = id; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', id) } catch {} })
    el.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); clearDrop() })
    el.addEventListener('dragover', (e) => {
      if (dragId == null || dragId === id) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      clearDrop(); el.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after')
    })
    el.addEventListener('drop', (e) => {
      e.preventDefault()
      if (dragId == null || dragId === id) return
      const r = el.getBoundingClientRect()
      ov.send('tab:move', dragId, id, e.clientX < r.left + r.width / 2)
      clearDrop()
    })
    els.set(id, el)
    return el
  }
  const clearDrop = () => tabsEl.querySelectorAll('.drop-before,.drop-after').forEach((e) => e.classList.remove('drop-before', 'drop-after'))

  function rename(id) {
    const t = get(id), el = els.get(id)
    if (!t || !el || editing === id) return
    editing = id; el.draggable = false
    ov.send('editing', true)
    ov.send('tab:select', id)
    const span = el.querySelector('.t-title')
    span.textContent = ''
    const inp = document.createElement('input')
    inp.className = 't-edit'; inp.value = t.title; inp.maxLength = 60; inp.setAttribute('aria-label', 'Tab name')
    span.appendChild(inp); inp.focus(); inp.select()
    const finish = (save) => {
      if (editing !== id) return
      editing = null; el.draggable = true
      ov.send('editing', false)
      if (save) ov.send('tab:rename', id, inp.value)
      render()
      const x = terms.get(S.activeId); if (x) x.term.focus()
    }
    inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false) })
    inp.addEventListener('blur', () => finish(true))
  }

  function renderTabs() {
    els.forEach((el, id) => { if (!get(id)) { el.remove(); els.delete(id) } })
    S.tabs.forEach((t, i) => {
      const el = tabEl(t)
      if (tabsEl.children[i] !== el) tabsEl.insertBefore(el, tabsEl.children[i] || addBtn)
      el.dataset.state = stateOf(t); el.dataset.status = t.status; el.dataset.id = t.id
      el.setAttribute('aria-selected', t.id === S.activeId ? 'true' : 'false')
      el.title = t.title + ' · ' + shortCwd(t.cwd)
      if (editing !== t.id) el.querySelector('.t-title').textContent = t.title
      el.querySelector('.t-repo').textContent = shortCwd(t.cwd)
      el.querySelector('.t-time').textContent = timeText(t)
      const run = t.subagents.filter((s) => s.running).length
      el.querySelector('.t-ag').textContent = run ? '◐' + run : ''
      const x = el.querySelector('.t-x')
      x.textContent = confirmId === t.id ? 'close?' : '×'
      x.classList.toggle('confirm', confirmId === t.id)
    })
  }

  // ---------- pane ----------
  function renderPane() {
    const t = get(S.activeId)
    S.tabs.forEach((x) => {
      const e = ensureTerm(x.id)
      e.host.classList.toggle('active', x.id === S.activeId)
      if (x.ptyAlive && !e.alive) { e.alive = true; e.sent = null; refitSoon(x.id) }
      if (!x.ptyAlive) e.alive = false
    })
    terms.forEach((e, id) => { if (id !== 'overseer' && !get(id)) { e.term.dispose(); e.host.remove(); terms.delete(id) } })
    if (S.activeId !== lastActive) {
      lastActive = S.activeId
      refitSoon(S.activeId)
      const e = terms.get(S.activeId)
      if (e && !S.ov.shown) setTimeout(() => e.term.focus(), 0)
    }
    const strip = $('#strip')
    strip.hidden = !(t && t.strip)
    if (t && t.strip) $('#stripText').textContent = 'Last session: ' + (t.sessTitle || t.title)
    const ag = $('#agents')
    const subs = t ? t.subagents.filter((s) => s.running).slice(-6) : [] // finished subagents leave the list
    ag.hidden = !subs.length
    if (subs.length) {
      const sp = '◐◓◑◒'[Math.floor(Date.now() / 500) % 4]
      ag.innerHTML = '<div class="ag"><span class="ag-i">●</span><span class="ag-n">main</span><span class="ag-t"></span><span></span></div>' +
        subs.map(() => '<div class="ag"><span class="ag-i"></span><span class="ag-n">subagent</span><span class="ag-t"></span><span class="ag-m"></span></div>').join('')
      const rows = ag.querySelectorAll('.ag:not(:first-child)')
      subs.forEach((s, i) => {
        rows[i].classList.toggle('done', !s.running)
        rows[i].querySelector('.ag-i').textContent = s.running ? sp : '✓'
        rows[i].querySelector('.ag-t').textContent = s.desc
        rows[i].querySelector('.ag-m').textContent = (s.running ? '' : 'done · ') + fmt(Date.now() - s.start)
      })
    }
  }

  function renderStatusbar() {
    const sb = $('#statusbar'), n = (st) => S.tabs.filter((t) => stateOf(t) === st).length, t = get(S.activeId)
    const parts = []
    const add = (txt, cls, html) => parts.push('<span' + (cls ? ' class="' + cls + '"' : '') + '>' + (html || txt) + '</span>')
    add(n('working') + ' working')
    if (n('done')) add(n('done') + ' done', 's-gold')
    if (n('needs')) add(n('needs') + ' needs you', 's-red')
    if (t && t.contextPct != null) add('', 'ctx' + (t.contextPct >= 80 ? ' warn' : ''), 'context <i><b style="width:' + t.contextPct + '%"></b></i> ' + t.contextPct + '%')
    add('', 's-keys s-hide', '<b>⇧ ← →</b> switch · <b>Ctrl ⇧ T/W</b> new/close · <b>Ctrl W</b> overseer · <b>F2</b> rename')
    add(S.ov.alive ? (S.ov.shown ? 'overseer awake' : 'overseer minimized') : 'overseer asleep', 's-right')
    sb.innerHTML = parts.join('')
    $('#brandSub').textContent = S.tabs.length + (S.tabs.length === 1 ? ' tab' : ' tabs')
  }

  // ---------- overseer ----------
  function renderOverseer() {
    const o = S.ov
    $('#ov').hidden = !o.shown
    $('#wakeLbl').textContent = o.alive ? (o.shown ? 'Hide overseer' : 'Show overseer') : 'Wake overseer'
    $('#ovPath').textContent = o.home || ''
    $('#ovStatus').textContent = o.status
    if (o.alive) ensureTerm('overseer')
    if (lastOvAlive && !o.alive) { const e = terms.get('overseer'); if (e) { e.term.dispose(); terms.delete('overseer'); $('#ovTermInner').innerHTML = '' } }
    if (o.alive && !lastOvAlive) { const e = terms.get('overseer'); if (e) e.sent = null }
    if (o.shown && !lastOvShown) setTimeout(() => { refitSoon('overseer'); const e = terms.get('overseer'); if (e) e.term.focus() }, 0)
    if (!o.shown && lastOvShown) { const e = terms.get(S.activeId); if (e) setTimeout(() => e.term.focus(), 0) }
    lastOvShown = o.shown; lastOvAlive = o.alive
    const list = $('#ovList')
    list.innerHTML = ''
    S.tabs.forEach((t, i) => {
      const li = document.createElement('li')
      li.className = 'ov-item'; li.dataset.state = stateOf(t)
      li.innerHTML = '<label><input type="checkbox"><span><div class="ov-t"></div><div class="ov-s"></div></span></label>'
      const cb = li.querySelector('input'); cb.dataset.n = i + 1; cb.checked = mergeSel.has(i + 1)
      li.querySelector('.ov-t').textContent = t.title
      li.querySelector('.ov-s').textContent = timeText(t) + (t.lastReply ? ' · ' + t.lastReply.replace(/\s+/g, ' ').slice(0, 70) : '')
      list.appendChild(li)
    })
    updateMerge()
  }
  function updateMerge() {
    const n = mergeSel.size, b = $('#ovMerge')
    b.disabled = n !== 2
    b.textContent = n === 2 ? 'Merge into a new tab' : n > 2 ? 'Pick only 2' : 'Pick 2 tabs'
  }
  function typeToOverseer(text) {
    ov.send('pty:write', 'overseer', text)
    setTimeout(() => ov.send('pty:write', 'overseer', '\r'), 150)
  }
  $('#ovList').addEventListener('change', (e) => {
    const n = Number(e.target.dataset.n)
    e.target.checked ? mergeSel.add(n) : mergeSel.delete(n)
    updateMerge()
  })
  $('#ovMergeMode').addEventListener('click', () => {
    mergeMode = !mergeMode; mergeSel.clear()
    $('#ovTabs').classList.toggle('merging', mergeMode)
    $('#ovMerge').hidden = !mergeMode
    $('#ovMergeMode').textContent = mergeMode ? 'Cancel merge' : 'Merge two tabs'
    renderOverseer()
  })
  $('#ovMerge').addEventListener('click', async () => {
    const [a, b] = [...mergeSel].sort((x, y) => x - y)
    const text = await ov.invoke('merge:prompt', a, b)
    if (text) typeToOverseer(text)
    $('#ovMergeMode').click()
  })
  $('#ovChips').addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON' && S.ov.alive) typeToOverseer(e.target.textContent) })
  $('#ovSleep').addEventListener('click', () => ov.send('ov:sleep'))
  $('#ovHide').addEventListener('click', () => ov.send('ov:hide'))
  $('#wakeBtn').addEventListener('click', () => ov.send('ov:toggle'))

  // ---------- top bar, pane buttons, quit ----------
  $('#bellBtn').addEventListener('click', () => { S.bell = !S.bell; ov.send('bell', S.bell); $('#bellBtn').setAttribute('aria-pressed', String(S.bell)) })
  addBtn.addEventListener('click', () => ov.send('tab:add', null))
  addBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); ov.send('tab:pick') })
  $('#stripCont').addEventListener('click', () => { ov.send('tab:start', S.activeId, 'continue'); const e = terms.get(S.activeId); if (e) e.term.focus() })
  $('#stripNew').addEventListener('click', () => { ov.send('tab:start', S.activeId, 'new'); const e = terms.get(S.activeId); if (e) e.term.focus() })
  $('#stripX').addEventListener('click', () => ov.send('tab:strip', S.activeId))
  $('#railBtn').addEventListener('click', () => { const s = $('#side'); s.classList.toggle('open'); $('#railBtn').textContent = s.classList.contains('open') ? '›' : '‹'; onDisplay() })
  document.querySelectorAll('.bx').forEach((b) => b.addEventListener('click', () => $('#' + b.dataset.box).classList.toggle('min')))
  function showQuit() {
    const w = S.tabs.filter((t) => t.status === 'working').length
    $('#quitText').textContent = (w ? w + ' tab' + (w > 1 ? 's are' : ' is') + ' still working. ' : '') + 'Every shell closes. Tabs come back next time as live shells in their folders.'
    $('#quitModal').hidden = false
    $('#quitNo').focus()
  }
  $('#quitBtn').addEventListener('click', showQuit)
  ov.on('quit:ask', showQuit)
  $('#quitYes').addEventListener('click', () => ov.send('quit'))
  $('#quitNo').addEventListener('click', () => { $('#quitModal').hidden = true })
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#quitModal').hidden) $('#quitModal').hidden = true })

  // ---------- bell ----------
  window.__bells = 0
  ov.on('bell', () => {
    window.__bells++
    if (!S.bell) return
    try {
      const c = new (window.AudioContext || window.webkitAudioContext)(), o = c.createOscillator(), g = c.createGain()
      o.frequency.value = 880; g.gain.value = 0.08; o.connect(g); g.connect(c.destination)
      o.start(); o.stop(c.currentTime + 0.18); o.onended = () => c.close()
    } catch {}
  })

  // ---------- right column ----------
  async function refreshBox(kind) {
    const t = get(S.activeId)
    const d = await ov.invoke('boxes:get', kind, t && t.sessionId)
    if (kind === 'status') { $('#useBody').innerHTML = BoxesAdapter.status(d) }
    else if (kind === 'system') {
      $('#sysBody').innerHTML = BoxesAdapter.system(d)
      const n = new Date((d && d.now) || Date.now()), days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
      $('#clock').textContent = String(n.getHours()).padStart(2, '0') + ':' + String(n.getMinutes()).padStart(2, '0') + ' ' + days[n.getDay()] + ' ' + n.getDate()
    }
  }
  const busy = new Set()
  const guard = (k) => () => { if (busy.has(k)) return; busy.add(k); refreshBox(k).catch(() => {}).finally(() => busy.delete(k)) }
  guard('system')(); guard('status')()
  setInterval(guard('system'), 10000); setInterval(guard('status'), 15000)

  // ---------- main loop ----------
  function render() {
    renderTabs(); renderPane(); renderStatusbar(); renderOverseer()
    $('#bellBtn').setAttribute('aria-pressed', String(S.bell))
    const t = get(S.activeId)
    const key = t ? t.sessionId + ':' + t.status : ''
    if (key !== lastStatusKey) { lastStatusKey = key; guard('status')() }
  }
  ov.on('state', (s) => { S = s; render() })
  setInterval(() => { if (!editing) render() }, 15000)

  function screenText(id, n = 40) {
    const e = terms.get(id); if (!e) return ''
    const b = e.term.buffer.active, lines = []
    for (let i = 0; i < b.length; i++) { const l = b.getLine(i); lines.push(l ? l.translateToString(true) : '') }
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
    return lines.slice(-n).join('\n')
  }
  ov.on('screens:req', () => { const o = {}; S.tabs.forEach((t) => { o[t.id] = screenText(t.id) }); ov.send('screens', o) })

  window.__ovTest = {
    screenText,
    kflags(id) { const e = terms.get(id); return e ? e.kbd() : null },
    opts(id) { const e = terms.get(id); return e ? { fontFamily: e.term.options.fontFamily, fontSize: e.term.options.fontSize, lineHeight: e.term.options.lineHeight } : null },
    select(id, text) { const e = terms.get(id); if (!e) return ''; e.term.selectAll(); return e.term.getSelection() },
    selectText(id, needle) {
      const e = terms.get(id); if (!e) return ''
      const b = e.term.buffer.active
      for (let i = b.length - 1; i >= 0; i--) { const l = b.getLine(i), x = l ? l.translateToString(true) : ''; const c = x.indexOf(needle); if (c >= 0 && x.trim() === needle) { e.term.select(c, i, needle.length); return e.term.getSelection() } }
      return ''
    },
    clearSel(id) { const e = terms.get(id); if (e) e.term.clearSelection() },
    scroll(id) { const b = terms.get(id).term.buffer.active; return { y: b.viewportY, base: b.baseY } },
    toBottom(id) { terms.get(id).term.scrollToBottom() },
    selection(id) { const e = terms.get(id); return e ? e.term.getSelection() : '' },
    dims(id) {
      const e = terms.get(id)
      if (!e) return null
      const sc = e.inner.querySelector('.xterm-screen')
      return { cols: e.term.cols, rows: e.term.rows, innerW: e.inner.clientWidth, innerH: e.inner.clientHeight, screenW: sc ? sc.offsetWidth : 0, screenH: sc ? sc.offsetHeight : 0, dpr: devicePixelRatio }
    },
    text(id) { const e = terms.get(id); if (!e) return ''; const b = e.term.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true) + '\n' } return s },
  }
})()
