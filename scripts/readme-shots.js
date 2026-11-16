'use strict'
// Makes the README screenshots from a hidden test instance: demo tabs, demo folders, fake claude,
// sample box data. Nothing from the real machine (no real tabs, sessions, prompts or user name) shows.
// Run: node scripts/readme-shots.js
const fs = require('fs')
const path = require('path')
const { launch, sleep, tmp, until, ROOT, DEMO_HOME } = require('../test/e2e/helpers')

const OUT = path.join(ROOT, 'docs')
const demoClaude = (dir) => {
  // overseer mode prints a canned answer; tab mode is the normal test fake
  const f = path.join(dir, 'demo-claude.js')
  fs.writeFileSync(f, `#!/usr/bin/env node
if (process.argv.includes('opus')) {
  const w = (s) => process.stdout.write(s.replace(/\\n/g, '\\r\\n'))
  w('\\x1b[38;2;254;128;25m✻\\x1b[0m Overseer · Opus · reads every tab\\n\\n')
  w('\\x1b[1m> what is each tab doing?\\x1b[0m\\n\\n')
  w('1. web-app      idle. Tests pass, last change was the login form.\\n')
  w('2. api          \\x1b[38;2;251;73;52mwaiting for you\\x1b[0m: asks which database to use.\\n')
  w('3. landing      \\x1b[38;2;250;189;47mfinished\\x1b[0m: hero section rewritten, needs your review.\\n')
  w('4. docs         idle shell, nothing running.\\n\\n')
  w('Next: answer the api tab first, it is blocked on you.\\n\\n> ')
  process.stdin.resume()
} else require(${JSON.stringify(path.join(ROOT, 'test', 'fake-claude.js'))})
`)
  fs.chmodSync(f, 0o755)
  return f
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const dir = tmp('readme')
  const demo = path.join(dir, 'projects')
  const names = ['web-app', 'api', 'landing', 'docs']
  for (const n of names) {
    fs.mkdirSync(path.join(demo, n, 'src'), { recursive: true })
    for (const f of ['README.md', 'package.json', 'src/index.ts']) fs.writeFileSync(path.join(demo, n, f), '')
  }
  // a neutral fish prompt and no greeting
  const fishCfg = path.join(dir, 'shellhome', 'config', 'fish')
  fs.mkdirSync(fishCfg, { recursive: true })
  fs.writeFileSync(path.join(fishCfg, 'config.fish'), "set -g fish_greeting ''\nfunction fish_prompt; set_color b8bb26; echo -n (basename $PWD); set_color normal; echo -n ' › '; end\n")
  const ud = path.join(dir, 'ud')
  fs.mkdirSync(ud, { recursive: true })
  fs.writeFileSync(path.join(ud, 'tabs.json'), JSON.stringify({ tabs: names.map((n, i) => ({ id: String(i + 1), title: n, renamed: true, cwd: path.join(demo, n), sessionId: null })), activeId: '1', bell: false, nextId: 5, zoom: 1 }))
  process.env.OVERSEER_CLAUDE_BIN_OVERRIDE = demoClaude(dir)

  const h = await launch(dir)
  await h.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
  // show neutral paths in the shots (the demo folders live in a temp dir)
  const tidy = () => h.page.evaluate(([demoDir, homeDir]) => {
    for (const el of document.querySelectorAll('.t-repo, .ov-path, .brand-sub')) el.textContent = el.textContent.replace(demoDir, '~/projects').replace(homeDir, '~')
  }, [demo, DEMO_HOME])
  const tab = (i) => h.page.locator('.tab').nth(i)
  const line = async (s) => { await h.page.keyboard.type(s); await h.page.keyboard.press('Enter') }
  const state = (i) => h.page.evaluate((k) => document.querySelectorAll('.tab')[k].dataset.state, i)
  await sleep(1500)
  // api: claude waits on a question (red); landing: claude finished a turn (gold)
  await tab(1).click(); await sleep(400); await line('claude'); await sleep(800); await line('ask')
  await until(async () => (await state(1)) === 'needs')
  await tab(2).click(); await sleep(400); await line('claude'); await sleep(800); await line('rewrite the hero')
  await sleep(300)
  await tab(0).click()
  await until(async () => (await state(2)) === 'done', 8000).catch(() => {})
  await sleep(400)
  await line('clear; git init -q 2>/dev/null; ls')
  await sleep(1200)
  await tidy()
  await h.page.screenshot({ path: path.join(OUT, 'main.png') })
  await h.page.keyboard.press('Control+w')
  await sleep(2500)
  await tidy()
  await h.page.screenshot({ path: path.join(OUT, 'overseer.png') })
  await h.app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  console.log('wrote docs/main.png and docs/overseer.png')
})().catch((e) => { console.error(e); process.exit(1) })
