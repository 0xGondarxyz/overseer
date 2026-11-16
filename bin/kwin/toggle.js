// KWin script run by bin/overseer-toggle (Alt+W). MODE is 'toggle' or 'show'.
// Brings the Overseer window to the monitor under the mouse and focuses it, like Yakuake;
// in 'toggle' mode a window that is already focused on that monitor is minimized instead.
(function () {
  const MODE = '__MODE__'
  let out = workspace.activeScreen
  try { const s = workspace.screenAt(workspace.cursorPos); if (s) out = s } catch (e) {}
  const w = workspace.windowList().find((c) => c.normalWindow && String(c.resourceClass).toLowerCase() === 'overseer')
  if (!w) { print('OVERSEER-KWIN no-window'); return }
  if (MODE === 'toggle' && !w.minimized && w.active && w.output === out) {
    w.skipTaskbar = true
    w.minimized = true
    print('OVERSEER-KWIN minimized')
    return
  }
  if (w.output !== out) workspace.sendClientToScreen(w, out)
  w.skipTaskbar = false
  w.minimized = false
  workspace.activeWindow = w
  print('OVERSEER-KWIN shown on ' + out.name)
})()
