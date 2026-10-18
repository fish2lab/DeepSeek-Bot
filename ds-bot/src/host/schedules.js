// Scheduled tasks. DSH's schedule service stores each task with the Session it belongs
// to and, when it is due, sends its prompt to that Session as a new message. This
// module lists the team's tasks for Settings, creates and removes them there, and moves
// a Bot's tasks along when its chat goes on in a fresh part, so the Bot keeps seeing
// them. A group chat's task lives on the group's own Session, so the reminder reaches
// the group like a message from the user (see reminderText). DSH 0.2.0 mounts the service only with its Automation tasks bundle on, so
// the service is optional and every endpoint reports whether it is there.
//
// DSH has no pause and no run-now (docs/plans/2026-10-19-scheduled-tasks.md): a paused
// task leaves DSH and waits in state.pausedTasks until it is resumed, and Run now puts
// the same reminder message DSH would send into the task's chat.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const MAX_TITLE = 120
const HISTORY_LIMIT = 20
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const REPEATING = new Set(['every', 'daily', 'weekly', 'cron'])
const MISSES = {
  schedule_not_found: 'No such task',
  schedule_ended: 'This task has already run',
  schedule_conflict: 'This task changed meanwhile; open it again',
}

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

// What a group sees of a due reminder: DSH frames it for one Session's model
// ("[SCHEDULE REMINDER]" with JSON fields); the group gets each prompt as one line.
export function reminderText(text) {
  const prompts = []
  const one = /^reminder_prompt_json: (.*)$/m.exec(text)
  const batch = /^reminders_json: (.*)$/m.exec(text)
  try {
    if (one) prompts.push(JSON.parse(one[1]))
    if (batch) for (const entry of JSON.parse(batch[1])) prompts.push(entry.reminder_prompt)
  } catch {
    // A framing this module cannot read goes to the group as it came.
    return text
  }
  const lines = prompts.filter(prompt => typeof prompt === 'string' && prompt.trim() !== '')
  return lines.length === 0 ? text : lines.map(prompt => `[Scheduled task] ${prompt}`).join('\n')
}

// The create request that gives a stored record its timing again, for a move.
function requestOf(record) {
  const base = { title: record.title, prompt: record.prompt }
  if (record.kind === 'after' || record.kind === 'at') return { ...base, at: record.scheduledAt }
  if (record.kind === 'every') return { ...base, every_seconds: record.everySeconds }
  if (record.kind === 'daily') return { ...base, daily: { time: record.time, time_zone: record.timeZone } }
  if (record.kind === 'weekly') return { ...base, weekly: { time: record.time, time_zone: record.timeZone, weekdays: record.weekdays } }
  if (record.kind === 'cron') return { ...base, cron: { expression: record.expression, time_zone: record.timeZone } }
  return null
}

// The settings form's timing as a create request selector.
function selectorOf(when) {
  const zone = typeof when?.timeZone === 'string' && when.timeZone !== '' ? when.timeZone : 'UTC'
  switch (when?.kind) {
    case 'at': {
      const at = new Date(String(when.at ?? ''))
      if (Number.isNaN(at.getTime())) throw invalid('Pick a date and time')
      if (at.getTime() <= Date.now()) throw invalid('Pick a time in the future')
      return { at: at.toISOString() }
    }
    case 'daily':
      if (!TIME.test(String(when.time))) throw invalid('Pick a time of day')
      return { daily: { time: `${when.time}:00`, time_zone: zone } }
    case 'weekly': {
      if (!TIME.test(String(when.time))) throw invalid('Pick a time of day')
      const weekdays = [...new Set((Array.isArray(when.weekdays) ? when.weekdays : []).map(Number))].filter(day => Number.isInteger(day) && day >= 1 && day <= 7).sort()
      if (weekdays.length === 0) throw invalid('Pick at least one day')
      return { weekly: { time: `${when.time}:00`, time_zone: zone, weekdays } }
    }
    case 'every': {
      const minutes = Number(when.minutes)
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) throw invalid('Repeat every 1 minute to 7 days')
      return { every_seconds: minutes * 60 }
    }
    case 'cron': {
      const expression = String(when.expression ?? '').trim().replace(/\s+/g, ' ')
      if (expression.split(' ').length !== 5) throw invalid('Write five fields: minute hour day month weekday')
      return { cron: { expression, time_zone: zone } }
    }
    default:
      throw invalid('Pick when it runs')
  }
}

// The same timing as an update's change.
function changeOf(selector) {
  const [kind] = Object.keys(selector)
  return kind === 'every_seconds' ? { kind: 'every', every_seconds: selector.every_seconds } : { kind, [kind]: selector[kind] }
}

// The stored fields of a paused task for the given timing, as a record shows them.
function timingFields(selector) {
  if (selector.every_seconds !== undefined) return { kind: 'every', everySeconds: selector.every_seconds }
  if (selector.daily) return { kind: 'daily', time: selector.daily.time, timeZone: selector.daily.time_zone }
  if (selector.weekly) return { kind: 'weekly', time: selector.weekly.time, timeZone: selector.weekly.time_zone, weekdays: selector.weekly.weekdays }
  if (selector.cron) return { kind: 'cron', expression: selector.cron.expression, timeZone: selector.cron.time_zone }
  throw invalid('A paused task repeats; pick a repeating time')
}

// A catalog entry without the fields DSH adds around the stored record.
function recordOf(entry) {
  const { sessionId: _session, status: _status, lastDelivery: _last, ...record } = entry
  return record
}

function checkedTitle(value) {
  const title = String(value ?? '').trim()
  if (title === '') throw invalid('Give the task a name')
  if (title.length > MAX_TITLE) throw invalid(`Keep the name under ${MAX_TITLE} characters`)
  return title
}
function checkedPrompt(value) {
  const prompt = String(value ?? '').trim()
  if (prompt === '') throw invalid('Say what the Bot should do')
  return prompt
}

// DSH's one-shot reminder framing, which turns.js and the chat already read as a due task.
function reminderMessage(id, prompt) {
  return [
    '[SCHEDULE REMINDER]',
    'This is a scheduled message from the user',
    `schedule_id_json: ${JSON.stringify(id)}`,
    `occurrence_at: ${new Date().toISOString()}`,
    `reminder_prompt_json: ${JSON.stringify(prompt)}`,
  ].join('\n')
}

export function install(rt) {
  const { ctx, state } = rt
  let service = null

  const attach = (sub) => {
    const own = sub.schedule
    service = own
    sub.effect(() => () => { if (service === own) service = null }, 'ds-bot: schedule service')
  }
  if (typeof ctx.inject === 'function') ctx.inject(['schedule'], attach)
  else if (ctx.get?.('schedule') !== undefined) attach({ schedule: ctx.get('schedule'), effect: (execute, label) => ctx.effect(execute, label) })

  // The Bot (and group chat) a task's Session speaks for, the group chat for a group's
  // own Session, or nothing for a Session outside the team.
  const ownerOf = (sessionId) => {
    const chat = rt.chatOwners.get(sessionId)
    if (chat !== undefined) return { botId: chat }
    if (rt.roomOf(sessionId) !== undefined) return { roomId: sessionId }
    return rt.groupOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)
  }
  const known = owner => owner !== undefined && (owner.botId === undefined ? rt.roomOf(owner.roomId) !== undefined : rt.botOf(owner.botId) !== undefined)

  // The Session a task of this Bot or group chat goes to now.
  const sessionFor = owner => (owner.botId === undefined ? owner.roomId : rt.chatOf(owner.botId))
  const paused = () => state.pausedTasks ?? {}

  async function schedulesView() {
    if (service === null) return { available: false, tasks: [] }
    const tasks = []
    for (const entry of await service.catalog()) {
      const owner = ownerOf(entry.sessionId)
      if (!known(owner)) continue
      tasks.push({ ...entry, ...owner })
    }
    // A paused task of a removed Bot or group chat goes with it.
    let pruned = false
    for (const [id, task] of Object.entries(paused())) {
      const owner = task.botId === undefined ? { roomId: task.roomId } : { botId: task.botId }
      if (!known(owner)) { delete state.pausedTasks[id]; pruned = true; continue }
      tasks.push({ ...task.record, id, title: task.title, prompt: task.prompt, status: 'paused', pausedAt: task.pausedAt, ...owner })
    }
    if (pruned) await rt.save()
    return { available: true, tasks }
  }

  const needService = () => {
    if (service === null) throw invalid('Automation tasks are off in DSH')
  }
  // The active or finished DSH task the request names, with its Bot or group chat.
  async function findTask(body) {
    const owner = ownerOf(body.sessionId)
    const entry = owner === undefined ? undefined : (await service.catalog()).find(item => item.sessionId === body.sessionId && item.id === body.id)
    if (entry === undefined) throw invalid('No such task')
    return { entry, owner }
  }
  const findPaused = (id) => {
    const task = typeof id === 'string' && Object.hasOwn(paused(), id) ? paused()[id] : undefined
    if (task === undefined) throw invalid('No such task')
    return task
  }

  const endpoints = {
    schedules: () => schedulesView(),
    async 'schedule-create'(body) {
      needService()
      const bot = rt.botOf(body.target)
      const room = rt.roomOf(body.target)
      if (bot === undefined && room === undefined) throw invalid('No such Bot or group chat')
      const title = checkedTitle(body.title)
      const prompt = checkedPrompt(body.prompt)
      await service.create(bot ? rt.chatOf(bot.id) : room.id, { title, prompt, ...selectorOf(body.when) })
      return schedulesView()
    },
    async 'schedule-update'(body) {
      needService()
      const content = {
        ...(body.title === undefined ? {} : { title: checkedTitle(body.title) }),
        ...(body.prompt === undefined ? {} : { prompt: checkedPrompt(body.prompt) }),
      }
      const selector = body.when === undefined ? undefined : selectorOf(body.when)
      if (body.paused === true) {
        const task = findPaused(body.id)
        Object.assign(task, content)
        if (selector !== undefined) task.record = timingFields(selector)
        await rt.save()
        return schedulesView()
      }
      const { entry } = await findTask(body)
      const result = await service.update({
        sessionId: body.sessionId, id: body.id, expected: recordOf(entry), ...content,
        ...(selector === undefined ? {} : { change: changeOf(selector) }),
      })
      if (result.code !== undefined) throw invalid(MISSES[result.code] ?? result.message ?? 'The task was not changed')
      return schedulesView()
    },
    async 'schedule-history'(body) {
      needService()
      await findTask(body)
      const result = await service.history({ sessionId: body.sessionId, id: body.id, limit: HISTORY_LIMIT })
      if (result.code !== undefined) throw invalid(MISSES[result.code] ?? 'No such task')
      return { runs: result.records.map(({ scheduledAt, deliveredAt }) => ({ scheduledAt, deliveredAt })), earlierUnavailable: result.earlierRecordsUnavailable }
    },
    async 'schedule-pause'(body) {
      needService()
      const { entry, owner } = await findTask(body)
      if (entry.status !== 'active') throw invalid('This task has already run')
      if (!REPEATING.has(entry.kind)) throw invalid('Only repeating tasks can be paused')
      const { id: _id, scheduledAt: _at, title, prompt, ...record } = recordOf(entry)
      state.pausedTasks ??= {}
      const id = `paused-${randomUUID()}`
      // Saved before DSH forgets it, so a failure in between leaves a copy, not nothing.
      state.pausedTasks[id] = { ...owner, title, prompt, record, pausedAt: new Date().toISOString() }
      await rt.save()
      try {
        await service.delete({ sessionId: body.sessionId, id: body.id })
      } catch (error) {
        delete state.pausedTasks[id]
        await rt.save()
        throw error
      }
      return schedulesView()
    },
    async 'schedule-resume'(body) {
      needService()
      const task = findPaused(body.id)
      const owner = task.botId === undefined ? { roomId: task.roomId } : { botId: task.botId }
      if (!known(owner)) throw invalid('No such Bot or group chat')
      const request = requestOf({ ...task.record, title: task.title, prompt: task.prompt })
      if (request === null) throw invalid('No such task')
      await service.create(sessionFor(owner), request)
      delete state.pausedTasks[body.id]
      await rt.save()
      return schedulesView()
    },
    async 'schedule-run'(body) {
      needService()
      let owner
      let prompt
      if (body.paused === true) {
        const task = findPaused(body.id)
        owner = task.botId === undefined ? { roomId: task.roomId } : { botId: task.botId }
        prompt = task.prompt
      } else {
        const found = await findTask(body)
        owner = found.owner
        prompt = found.entry.prompt
      }
      if (!known(owner)) throw invalid('No such Bot or group chat')
      const sessionId = sessionFor(owner)
      await rt.ensureCapabilities(sessionId)
      const agent = await rt.resolveAgent(sessionId)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: reminderMessage(body.id, prompt) }], source: { kind: 'schedule' } }))
      await ctx.sessions.flush(agent.session)
      return true
    },
    async 'schedule-delete'(body) {
      if (body.paused === true) {
        findPaused(body.id)
        delete state.pausedTasks[body.id]
        await rt.save()
        return schedulesView()
      }
      needService()
      if (ownerOf(body.sessionId) === undefined) throw invalid('No such task')
      await service.delete({ sessionId: body.sessionId, id: body.id })
      return schedulesView()
    },
  }

  // A fresh part takes over the earlier part's active tasks: each is created again on
  // the fresh Session before the old one goes, so a failure leaves it where it was.
  async function moveSchedules(fromId, toId) {
    if (service === null) return
    let records
    try {
      records = await service.list({ sessionId: fromId })
    } catch (error) {
      rt.warn('ds-bot: tasks of %s not moved: %s', fromId, error?.message ?? error)
      return
    }
    for (const record of records) {
      const request = requestOf(record)
      if (request === null || (request.at !== undefined && Date.parse(request.at) <= Date.now())) continue
      try {
        await service.create(toId, request)
        await service.delete({ sessionId: fromId, id: record.id })
      } catch (error) {
        rt.warn('ds-bot: task %s stayed with the earlier part: %s', record.title, error?.message ?? error)
      }
    }
  }

  Object.assign(rt, { scheduleEndpoint: (endpoint, body) => endpoints[endpoint](body ?? {}), moveSchedules })
}
