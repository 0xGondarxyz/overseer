'use strict'
// Pure tab state machine. reduce(tab, evt, { active, now }) returns a new tab object.
// evt = { event, payload?, title? }. Hook events use Claude's own names; internal ones start with "_".
const path = require('path')

function newTab({ id, cwd, title, sessionId = null, renamed = false, now = Date.now() }) {
  return {
    id: String(id), title: title || path.basename(cwd) || cwd, renamed, cwd, sessionId,
    status: 'notStarted', since: now, transcriptPath: null, lastReply: '', contextPct: null,
    model: null, effort: null, subagents: [], hasOsc: false, fg: null, strip: false, sessTitle: null,
  }
}

/** Strip leading spinner and status glyphs that Claude puts in its OSC title. */
function cleanTitle(s) {
  return String(s || '').replace(/^[\s⠀-⣿✳✱✻✽✶·●◐-◓○▶*✳]+/u, '').trim()
}

function closeSub(subs, pick) {
  const subagents = subs.map((s) => ({ ...s }))
  const s = pick(subagents)
  if (s) s.running = false
  return subagents
}

function reduce(tab, evt, { active = false, now = Date.now() } = {}) {
  const t = { ...tab }
  const p = evt.payload || {}
  switch (evt.event) {
    case 'SessionStart':
      t.sessionId = p.session_id || t.sessionId
      t.transcriptPath = p.transcript_path || t.transcriptPath
      if (p.model) t.model = p.model
      if (t.status === 'notStarted' || t.status === 'exited') { t.status = 'idle'; t.since = now }
      break
    case 'UserPromptSubmit':
      t.status = 'working'; t.since = now
      if (!t.hasOsc && !t.renamed && p.prompt) {
        const first = String(p.prompt).replace(/\s+/g, ' ').trim().slice(0, 40)
        if (first) t.title = first
      }
      break
    case 'PreToolUse':
      if (p.tool_name === 'AskUserQuestion') { t.status = 'needs'; t.since = now }
      else {
        if (p.tool_name === 'Agent' || p.tool_name === 'Task') {
          const desc = (p.tool_input && (p.tool_input.description || p.tool_input.subagent_type)) || 'subagent'
          t.subagents = [...t.subagents, { id: p.tool_use_id || String(now), desc, start: now, running: true }]
        }
        if (t.status === 'needs') { t.status = 'working'; t.since = now }
      }
      break
    case 'PostToolUse':
      if (p.tool_name === 'Agent' || p.tool_name === 'Task') {
        t.subagents = closeSub(t.subagents, (a) => a.find((s) => s.id === p.tool_use_id && s.running))
      }
      if (t.status === 'needs') { t.status = 'working'; t.since = now }
      break
    case 'Notification':
      if (p.notification_type === 'permission_prompt' || p.notification_type === 'elicitation_dialog') { t.status = 'needs'; t.since = now }
      break
    case 'SubagentStop':
      t.subagents = closeSub(t.subagents, (a) => a.find((s) => s.running))
      break
    case 'Stop':
      t.status = active ? 'idle' : 'done'; t.since = now
      if (typeof p.last_assistant_message === 'string') t.lastReply = p.last_assistant_message
      if (p.effort && p.effort.level) t.effort = p.effort.level
      break
    case 'SessionEnd':
    case '_exit':
      if (t.status !== 'notStarted') { t.status = 'exited'; t.since = now }
      t.subagents = t.subagents.map((s) => ({ ...s, running: false }))
      break
    case '_started':
      t.status = 'idle'; t.since = now; t.subagents = []; t.hasOsc = false
      break
    case '_shell': // claude exited back to the shell: plain shell state again
      if (t.status !== 'notStarted') { t.status = 'notStarted'; t.since = now }
      t.subagents = []
      break
    case '_cwd':
      t.cwd = evt.cwd
      if (!t.renamed && !t.hasOsc) t.title = path.basename(evt.cwd) || evt.cwd
      break
    case '_select':
      if (t.status === 'done') { t.status = 'idle'; t.since = now }
      break
    case '_title': {
      const c = cleanTitle(evt.title)
      if (c) { t.hasOsc = true; if (!t.renamed) t.title = c }
      break
    }
    case '_rename': {
      const n = String(evt.title || '').trim()
      if (n) { t.title = n; t.renamed = true } else { t.title = path.basename(t.cwd) || t.cwd; t.renamed = false }
      break
    }
  }
  return t
}

/** "12m", "2h", "3d" */
function fmtDur(ms) {
  const m = Math.max(0, Math.floor(ms / 60000))
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  return h < 24 ? h + 'h' : Math.floor(h / 24) + 'd'
}

module.exports = { newTab, reduce, cleanTitle, fmtDur }
