import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { reminderText } from '../src/host/schedules.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    w1: { id: 'w1', sessionId: 'w2', name: 'Writer', role: '', instructions: '', createdAt: 2, segments: [{ sessionId: 'w1', endedAt: 3 }] },
  },
  rooms: { g1: { id: 'g1', name: 'Launch', named: true, members: ['m1', 'w1'], admin: 'm1', mode: 'admin', notice: '', createdAt: 4 } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

// An in-memory stand-in for DSH's schedule service.
function scheduleService() {
  const tasks = new Map()
  let next = 1
  return {
    tasks,
    async create(sessionId, request) {
      const id = `schedule-${next++}`
      const kind = Object.keys(request).find(key => !['title', 'prompt'].includes(key))
      const record = { id, kind, title: request.title, prompt: request.prompt, timing: request[kind], scheduledAt: '2030-01-01T01:00:00.000Z' }
      tasks.set(id, { sessionId, record })
      return record
    },
    async list({ sessionId }) { return [...tasks.values()].filter(task => task.sessionId === sessionId).map(task => task.record) },
    async catalog() { return [...tasks.values()].map(task => ({ ...task.record, sessionId: task.sessionId, status: 'active' })) },
    async delete({ sessionId, id }) {
      if (tasks.get(id)?.sessionId !== sessionId) return { id, deleted: false, code: 'schedule_not_found' }
      tasks.delete(id)
      return { id, deleted: true }
    },
    // Compare-and-set on the whole record, as DSH does.
    async update({ sessionId, id, expected, title, prompt, change }) {
      const task = tasks.get(id)
      if (task?.sessionId !== sessionId) return { id, updated: false, code: 'schedule_not_found' }
      if (JSON.stringify(expected) !== JSON.stringify(task.record)) return { id, updated: false, code: 'schedule_conflict' }
      const timing = change === undefined ? {} : { kind: change.kind, timing: change[change.kind === 'every' ? 'every_seconds' : change.kind] }
      task.record = { ...task.record, ...(title === undefined ? {} : { title }), ...(prompt === undefined ? {} : { prompt }), ...timing }
      return { id, updated: true, record: task.record }
    },
    async history({ sessionId, id, limit }) {
      if (tasks.get(id)?.sessionId !== sessionId) return { id, code: 'schedule_not_found' }
      const runs = [{ scheduledAt: '2030-01-01T01:00:00.000Z', deliveredAt: '2030-01-01T01:00:02.000Z', messageId: 'm1', prompt: 'x' }]
      return { id, records: runs.slice(0, limit), earlierRecordsUnavailable: false, earlierRecordsPruned: false, retention: { days: 30, records: 200 } }
    },
  }
}

function setup(services = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-schedules-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  apply(ctx, { home })
  const call = async (endpoint, payload) => (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  return { ctx, home, call }
}

test('without the schedule service the page says so and creating is refused', async (t) => {
  const { ctx, home, call } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.deepEqual((await call('schedules', {})).value, { available: false, tasks: [] })
  const refused = await call('schedule-create', { target: 'm1', title: 'Briefing', prompt: 'Sum up', when: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /Automation tasks are off/)
})

test('tasks are created on the Bot’s current part, listed by Bot, and deleted', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const daily = await call('schedule-create', { target: 'w1', title: ' Briefing ', prompt: 'Sum up the day', when: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } })
  assert.equal(daily.ok, true, JSON.stringify(daily))
  const [created] = [...schedule.tasks.values()]
  assert.equal(created.sessionId, 'w2')
  assert.deepEqual(created.record.timing, { time: '09:00:00', time_zone: 'Asia/Shanghai' })
  assert.equal(created.record.title, 'Briefing')

  await schedule.create('w1', { title: 'Old part', prompt: 'x', every_seconds: 3600 })
  await schedule.create('outside', { title: 'Not ours', prompt: 'x', every_seconds: 3600 })
  const listed = (await call('schedules', {})).value
  assert.equal(listed.available, true)
  assert.deepEqual(listed.tasks.map(task => [task.title, task.botId]), [['Briefing', 'w1'], ['Old part', 'w1']])

  const weekly = await call('schedule-create', { target: 'm1', title: 'Week', prompt: 'Plan', when: { kind: 'weekly', time: '18:30', timeZone: 'UTC', weekdays: [5, 1, 1, 9] } })
  assert.equal(weekly.ok, true)
  assert.deepEqual([...schedule.tasks.values()].at(-1).record.timing, { time: '18:30:00', time_zone: 'UTC', weekdays: [1, 5] })
  const every = await call('schedule-create', { target: 'm1', title: 'Ping', prompt: 'Check', when: { kind: 'every', minutes: 30 } })
  assert.equal([...schedule.tasks.values()].at(-1).record.timing, 1800, JSON.stringify(every))

  for (const [when, message] of [
    [{ kind: 'at', at: '2000-01-01T00:00:00Z' }, /future/],
    [{ kind: 'weekly', time: '09:00', weekdays: [] }, /at least one day/],
    [{ kind: 'daily', time: '9am' }, /time of day/],
    [{ kind: 'every', minutes: 0 }, /1 minute to 7 days/],
  ]) {
    const refused = await call('schedule-create', { target: 'm1', title: 'x', prompt: 'y', when })
    assert.match(refused.error.message, message)
  }
  assert.match((await call('schedule-create', { target: 'm1', title: '', prompt: 'y', when: { kind: 'every', minutes: 5 } })).error.message, /name/)

  const removed = await call('schedule-delete', { sessionId: 'w2', id: created.record.id })
  assert.deepEqual(removed.value.tasks.map(task => task.title), ['Old part', 'Week', 'Ping'])
  assert.match((await call('schedule-delete', { sessionId: 'outside', id: 'schedule-3' })).error.message, /No such task/)
})

test('a group chat task lives on the group Session and lists under the group', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const made = await call('schedule-create', { target: 'g1', title: 'Standup', prompt: 'Where are we?', when: { kind: 'daily', time: '10:00', timeZone: 'UTC' } })
  assert.equal(made.ok, true, JSON.stringify(made))
  assert.equal([...schedule.tasks.values()][0].sessionId, 'g1')
  assert.deepEqual(made.value.tasks.map(task => [task.title, task.roomId, task.botId]), [['Standup', 'g1', undefined]])
  assert.match((await call('schedule-create', { target: 'nobody', title: 'x', prompt: 'y', when: { kind: 'every', minutes: 5 } })).error.message, /No such Bot or group chat/)
})

test('a task is edited against the record it was read from', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await call('schedule-create', { target: 'm1', title: 'Briefing', prompt: 'Sum up', when: { kind: 'daily', time: '09:00', timeZone: 'UTC' } })
  const [{ record }] = [...schedule.tasks.values()]
  const edited = await call('schedule-update', { sessionId: 'm1', id: record.id, title: 'Evening', when: { kind: 'cron', expression: ' 0  18 * * 1-5 ', timeZone: 'UTC' } })
  assert.equal(edited.ok, true, JSON.stringify(edited))
  const after = schedule.tasks.get(record.id).record
  assert.deepEqual([after.title, after.prompt, after.kind, after.timing], ['Evening', 'Sum up', 'cron', { expression: '0 18 * * 1-5', time_zone: 'UTC' }])

  // Another write in between (a delivery, an edit elsewhere) makes DSH refuse.
  schedule.tasks.get(record.id).record = { ...after, scheduledAt: '2030-01-02T18:00:00.000Z' }
  const stale = schedule.update
  schedule.update = request => stale({ ...request, expected: after })
  assert.match((await call('schedule-update', { sessionId: 'm1', id: record.id, prompt: 'New' })).error.message, /changed meanwhile/)
  schedule.update = stale
  assert.match((await call('schedule-update', { sessionId: 'm1', id: record.id, title: ' ' })).error.message, /name/)
  assert.match((await call('schedule-update', { sessionId: 'm1', id: record.id, when: { kind: 'cron', expression: '0 18 * *' } })).error.message, /five fields/)
  assert.match((await call('schedule-update', { sessionId: 'outside', id: record.id, title: 'x' })).error.message, /No such task/)

  const history = await call('schedule-history', { sessionId: 'm1', id: record.id })
  assert.deepEqual(history.value.runs, [{ scheduledAt: '2030-01-01T01:00:00.000Z', deliveredAt: '2030-01-01T01:00:02.000Z' }])
})

test('a paused task leaves DSH, keeps its timing, and comes back on the Bot’s current part', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await schedule.create('w1', { title: 'Old part', prompt: 'Check', weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [1, 3] } })
  const [[id, { record }]] = [...schedule.tasks.entries()]
  Object.assign(record, { kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [1, 3] })
  await schedule.create('m1', { title: 'Once', prompt: 'x', at: '2030-01-01T00:00:00Z' })
  const once = [...schedule.tasks.values()].at(-1).record

  assert.match((await call('schedule-pause', { sessionId: 'm1', id: once.id })).error.message, /Only repeating/)
  const pausedView = (await call('schedule-pause', { sessionId: 'w1', id })).value
  assert.equal(schedule.tasks.has(id), false)
  const pausedTask = pausedView.tasks.find(task => task.status === 'paused')
  assert.deepEqual([pausedTask.title, pausedTask.botId, pausedTask.kind, pausedTask.weekdays], ['Old part', 'w1', 'weekly', [1, 3]])

  const renamed = await call('schedule-update', { paused: true, id: pausedTask.id, prompt: 'Check twice', when: { kind: 'daily', time: '07:30', timeZone: 'UTC' } })
  assert.equal(renamed.ok, true, JSON.stringify(renamed))

  const resumed = (await call('schedule-resume', { id: pausedTask.id })).value
  assert.equal(resumed.tasks.some(task => task.status === 'paused'), false)
  const back = [...schedule.tasks.values()].at(-1)
  assert.equal(back.sessionId, 'w2')
  assert.deepEqual([back.record.title, back.record.prompt, back.record.kind, back.record.timing], ['Old part', 'Check twice', 'daily', { time: '07:30:00', time_zone: 'UTC' }])
  assert.match((await call('schedule-resume', { id: pausedTask.id })).error.message, /No such task/)
})

test('a paused task can be deleted and goes when its Bot does', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  for (const target of ['m1', 'g1']) await call('schedule-create', { target, title: `Ping ${target}`, prompt: 'x', when: { kind: 'every', minutes: 60 } })
  // A copy: pausing removes each task from the map.
  const made = [...schedule.tasks.entries()]
  for (const [id, task] of made) {
    Object.assign(task.record, { kind: 'every', everySeconds: 3600 })
    await call('schedule-pause', { sessionId: task.sessionId, id })
  }
  const [first, second] = (await call('schedules', {})).value.tasks
  assert.deepEqual([first.roomId, second.roomId], [undefined, 'g1'])
  const left = (await call('schedule-delete', { paused: true, id: first.id })).value.tasks
  assert.deepEqual(left.map(task => task.title), ['Ping g1'])

  Object.assign(ctx, { workspaceRegistry: { archiveSession: async () => {} } })
  assert.equal((await call('delete-room', { id: 'g1' })).ok, true)
  assert.deepEqual((await call('schedules', {})).value.tasks, [])
})

test('Run now sends the reminder DSH would send to the task’s chat', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const sent = []
  Object.assign(ctx, {
    sessionController: { resolveAgent: async id => ({ agent: { id, session: { id }, ctx: { tools: { restrict: () => () => {} }, effect: execute => execute() }, followup: message => sent.push({ id, message }) } }) },
    sessions: { flush: async () => true },
  })
  await schedule.create('w1', { title: 'Old part', prompt: 'Where are we?', every_seconds: 3600 })
  const [[id]] = [...schedule.tasks.entries()]
  const ran = await call('schedule-run', { sessionId: 'w1', id })
  assert.equal(ran.ok, true, JSON.stringify(ran))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].id, 'w2')
  assert.equal(sent[0].message.source.kind, 'schedule')
  assert.equal(reminderText(sent[0].message.content[0].text), '[Scheduled task] Where are we?')
  assert.equal(schedule.tasks.has(id), true)
})

test('a due reminder reaches a group as its prompts', () => {
  const one = ['[SCHEDULE REMINDER]', 'framing', 'schedule_id_json: "s1"', 'occurrence_at: 2030-01-01T00:00:00Z', 'reminder_prompt_json: "Where are we?"'].join('\n')
  assert.equal(reminderText(one), '[Scheduled task] Where are we?')
  const batch = ['[SCHEDULE REMINDER BATCH]', 'framing', `reminders_json: ${JSON.stringify([{ schedule_id: 'a', reminder_prompt: 'One' }, { schedule_id: 'b', reminder_prompt: 'Two' }])}`].join('\n')
  assert.equal(reminderText(batch), '[Scheduled task] One\n[Scheduled task] Two')
  assert.equal(reminderText('plain text'), 'plain text')
})
