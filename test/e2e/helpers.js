'use strict'
const { _electron } = require('playwright')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ROOT = path.resolve(__dirname, '..', '..')
// A private "home" for the overseer and its first tab: tests never assume a user name or touch the real home.
const DEMO_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ovt-home-')))

function makeEnv(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return {
    ...process.env, OVERSEER_TEST: '1', OVERSEER_USERDATA: path.join(dir, 'ud'), OVERSEER_CACHE: path.join(dir, 'cache'), OVERSEER_HOME_DIR: DEMO_HOME,
    OVERSEER_SOCK: path.join(dir, 'hub.sock'), OVERSEER_CLAUDE_BIN: process.env.OVERSEER_CLAUDE_BIN_OVERRIDE || path.join(ROOT, 'test', 'fake-claude.js'),
    OVERSEER_FAKE_LOG: path.join(dir, 'fake.log'), OVERSEER_SHELL_HOME: path.join(dir, 'shellhome'), SHELL: '/usr/bin/fish',
  }
}

async function launch(dir) {
  const env = makeEnv(dir)
  const app = await _electron.launch({ args: [ROOT, '--no-sandbox', '--mute-audio'], env, cwd: ROOT })
  const page = await app.firstWindow()
  await page.waitForSelector('.tab')
  const log = () => (fs.existsSync(env.OVERSEER_FAKE_LOG) ? fs.readFileSync(env.OVERSEER_FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  return { app, page, env, log, dir }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 8000, step = 100) {
  const t0 = Date.now()
  for (;;) {
    let v
    try { v = await fn() } catch { v = false }
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('timeout waiting: ' + fn.toString().slice(0, 120))
    await sleep(step)
  }
}
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), 'ovt-' + n + '-'))
module.exports = { launch, until, sleep, tmp, ROOT, makeEnv, DEMO_HOME }
