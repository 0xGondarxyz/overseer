'use strict'
// Overseer helpers: tabs.md, first prompt, hooks file, bridge reading. All pure or tiny.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { fmtDur } = require('./state')

const HOME_DIR = process.env.OVERSEER_HOME_DIR || os.homedir()
const CACHE = () => process.env.OVERSEER_CACHE || path.join(os.homedir(), '.cache', 'overseer')
const LIVE = { notStarted: 'not started', exited: 'exited' }

function statusText(t, now) {
  return LIVE[t.status] || `${t.status} ${fmtDur(now - t.since)}`
}

const home = (p) => { const h = os.homedir(); return p && (p === h || p.startsWith(h + '/')) ? '~' + p.slice(h.length) : p }
const claudeRuns = (t) => t.status !== 'notStarted' && t.status !== 'exited'

/** One block per tab. Any program may run in a tab. */
function renderTabsMd(tabs, now = Date.now(), screens = {}) {
  const out = [`# Open tabs (updated ${new Date(now).toTimeString().slice(0, 8)})`, '']
  tabs.forEach((t, i) => {
    out.push(`## ${i + 1}. ${t.title}`)
    out.push(`- folder: ${t.cwd}`)
    out.push(`- running now: ${t.fg || 'shell'}${claudeRuns(t) ? ' (claude)' : ''}`)
    out.push(`- status: ${claudeRuns(t) ? statusText(t, now) : 'plain shell'}`)
    out.push(`- session id: ${claudeRuns(t) ? t.sessionId || '-' : '-'}`)
    out.push(`- transcript: ${claudeRuns(t) ? t.transcriptPath || '-' : '-'}`)
    const run = (t.subagents || []).filter((s) => s.running)
    out.push(`- subagents: ${run.length ? run.map((s) => `${s.desc} (${fmtDur(now - s.start)})`).join('; ') : 'none'}`)
    out.push(`- last reply: ${(t.lastReply || '-').replace(/\s+/g, ' ').slice(0, 300)}`)
    const scr = screens[t.id]
    out.push('- screen (last 40 lines):')
    out.push('```text', scr ? scr : '(not available yet)', '```')
    out.push('')
  })
  return out.join('\n')
}

/** Fill the overseer-prompt.md template and write it into the cache dir; returns the written file's path. */
function writePrompt({ root, node, cacheDir = CACHE(), homeDir = HOME_DIR }) {
  const vars = { NODE: node, CLI: path.join(root, 'bin', 'overseer.js'), CACHE: cacheDir, HOME_DIR: homeDir }
  const text = fs.readFileSync(path.join(root, 'overseer-prompt.md'), 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m))
  fs.mkdirSync(cacheDir, { recursive: true })
  const file = path.join(cacheDir, 'overseer-prompt.md')
  fs.writeFileSync(file, text)
  return file
}

function firstPrompt(cacheDir = CACHE()) {
  return `Read ${path.join(cacheDir, 'tabs.md')} and give me one short line per open tab: what it is doing and what it waits for.`
}

/** Content of the --settings file: our hooks. */
function buildHooksConfig({ node, root }) {
  const cmd = `"${node}" "${root}/bin/hook.js"`
  const entry = (matcher) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd, timeout: 5 }] }]
  const cfg = {
    hooks: {
      SessionStart: entry(), UserPromptSubmit: entry(), Stop: entry(), Notification: entry(),
      PreToolUse: entry('AskUserQuestion|Task|Agent'), PostToolUse: entry('AskUserQuestion|Task|Agent'),
      SubagentStop: entry(), SessionEnd: entry(),
    },
  }
  return cfg
}

/** Bridge file written by the bridge plugin: context percent, model, effort. */
function readBridge(sessionId, cacheDir = CACHE()) {
  if (!sessionId) return null
  try {
    const j = JSON.parse(fs.readFileSync(path.join(cacheDir, 'sessions', sessionId + '.json'), 'utf8'))
    return { contextPct: j.context && typeof j.context.percent === 'number' ? j.context.percent : null, model: j.model || null, effort: j.effort || null }
  } catch { return null }
}

/** Prompt typed into the overseer by the Merge button. */
function mergePrompt(a, b, ia, ib) {
  return `Merge tabs ${ia} and ${ib} (${a.title} and ${b.title}): read both transcripts listed in tabs.md, write one short brief for both jobs to ${path.join(CACHE(), 'merge-brief.md')}, then run overseer new --cwd ${a.cwd} --title "Merged: ${a.title.slice(0, 20)} + ${b.title.slice(0, 20)}" --prompt-file ${path.join(CACHE(), 'merge-brief.md')} and then overseer close ${ia} ${ib}.`
}

module.exports = { HOME_DIR, CACHE, renderTabsMd, firstPrompt, writePrompt, buildHooksConfig, readBridge, mergePrompt, statusText }
