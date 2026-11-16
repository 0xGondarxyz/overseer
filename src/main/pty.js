'use strict'
const nodePty = require('node-pty')

/**
 * Spawn a command in a pty.
 * opts: { file, args, cwd, env, cols, rows, onData, onExit }
 * Returns { pty, write, resize, kill }.
 */
function spawnPty({ file, args = [], cwd, env, cols = 120, rows = 40, onData, onExit }) {
  const pty = nodePty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env })
  if (onData) pty.onData(onData)
  pty.onExit((e) => onExit && onExit(e))
  return {
    pty,
    write: (s) => pty.write(s),
    resize: (c, r) => { try { pty.resize(c, r) } catch {} },
    kill: () => { try { pty.kill() } catch {} },
  }
}

/** Env for a tab pty, per PLAN §6. */
function tabEnv(base, { sock, tab, root, hooksFile, realClaude, shim }) {
  const e = { ...base, OVERSEER_SOCK: sock, OVERSEER_TAB: String(tab), OVERSEER_APP: root, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
  if (hooksFile) e.OVERSEER_HOOKS = hooksFile
  if (realClaude) e.OVERSEER_REAL_CLAUDE = realClaude
  if (shim) e.PATH = shim + ':' + (base.PATH || '')
  return e
}

/** Args for the login shell. fish: -C runs after config.fish, so the shim dir stays first in PATH. */
function shellArgs(shell, shim) {
  if (/(^|\/)fish$/.test(shell)) return ['-C', `set -gx PATH '${shim}' $PATH`]
  return []
}

const fishQuote = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
/** Command line that starts claude with the prompt read from a file (safe for any text). */
function claudeWithPromptFile(shell, file) {
  return /(^|\/)fish$/.test(shell) ? `claude (cat ${fishQuote(file)} | string collect)` : `claude "$(cat '${String(file).replace(/'/g, "'\\''")}')"`
}

/** Claude command line, per PLAN §6. mode: {kind:'new',sessionId}|{kind:'continue',sessionId?}|{kind:'overseer',sessionId,prompt} */
function claudeArgs({ hooksFile, root, mode, model, promptFile }) {
  const a = ['--settings', hooksFile, '--plugin-dir', `${root}/bridge`]
  if (model && mode.kind !== 'overseer') a.push('--model', model)
  if (mode.kind === 'new') { a.push('--session-id', mode.sessionId); if (mode.prompt) a.push(mode.prompt) }
  else if (mode.kind === 'continue') mode.sessionId ? a.push('--resume', mode.sessionId) : a.push('--continue')
  else if (mode.kind === 'overseer') {
    a.push('--model', 'opus', '--append-system-prompt-file', promptFile || `${root}/overseer-prompt.md`, '--session-id', mode.sessionId, mode.prompt)
  }
  return a
}

module.exports = { spawnPty, tabEnv, claudeArgs, shellArgs, claudeWithPromptFile, fishQuote }
