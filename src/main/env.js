'use strict'
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function parseEnv(text) {
  const env = {}
  let key = null
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (m) { key = m[1]; env[key] = m[2] } else if (key) env[key] += '\n' + line
  }
  return env
}

/** Login-shell environment: fish first, then bash, else process.env. */
function captureLoginEnv() {
  // tests: OVERSEER_SHELL_HOME gives the shell a private config/data dir so it never touches ~/.config
  const base = { ...process.env }
  const sh = process.env.OVERSEER_SHELL_HOME
  if (sh) Object.assign(base, {
    XDG_CONFIG_HOME: sh + '/config', XDG_DATA_HOME: sh + '/data', XDG_CACHE_HOME: sh + '/cache',
    // A sandboxed data dir must never let a claude auto-update repoint the real ~/.local/bin launcher
    // at a version inside the sandbox (it would dangle when the sandbox is deleted).
    DISABLE_AUTOUPDATER: '1',
  })
  for (const [sh2, args] of [['fish', ['-lc', 'env']], ['bash', ['-lc', 'env']]]) {
    try {
      const out = execFileSync(sh2, args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], env: base })
      const env = parseEnv(out)
      if (env.PATH) return env
    } catch {}
  }
  return base
}

const SESSION_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|EXECPATH|CHILD_SESSION|SESSION_.*|MESSAGING_.*))$/

/** Drop markers inherited from a parent Claude Code session (they switch off transcript saving). */
function scrub(env) {
  for (const k of Object.keys(env)) if (SESSION_ENV.test(k)) delete env[k]
  return env
}

function which(name, env) {
  for (const dir of (env.PATH || '').split(':')) {
    if (!dir) continue
    const p = path.join(dir, name)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      if (fs.statSync(p).isFile()) return fs.realpathSync(p) // pin the version file, not a launcher symlink we don't own
    } catch {}
  }
  return null
}

/** { env, claude, node, shell } with absolute paths. OVERSEER_CLAUDE_BIN overrides claude. */
function resolveEnv() {
  const env = scrub(captureLoginEnv())
  const claude = process.env.OVERSEER_CLAUDE_BIN || which('claude', env)
  const node = which('node', env)
  const shell = env.SHELL && fs.existsSync(env.SHELL) ? env.SHELL : (process.env.SHELL || '/bin/bash')
  return { env, claude, node, shell }
}

module.exports = { captureLoginEnv, resolveEnv, which, parseEnv, scrub }
