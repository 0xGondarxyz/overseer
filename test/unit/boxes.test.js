'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const B = require('../../src/renderer/boxes')

const strip = h => h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const lines = h => strip(h.replace(/<\/div>/g, '\n')).split('\n').filter(l => l !== '')


test('effort and model', () => {
  assert.equal(B.effortLine('low'), '▮▯▯▯▯ low')
  assert.equal(B.effortLine('xhigh'), '▮▮▮▮▯ xhigh')
  assert.equal(B.effortLine('max'), '▮▮▮▮▮ max')
  assert.equal(B.effortLine('7'), '7')
  assert.equal(B.prettyModel('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(B.prettyModel('claude-opus-5-5[1m]'), 'Opus 5.5')
  assert.equal(B.prettyModel('claude-haiku-4-5-20251001'), 'Haiku 4.5')
  assert.equal(B.prettyModel('claude-opus-5'), 'Opus 5')
  assert.equal(B.prettyModel('glm-5.3'), 'glm-5.3')
  assert.equal(B.prettyModel('Opus 5.5'), 'Opus 5.5')
})

test('load colors: green under 50, yellow under 80, pink from 80', () => {
  assert.deepEqual([49, 50, 79, 80].map(B.load), ['hg', 'hy', 'hy', 'hp'])
})

test('uptime and duration', () => {
  assert.equal(B.uptime(18716), '5h 11m')
  assert.equal(B.uptime(2 * 86400 + 3 * 3600), '2d 3h')
  assert.equal(B.dur(258), '4h18m')
  assert.equal(B.dur(7), '7m')
})

test('status box: effort, model, time, limits', () => {
  const d = { effort: 'xhigh', model: 'claude-opus-5-5', todayMin: 258, weekMin: 600, limits: [{ kind: 'five_hour', pct: 29, resetsAt: '2026-11-16T10:10:00' }, { kind: 'seven_day', pct: 85, resetsAt: 'x' }] }
  const body = lines(B.renderStatus(d))
  assert.equal(body[0], 'effort ▮▮▮▮▯ xhigh · Opus 5.5')
  assert.equal(body[1], 'time   today 4h18m · week 10h00m')
  assert.match(body[2], /^5h {6}29% ━━─{5} ↻ 10:10$/)
  assert.match(body[3], /^wk {6}85% ━{6}─$/)
  assert.match(B.renderStatus(d), /class="hp hb">  85%/) // 85 is pink
  const box = B.renderBox('status', d)
  assert.ok(!/mods?</.test(box))
  assert.match(box, /data-box="useBox">\[ × \]</)
  assert.match(strip(B.renderStatus({ ...d, effort: null, model: null })), /^time/)
})

test('system box: bars, power colors the other way round', () => {
  const d = { ram: { pct: 59, usedG: 13.3, totalG: 22.7 }, disk: { pct: 85, freeG: 34 }, power: { pct: 95, plugged: true }, upSec: 18716, now: new Date(2026, 9, 20, 3, 43).getTime() }
  const html = B.renderSystem(d)
  const body = lines(html)
  assert.match(body[0], /^ram     59% ━{4}─{3} 13\.3\/22\.7G$/)
  assert.match(body[1], /^disk    85% ━{6}─ 34G free$/)
  assert.match(body[2], /^power   95% ━{7} plugged in$/)
  assert.equal(body[3], 'up    5h 11m')
  assert.match(html, /class="hg hb">  95%/) // full battery is green
  assert.match(B.renderSystem({ ...d, power: { pct: 10, plugged: false } }), /class="hp hb">  10%/) // low battery pink
  assert.equal(lines(B.renderSystem({ ...d, power: { pct: null, plugged: true } }))[2], 'power plugged in')
  assert.equal(lines(B.renderSystem({ ...d, power: { pct: null, plugged: null } }))[2], 'power no battery')
  assert.match(B.renderBox('system', d), /03:43 Tue 20/)
})

test('null data renders a quiet line, never throws', () => {
  for (const k of ['status', 'system']) assert.match(B.renderBox(k, null), /class="box"/)
})

test('all text is escaped', () => {
  assert.ok(!B.renderStatus({ effort: '<b>', model: '<i>', todayMin: 0, weekMin: 0, limits: [] }).includes('<b>'))
})
