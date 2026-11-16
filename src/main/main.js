'use strict'
const { app, BrowserWindow, Menu, Tray, nativeImage, clipboard, ipcMain, screen, dialog } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const TEST = !!process.env.OVERSEER_TEST
const HIDDEN = process.argv.includes('--hidden')
// The key that shows/hides the overseer panel. null = no key (the button still works).
const OVERSEER_PANEL_KEY = { key: 'w', ctrl: true }
if (process.env.OVERSEER_USERDATA) app.setPath('userData', process.env.OVERSEER_USERDATA)
if (TEST) app.commandLine.appendSwitch('mute-audio')

const ROOT = path.resolve(__dirname, '..', '..')
const { resolveEnv } = require('./env')
const { spawnPty, tabEnv, claudeArgs, shellArgs, claudeWithPromptFile } = require('./pty')
const { Hub, sockPath } = require('./hub')
const { newTab, reduce, fmtDur } = require('./state')
const { createStore, usableBounds } = require('./store')
const ov = require('./overseer')
const adapter = require('./providers-adapter')

const HOME_DIR = ov.HOME_DIR
let win = null, hub = null, store = null, env = null, hooksFile = null, quitting = false
let tabs = []            // tab state objects, in display order
let activeId = null
let bell = true
let bounds = null
let nextId = 1
const ptys = new Map()   // tab id -> { h, cols, rows }
const sizes = new Map()  // tab id -> last size reported by the renderer
let ovState = { alive: false, shown: false, status: 'asleep', sessionId: null }
let ovPty = null
let ovTab = null         // pseudo tab used to track the overseer's status
let zoom = 1
let tray = null, trayMenu = null
let lastScreens = {}     // tab id -> last 40 screen lines (from the renderer's xterm buffers)
let primaryText = ''
const SHIM = path.join(ROOT, 'bin', 'shim')
const shellName = () => path.basename((env && env.shell) || 'bash')

const find = (id) => tabs.find((t) => t.id === String(id))
const send = (ch, ...a) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...a) }

// ---------- persistence ----------
function persist() {
  store.save({
    tabs: tabs.map((t) => ({ id: t.id, title: t.title, renamed: t.renamed, cwd: t.cwd, sessionId: t.sessionId, sessTitle: t.sessTitle })),
    activeId, bell, nextId, bounds, zoom,
  })
}

function pushState() {
  send('state', {
    tabs: tabs.map((t) => ({ ...t, ptyAlive: ptys.has(t.id) })),
    activeId, bell, now: Date.now(), zoom, panelKey: OVERSEER_PANEL_KEY, homeDir: os.homedir(),
    ov: { ...ovState, home: HOME_DIR },
  })
  const a = find(activeId)
  if (win && !win.isDestroyed() && a && win.getTitle() !== a.title) win.setTitle(a.title)
}

function changed({ save = true } = {}) {
  if (ovState.alive) writeTabsMd()
  if (save) persist()
  pushState()
}

function writeTabsMd() {
  try {
    fs.mkdirSync(ov.CACHE(), { recursive: true })
    fs.writeFileSync(path.join(ov.CACHE(), 'tabs.md'), ov.renderTabsMd(tabs, Date.now(), lastScreens))
  } catch {}
}

/** Ask the renderer for the last 40 screen lines of every tab, then rewrite tabs.md. */
function refreshScreens(timeout = 800) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve()
    let done = false
    const finish = () => { if (done) return; done = true; ipcMain.removeListener('screens', onReply); clearTimeout(tm); resolve() }
    const onReply = (_e, obj) => { lastScreens = obj || {}; writeTabsMd(); finish() }
    const tm = setTimeout(finish, timeout)
    ipcMain.on('screens', onReply)
    send('screens:req')
  })
}

// ---------- tabs ----------
function addTab(cwd, extra = {}) {
  const t = { ...newTab({ id: nextId++, cwd: cwd || HOME_DIR }), ...extra }
  tabs.push(t)
  return t
}

function patch(id, o) {
  const i = tabs.findIndex((x) => x.id === id)
  if (i >= 0) tabs[i] = { ...tabs[i], ...o }
  return tabs[i]
}

function apply(t, evt) {
  const prev = t.status
  let next = reduce(t, evt, { active: t.id === activeId, now: Date.now() })
  if (next.status !== 'notStarted' && next.status !== 'exited' && next.title) next = { ...next, sessTitle: next.title }
  const i = tabs.indexOf(t)
  if (i >= 0) tabs[i] = next
  if (next.status !== prev && (next.status === 'done' || next.status === 'needs')) {
    if (!(t.id === activeId && win && win.isFocused())) send('bell', next.status)
  }
  return next
}

/** Start the login shell in the tab's folder. */
function startShell(t) {
  if (ptys.has(t.id)) return null
  const cwd = fs.existsSync(t.cwd) ? t.cwd : os.homedir()
  const sz = sizes.get(t.id) || { cols: 120, rows: 40 }
  const rec = { lastData: 0, firstData: 0, waiters: [] }
  try {
    rec.h = spawnPty({
      file: env.shell, args: shellArgs(env.shell, SHIM), cwd, cols: sz.cols, rows: sz.rows,
      env: tabEnv(env.env, { sock: hub.path, tab: t.id, root: ROOT, hooksFile, realClaude: env.claude, shim: SHIM }),
      onData: (d) => {
        send('pty:data', t.id, d)
        rec.lastData = Date.now()
        if (!rec.firstData) rec.firstData = rec.lastData
      },
      onExit: () => {
        if (ptys.get(t.id) !== rec) return
        ptys.delete(t.id)
        if (!quitting && find(t.id)) closeTab(t.id)  // `exit` in the shell closes the tab
      },
    })
  } catch (e) {
    send('pty:data', t.id, `\r\n\x1b[31mCould not start ${env.shell}: ${e.message}\x1b[0m\r\n`)
    return null
  }
  ptys.set(t.id, rec)
  changed()
  return rec
}

/** Run fn once the shell has printed its first prompt and gone quiet (or after 4 s). */
function whenShellReady(rec, fn) {
  const t0 = Date.now()
  const tick = () => {
    const quiet = rec.firstData && Date.now() - rec.lastData > 300
    if (quiet || Date.now() - t0 > 4000) fn(); else setTimeout(tick, 100)
  }
  tick()
}

function closeTab(id) {
  const t = find(id)
  if (!t) return
  const rec = ptys.get(t.id)
  ptys.delete(t.id)
  if (rec) rec.h.kill()
  const i = tabs.indexOf(t)
  tabs.splice(i, 1)
  delete lastScreens[t.id]
  if (!tabs.length) { const n = addTab(); activeId = n.id; startShell(n) }
  else if (activeId === t.id) activeId = tabs[Math.min(i, tabs.length - 1)].id
  changed()
}

function selectTab(id) {
  const t = find(id)
  if (!t) return
  activeId = t.id
  apply(t, { event: '_select' })
  changed()
}

function lookup(ref) {
  const s = String(ref)
  if (/^\d+$/.test(s)) return tabs[Number(s) - 1]
  const low = s.toLowerCase()
  return tabs.find((t) => t.title.toLowerCase() === low) || tabs.find((t) => t.title.toLowerCase().includes(low))
}

let pollTick = 0
/** Every second: foreground program per tab (claude exit detection); every 2nd second: shell folder. */
function pollShells() {
  pollTick++
  let any = false
  for (const t of tabs.slice()) {
    const rec = ptys.get(t.id)
    if (!rec || !rec.h) continue
    let fg = null
    try { const p = String(rec.h.pty.process || ''); fg = path.basename(p.split(' ')[0]) === shellName() ? null : p.split(' ')[0] } catch {}
    let cwd = t.cwd
    if (pollTick % 2 === 0) { try { cwd = fs.readlinkSync(`/proc/${rec.h.pty.pid}/cwd`) } catch {} }
    let cur = find(t.id)
    if (cur.fg !== fg) { cur = patch(cur.id, { fg }); any = true }
    if (cwd !== cur.cwd) { cur = apply(cur, { event: '_cwd', cwd }); any = true }
    if (!fg && cur.status !== 'notStarted') { apply(cur, { event: '_shell' }); any = true }
  }
  if (any) changed()
}

function refreshBridge() {
  let any = false
  tabs.forEach((t, i) => {
    if (!ptys.has(t.id)) return
    const b = ov.readBridge(t.sessionId)
    if (b && (b.contextPct !== t.contextPct || (b.model && b.model !== t.model) || (b.effort && b.effort !== t.effort))) {
      tabs[i] = { ...t, contextPct: b.contextPct, model: b.model || t.model, effort: b.effort || t.effort }
      any = true
    }
  })
  if (any) changed({ save: false })
}

// ---------- overseer ----------
async function wake() {
  if (!ovPty) {
    await refreshScreens()
    const sessionId = crypto.randomUUID()
    const promptFile = ov.writePrompt({ root: ROOT, node: env.node || process.execPath })
    const args = claudeArgs({ hooksFile, root: ROOT, promptFile, mode: { kind: 'overseer', sessionId, prompt: ov.firstPrompt() } })
    ovTab = newTab({ id: 'overseer', cwd: HOME_DIR, sessionId })
    ovState = { ...ovState, alive: true, sessionId, status: 'idle' }
    writeTabsMd()
    const rec = {}
    try {
      rec.h = spawnPty({
        file: env.claude, args, cwd: HOME_DIR, cols: 100, rows: 30,
        env: tabEnv(env.env, { sock: hub.path, tab: 'overseer', root: ROOT }),
        onData: (d) => send('pty:data', 'overseer', d),
        onExit: () => { if (ovPty === rec) { ovPty = null; ovState = { ...ovState, alive: false, shown: false, status: 'asleep' }; changed({ save: false }) } },
      })
      ovPty = rec
    } catch (e) { ovState = { ...ovState, alive: false, status: 'asleep' } }
  }
  ovState = { ...ovState, shown: true }
  changed({ save: false })
}

function sleep() {
  const rec = ovPty
  ovPty = null
  if (rec) rec.h.kill()
  ovState = { alive: false, shown: false, status: 'asleep', sessionId: null }
  changed({ save: false })
}

function toggleOverseer() {
  if (!ovPty) wake()
  else { ovState = { ...ovState, shown: !ovState.shown }; changed({ save: false }) }
}

// ---------- hub ----------
function onHook({ tab, event, payload }) {
  if (tab === 'overseer') {
    if (ovTab) {
      ovTab = reduce(ovTab, { event, payload }, { active: true })
      ovState = { ...ovState, status: ovTab.status === 'working' ? 'working' : ovPty ? 'idle' : 'asleep' }
      pushState()
    }
    return
  }
  const t = find(tab)
  if (!t) return
  let n = apply(t, { event, payload })
  if (event === 'SessionStart' && n.strip) n = patch(n.id, { strip: false })
  const b = ov.readBridge(n.sessionId)
  if (b) { const i = tabs.indexOf(n); tabs[i] = { ...n, contextPct: b.contextPct, model: b.model || n.model, effort: b.effort || n.effort } }
  changed()
}

async function cli({ cmd, args = {} }) {
  if (cmd === 'list') {
    const now = Date.now()
    return tabs.map((t, i) => ({ n: i + 1, title: t.title, cwd: t.cwd, status: t.status, since: fmtDur(now - t.since), sessionId: t.sessionId, transcriptPath: t.transcriptPath, fg: t.fg }))
  }
  if (cmd === 'send') {
    const t = lookup(args.tab)
    if (!t) throw new Error(`no tab "${args.tab}"`)
    const rec = ptys.get(t.id)
    if (!rec) throw new Error(`tab "${t.title}" is not started`)
    // A tab waiting on a permission prompt or a question is the user's to answer, never the overseer's
    // (same boundary as Claude Code's own cross-session messaging).
    if (t.status === 'needs') throw new Error(`tab ${t.title} is waiting for you (a permission prompt or a question); only you can answer it`)
    rec.h.write(String(args.text))
    setTimeout(() => rec.h.write('\r'), 150)
    return `sent to ${t.title}`
  }
  if (cmd === 'new') {
    const cwd = args.cwd || HOME_DIR
    if (!fs.existsSync(cwd)) throw new Error(`folder does not exist: ${cwd}`)
    if (args.promptFile && !fs.existsSync(args.promptFile)) throw new Error(`prompt file does not exist: ${args.promptFile}`)
    const t = addTab(cwd, args.title ? { title: args.title, renamed: true } : {})
    activeId = t.id
    const rec = startShell(t)
    if (rec && args.promptFile) whenShellReady(rec, () => rec.h.write(claudeWithPromptFile(env.shell, args.promptFile) + '\r'))
    changed()
    return `opened tab ${tabs.length}: ${t.title}`
  }
  if (cmd === 'toggle') return toggleWindow()
  // used by bin/overseer-toggle on KDE: it asks the state, shows the window, then a KWin script
  // moves it to the monitor under the mouse and focuses it (or minimizes it), like Yakuake
  if (cmd === 'state') return { visible: !!(win && !win.isDestroyed() && win.isVisible()) }
  if (cmd === 'show') { showWin(); return 'shown' }
  if (cmd === 'close') {
    const found = (args.tabs || []).map(lookup).filter(Boolean)
    if (!found.length) throw new Error('no such tabs')
    found.forEach((t) => closeTab(t.id))
    return `closed ${found.length}`
  }
  throw new Error('unknown command ' + cmd)
}

// ---------- window ----------
// Keys the app takes. Everything else (Ctrl+W, Ctrl+R, Ctrl+C, Ctrl+V, all Alt combos) goes to the pty.
const HOT = (i) => {
  if (i.type !== 'keyDown' || i.alt || i.meta) return null
  const k = String(i.key)
  const lk = k.toLowerCase()
  const P = OVERSEER_PANEL_KEY
  if (P && lk === P.key && !!i.control === !!P.ctrl && !!i.shift === !!P.shift) return 'ov'
  if (i.shift && !i.control && (k === 'ArrowLeft' || k === 'ArrowRight')) return k === 'ArrowLeft' ? 'prev' : 'next'
  if (!i.control && !i.shift && k === 'F2') return 'rename'
  if (i.control && i.shift) return { t: 'newtab', w: 'closetab', c: 'copy', v: 'paste' }[lk] || (k === '+' ? 'zoomIn' : null)
  if (i.control && !i.shift) return k === '=' || k === '+' ? 'zoomIn' : k === '-' ? 'zoomOut' : k === '0' ? 'zoomReset' : null
  return null
}
let editing = false
let shellsStarted = false

/** Show the window and focus it. */
function showWin() {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show(); win.focus()
}
/** Plain show/hide (tray click, and Alt+W outside KDE): hide when visible and focused, else show
 * and focus. On KDE, bin/overseer-toggle uses a KWin script instead, which also moves the window
 * to the monitor under the mouse, like Yakuake. */
function toggleWindow() {
  if (!win || win.isDestroyed()) return 'no window'
  if (win.isVisible() && !win.isMinimized() && win.isFocused()) { win.hide(); return 'hidden' }
  showWin()
  return 'shown'
}

function setZoom(z) {
  zoom = Math.max(0.8, Math.min(2.0, Math.round(z * 10) / 10))
  if (win && !win.isDestroyed()) win.webContents.setZoomFactor(zoom)
  persist()
  send('display')
}

function makeTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray.png')))
    tray.setToolTip('Overseer')
    trayMenu = Menu.buildFromTemplate([
      { label: 'Open Overseer', click: showWin },
      { label: 'Quit Overseer', click: () => { showWin(); send('quit:ask') } },
    ])
    tray.setContextMenu(trayMenu)
    tray.on('click', toggleWindow)
  } catch (e) { console.error('tray failed', e.message) }
}

function captureBounds() {
  if (!win || win.isDestroyed() || win.isMaximized() || win.isMinimized()) return false
  const r = win.getBounds()
  bounds = { ...r, displayId: screen.getDisplayMatching(r).id }
  return true
}

function createWindow() {
  const displays = screen.getAllDisplays()
  const b = usableBounds(bounds, displays)
  const prim = screen.getPrimaryDisplay().workArea
  const w = b ? b.width : Math.min(1500, prim.width), h = b ? b.height : Math.min(900, prim.height)
  win = new BrowserWindow({
    width: w, height: h,
    x: b ? b.x : prim.x + Math.round((prim.width - w) / 2), y: b ? b.y : prim.y + Math.round((prim.height - h) / 2),
    show: !TEST && !HIDDEN, backgroundColor: '#282828', title: 'Overseer', autoHideMenuBar: true,
    webPreferences: { preload: path.join(ROOT, 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: !TEST, offscreen: TEST },
  })
  win.setMenuBarVisibility(false)
  if (TEST) win.setBounds({ x: b ? b.x : prim.x, y: b ? b.y : prim.y, width: w, height: h }) // offscreen ignores the constructor size
  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'))
  win.webContents.on('before-input-event', (e, input) => {
    const hot = HOT(input)
    if (!hot) return
    if (editing && (hot === 'prev' || hot === 'next')) return
    e.preventDefault()
    send('hotkey', hot)
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('page-title-updated', (e) => e.preventDefault())
  win.webContents.on('did-finish-load', () => {
    win.webContents.setZoomFactor(zoom)
    pushState()
    if (!shellsStarted) { shellsStarted = true; tabs.forEach(startShell) }
  })
  const saveBounds = () => { if (captureBounds()) persist() }
  win.on('moved', () => { saveBounds(); send('display') })
  win.on('resize', saveBounds)
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide() } })  // × hides to the tray; ptys keep running
  win.on('closed', () => { win = null })
  const display = () => send('display')
  screen.on('display-metrics-changed', display)
  screen.on('display-added', display)
  screen.on('display-removed', display)
}

function wireIpc() {
  const on = (ch, fn) => ipcMain.on(ch, (_e, ...a) => fn(...a))
  on('pty:write', (id, data) => { const r = id === 'overseer' ? ovPty : ptys.get(String(id)); if (r) r.h.write(data) })
  on('pty:resize', (id, cols, rows) => {
    if (!(cols > 0 && rows > 0)) return
    if (id === 'overseer') { if (ovPty) ovPty.h.resize(cols, rows); return }
    sizes.set(String(id), { cols, rows })
    const r = ptys.get(String(id)); if (r) r.h.resize(cols, rows)
  })
  on('tab:select', selectTab)
  on('tab:start', (id, kind) => {
    const t = find(id), rec = t && ptys.get(t.id)
    if (!rec) return
    patch(t.id, { strip: false })
    rec.h.write(kind === 'continue' && t.sessionId ? `claude --resume ${t.sessionId}\r` : 'claude\r')
    changed()
  })
  on('tab:strip', (id) => { if (find(id)) { patch(String(id), { strip: false }); changed() } })
  on('tab:add', (cwd) => { const t = addTab(cwd); activeId = t.id; startShell(t); changed() })
  on('tab:pick', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'], defaultPath: HOME_DIR })
    if (!r.canceled && r.filePaths[0]) { const t = addTab(r.filePaths[0]); activeId = t.id; startShell(t); changed() }
  })
  on('tab:close', closeTab)
  on('tab:rename', (id, title) => { const t = find(id); if (t) { apply(t, { event: '_rename', title }); changed() } })
  on('tab:title', (id, title) => { const t = find(id); if (t) { const p = t.title; const n = apply(t, { event: '_title', title }); if (n.title !== p) changed() } })
  on('tab:move', (id, targetId, before) => {
    const t = find(id), tg = find(targetId)
    if (!t || !tg || t === tg) return
    tabs.splice(tabs.indexOf(t), 1)
    tabs.splice(tabs.indexOf(tg) + (before ? 0 : 1), 0, t)
    changed()
  })
  on('editing', (v) => { editing = !!v })
  on('zoom', (d) => setZoom(d === 'reset' ? 1 : zoom + (d === 'in' ? 0.1 : -0.1)))
  on('clip:write', (t) => { if (t) clipboard.writeText(String(t)) })
  on('clip:primary', (t) => { primaryText = String(t || ''); if (primaryText) { try { clipboard.writeText(primaryText, 'selection') } catch {} } })
  ipcMain.handle('clip:read', () => clipboard.readText())
  ipcMain.handle('clip:readPrimary', () => { let t = ''; try { t = clipboard.readText('selection') } catch {} return t || primaryText })
  on('ov:toggle', toggleOverseer)
  on('ov:hide', () => { ovState = { ...ovState, shown: false }; changed({ save: false }) })
  on('ov:sleep', sleep)
  on('bell', (v) => { bell = !!v; persist() })
  on('quit', () => { quitting = true; app.quit() })
  ipcMain.handle('boxes:get', (_e, kind, sessionId) => (kind === 'system' ? adapter.getSystem() : adapter.getStatus(sessionId)))
  ipcMain.handle('merge:prompt', (_e, a, b) => {
    const ta = tabs[a - 1], tb = tabs[b - 1]
    return ta && tb ? ov.mergePrompt(ta, tb, a, b) : null
  })
}

app.on('before-quit', () => { quitting = true; if (captureBounds()) persist() })
app.on('will-quit', () => {
  try { ptys.forEach((r) => r.h.kill()); if (ovPty) ovPty.h.kill() } catch {}
  try { store.flush() } catch {}
  try { hub && hub.stop() } catch {}
})
app.on('second-instance', (_e, argv) => { if (!(argv || []).includes('--hidden')) showWin() })

// userData is set at the top of this file, so the lock (and tests) use their own directory
if (!app.requestSingleInstanceLock()) app.quit()
else app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  store = createStore(app.getPath('userData'))
  env = resolveEnv()
  hooksFile = path.join(app.getPath('userData'), 'hooks.json')
  fs.mkdirSync(app.getPath('userData'), { recursive: true })
  fs.writeFileSync(hooksFile, JSON.stringify(ov.buildHooksConfig({ node: env.node || process.execPath, root: ROOT }), null, 2))

  const saved = store.load()
  if (saved && Array.isArray(saved.tabs) && saved.tabs.length) {
    tabs = saved.tabs.map((s) => ({ ...newTab({ id: s.id, cwd: s.cwd, title: s.renamed ? s.title : undefined, sessionId: s.sessionId || null, renamed: !!s.renamed }), strip: !!s.sessionId, sessTitle: s.sessTitle || s.title || null }))
    activeId = tabs.some((t) => t.id === saved.activeId) ? saved.activeId : tabs[0].id
    nextId = Math.max(saved.nextId || 1, ...tabs.map((t) => Number(t.id) + 1))
    bell = saved.bell !== false
    bounds = saved.bounds || null
    if (typeof saved.zoom === 'number') zoom = Math.max(0.8, Math.min(2, saved.zoom))
  } else {
    activeId = addTab(HOME_DIR).id
  }
  // a socket path that is too long (over ~107 chars) or unusable must never stop the window from opening
  for (const p of [sockPath(), path.join('/tmp', 'overseer-' + process.getuid() + '.sock')]) {
    hub = new Hub({ path: p, handler: cli })
    hub.on('hook', onHook)
    try { await hub.start(); break } catch (e) { console.error('hub socket failed at', p, e.message) }
  }
  wireIpc()
  createWindow()
  makeTray()
  setInterval(refreshBridge, 5000).unref()
  setInterval(pollShells, 1000).unref()
  setInterval(() => { if (ovState.alive && ovState.shown) refreshScreens() }, 10000).unref()
  if (TEST) global.__ov = { get tabs() { return tabs }, get win() { return win }, get trayMenu() { return trayMenu }, get zoom() { return zoom }, ptys, showWin, toggleWindow, quit: () => { quitting = true; app.quit() }, get ovPty() { return ovPty }, get ovState() { return ovState }, hooksFile, store, sizes }
})
