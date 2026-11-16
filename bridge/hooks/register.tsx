import type { Register } from 'claude-code'

let last: { effort: string | null; model: string; ctx: string } | undefined

async function cacheDir($: any): Promise<string> {
  return (await $.env.get('OVERSEER_CACHE')) || `${await $.env.get('HOME')}/.cache/overseer`
}

async function writeUsage($: any, rateLimits: unknown[]) {
  if (!rateLimits || rateLimits.length === 0) return
  await $.fs.write(`${await cacheDir($)}/usage.json`, JSON.stringify({ rateLimits, updatedAt: new Date().toISOString() }))
}

async function writeSession($: any, patch: { effort?: string | null; model?: string; context?: unknown }) {
  const id = await $.session.id()
  if (!id) return
  const path = `${await cacheDir($)}/sessions/${id}.json`
  let cur: any = {}
  try {
    cur = JSON.parse(await $.fs.read(path))
  } catch {}
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() }
  await $.fs.write(path, JSON.stringify(next))
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      const u = await $.session.usage()
      await writeUsage($, u.rateLimits)
      await writeSession($, { context: u.context })
    } catch {}
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    try {
      await writeUsage($, e.rateLimits)
      if (e.changed.includes('context')) await writeSession($, { context: e.context })
    } catch {}
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      try {
        const effort = e.effort === undefined ? null : String(e.effort)
        if (!last || last.effort !== effort || last.model !== e.model) {
          last = { effort, model: e.model, ctx: '' }
          await writeSession($, { effort, model: e.model })
        }
      } catch {}
    }
    return yield* next(e)
  })
}
