'use strict'
// tabs.json: { tabs:[{id,title,renamed,cwd,sessionId}], activeId, bell, bounds:{x,y,width,height,displayId} }
const fs = require('fs')
const path = require('path')

function createStore(dir, delay = 500) {
  const file = path.join(dir, 'tabs.json')
  let timer = null
  let pending = null
  const write = () => {
    timer = null
    if (!pending) return
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file + '.tmp', JSON.stringify(pending, null, 2))
      fs.renameSync(file + '.tmp', file)
    } catch {}
    pending = null
  }
  return {
    file,
    load() { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } },
    save(data) { pending = data; if (!timer) timer = setTimeout(write, delay) },
    flush() { if (timer) { clearTimeout(timer); timer = null } write() },
  }
}

/** Keep the saved bounds only if they overlap a connected display, else null (caller centers on primary). */
function usableBounds(b, displays) {
  if (!b || !(b.width > 200) || !(b.height > 200)) return null
  const d = displays.find((x) => x.id === b.displayId)
  if (!d) return null
  const w = d.workArea
  const ox = Math.min(b.x + b.width, w.x + w.width) - Math.max(b.x, w.x)
  const oy = Math.min(b.y + b.height, w.y + w.height) - Math.max(b.y, w.y)
  return ox > 100 && oy > 100 ? b : null
}

module.exports = { createStore, usableBounds }
