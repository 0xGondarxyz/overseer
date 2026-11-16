'use strict'
const { contextBridge, ipcRenderer, webUtils } = require('electron')
const OUT = ['pty:write', 'pty:resize', 'tab:select', 'tab:start', 'tab:add', 'tab:pick', 'tab:close', 'tab:rename', 'tab:title', 'tab:move', 'editing', 'ov:toggle', 'ov:hide', 'ov:sleep', 'bell', 'quit', 'tab:strip', 'zoom', 'clip:write', 'clip:primary', 'screens']
const IN = ['state', 'pty:data', 'hotkey', 'display', 'bell', 'quit:ask', 'screens:req']
contextBridge.exposeInMainWorld('ov', {
  send: (ch, ...a) => { if (OUT.includes(ch)) ipcRenderer.send(ch, ...a) },
  on: (ch, fn) => { if (IN.includes(ch)) ipcRenderer.on(ch, (_e, ...a) => fn(...a)) },
  pathForFile: (f) => { try { return webUtils.getPathForFile(f) || '' } catch { return '' } },
  invoke: (ch, ...a) => (['boxes:get', 'merge:prompt', 'clip:read', 'clip:readPrimary'].includes(ch) ? ipcRenderer.invoke(ch, ...a) : Promise.resolve(null)),
})
