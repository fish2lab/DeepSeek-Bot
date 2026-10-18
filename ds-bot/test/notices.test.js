import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/notices.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false,
})

function source(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    set: (next) => { value = typeof next === 'function' ? next(value) : next; for (const listener of listeners) listener() },
  }
}

const writer = { id: 'b', name: 'Writer', sessionId: 'b2', parts: ['b'] }
const editor = { id: 'e', name: 'Editor', sessionId: 'e' }
const ops = { id: 'r1', name: 'Ops', members: ['b', 'e'] }

function team(changes = {}) {
  const bots = changes.bots ?? [writer, editor]
  const rooms = changes.rooms ?? [ops]
  const byId = {}
  for (const bot of bots) for (const id of [...(bot.parts ?? []), bot.sessionId, bot.id]) byId[id] = bot
  return { ready: true, questions: {}, exchangeTurns: {}, ...changes, bots, rooms, byId, roomsById: Object.fromEntries(rooms.map(room => [room.id, room])) }
}

const outline = (...turns) => turns.map(([turn, response]) => ({ turn, seq: turn * 10, prompt: 'Hi', response }))
const listWith = byPart => ({ byId: {}, projectionsBySession: Object.fromEntries(Object.entries(byPart).map(([id, turns]) => [id, { values: { turnOutline: turns } }])) })

// One window: the platform's Notification, whether the page shows, the sources, and
// the reply switch.
function windowWith({ permission = 'granted', visibility = 'visible', shown = 'other', replies = true, roster = team(), list = listWith({}) } = {}) {
  const notes = []
  const opened = []
  function Notification(title, options) {
    const note = { title, ...options, closed: false, close() { note.closed = true } }
    notes.push(note)
    return note
  }
  Notification.permission = permission
  const module = { exports: {} }
  runInNewContext(bundle.outputFiles[0].text, {
    module, exports: module.exports, Notification,
    document: { visibilityState: visibility },
    window: { focus() {} },
  })
  const page = {
    ...module.exports, notes, opened, shown, replies,
    work: source({ bots: {}, approvals: [] }),
    roster: source(roster),
    sessions: source(list),
    polled: source(0),
  }
  page.start = (since = 100) => page.noticeBots({
    work: page.work, roster: page.roster, sessions: page.sessions, polled: page.polled,
    shownSession: () => page.shown, openSession: id => opened.push(id), repliesOn: () => page.replies, since,
  })
  page.poll = () => page.polled.set(count => count + 1)
  return page
}

test('an approval that starts waiting while another conversation shows gets one notification', () => {
  const page = windowWith({ shown: 'a' })
  page.start()
  page.work.set({ bots: {}, approvals: [{ id: 'x1', botId: 'b', roomId: 'r1', sessionId: 'gb', tool: 'pwsh', at: 200 }] })
  page.work.set({ bots: {}, approvals: [{ id: 'x1', botId: 'b', roomId: 'r1', sessionId: 'gb', tool: 'pwsh', at: 200 }] })
  assert.deepEqual(page.notes.map(note => [note.title, note.body, note.tag]), [['Writer is waiting for your approval', 'Ops · pwsh', 'ds-bot-approval-x1']])
  page.notes[0].onclick()
  assert.deepEqual([page.opened, page.notes[0].closed], [['r1'], true])
})

test('no approval notification for the conversation on screen, for approvals older than the window, or without permission', () => {
  const onScreen = windowWith({ shown: 'r1' })
  onScreen.start()
  onScreen.work.set({ bots: {}, approvals: [{ id: 'x1', botId: 'b', roomId: 'r1', tool: 'pwsh', at: 200 }, { id: 'x2', botId: 'b', sessionId: 'b', tool: 'pwsh', at: 50 }] })
  assert.equal(onScreen.notes.length, 0)

  const hidden = windowWith({ visibility: 'hidden', shown: 'r1' })
  hidden.start()
  hidden.work.set({ bots: {}, approvals: [{ id: 'x1', botId: 'b', roomId: 'r1', tool: 'pwsh', at: 200 }] })
  assert.equal(hidden.notes.length, 1)

  const denied = windowWith({ permission: 'default' })
  denied.start()
  denied.work.set({ bots: {}, approvals: [{ id: 'x1', botId: 'b', roomId: 'r1', tool: 'pwsh', at: 200 }] })
  assert.equal(denied.notes.length, 0)
})

const question = { id: 'q1', question: 'Ship the draft to the printer today?', detail: 'The proofs are back', options: [{ label: 'Yes, today' }, { label: 'Wait for edits' }], askedAt: 200 }

test('a question names the Bot that asked, never the question, and notifies once', () => {
  const page = windowWith()
  page.start()
  page.roster.set(team({ questions: { b2: question } }))
  page.roster.set(team({ questions: { b2: question } }))
  assert.equal(page.notes.length, 1)
  const [note] = page.notes
  assert.match(note.title, /Writer/)
  for (const text of [question.question, question.detail, ...question.options.map(option => option.label)]) {
    assert.ok(!`${note.title} ${note.body}`.includes(text), `the notification quotes "${text}"`)
  }
  note.onclick()
  assert.deepEqual(page.opened, ['b'])

  // Answered, then asked again with a new card: that is news again.
  page.roster.set(team())
  page.roster.set(team({ questions: { b2: { ...question, id: 'q2', askedAt: 300 } } }))
  assert.equal(page.notes.length, 2)
})

test('no question notification for the chat on screen, for questions older than the window, or without permission', () => {
  const onScreen = windowWith({ shown: 'b2' })
  onScreen.start()
  onScreen.roster.set(team({ questions: { b2: question, e: { ...question, id: 'q0', askedAt: 50 } } }))
  assert.equal(onScreen.notes.length, 0)

  const hidden = windowWith({ visibility: 'hidden', shown: 'b2' })
  hidden.start()
  hidden.roster.set(team({ questions: { b2: question } }))
  assert.equal(hidden.notes.length, 1)

  const denied = windowWith({ permission: 'denied' })
  denied.start()
  denied.roster.set(team({ questions: { b2: question } }))
  assert.equal(denied.notes.length, 0)
})

test('a finished reply in a Bot\'s own chat notifies once, after the next pull, with a plain snippet', () => {
  const page = windowWith({ list: listWith({ b2: outline([1, 'Earlier answer']) }) })
  page.start()
  page.poll()
  assert.equal(page.notes.length, 0, 'replies already there when the window opened are no news')

  // The turn starts; its outline entry has no response until the turn ends.
  page.sessions.set(listWith({ b2: outline([1, 'Earlier answer'], [2, '']) }))
  page.poll()
  const reply = `## Summary **Done**: I moved the [report](https://example.com/r) to \`docs/\` and _checked_ every link. ${'More words follow here. '.repeat(10)}`
  page.sessions.set(listWith({ b2: outline([1, 'Earlier answer'], [2, reply]) }))
  page.sessions.set(listWith({ b2: outline([1, 'Earlier answer'], [2, reply]) }))
  assert.equal(page.notes.length, 0, 'the reply waits for a pull')
  page.poll()
  page.poll()
  assert.equal(page.notes.length, 1)
  const [note] = page.notes
  assert.equal(note.title, 'Writer replied')
  assert.ok(note.body.startsWith('Summary Done: I moved the report to docs/ and checked every link.'), note.body)
  assert.ok(note.body.length <= 100)
  assert.doesNotMatch(note.body, /[*#`[\]_]|https:/)
  note.onclick()
  assert.deepEqual(page.opened, ['b'])
})

test('no reply notification for hidden Bot-to-Bot turns, the chat on screen, or with the switch off', () => {
  const page = windowWith({ list: listWith({ b2: outline([1, 'Earlier']), e: outline([1, 'Earlier']) }) })
  page.start()
  // The roster learns the turn was an exchange in the same pull that follows its end.
  page.sessions.set(listWith({ b2: outline([1, 'Earlier'], [2, 'Here is the summary you asked for']), e: outline([1, 'Earlier']) }))
  page.roster.set(team({ exchangeTurns: { b2: [2] } }))
  page.poll()
  assert.equal(page.notes.length, 0)

  page.shown = 'e'
  page.sessions.set(listWith({ b2: outline([1, 'Earlier'], [2, 'Here is the summary you asked for']), e: outline([1, 'Earlier'], [2, 'Visible reply']) }))
  page.poll()
  assert.equal(page.notes.length, 0)

  page.shown = 'other'
  page.replies = false
  page.sessions.set(listWith({ b2: outline([1, 'Earlier'], [2, 'Here is the summary you asked for']), e: outline([1, 'Earlier'], [2, 'Visible reply'], [3, 'Another']) }))
  page.poll()
  assert.equal(page.notes.length, 0)

  page.replies = true
  page.sessions.set(listWith({ b2: outline([1, 'Earlier'], [2, 'Here is the summary you asked for']), e: outline([1, 'Earlier'], [2, 'Visible reply'], [3, 'Another'], [4, 'Now with the switch on']) }))
  page.poll()
  assert.deepEqual(page.notes.map(note => [note.title, note.body]), [['Editor replied', 'Now with the switch on']])
})

test('a Bot\'s post in a group notifies with the group\'s name; the user\'s own lines do not', () => {
  const page = windowWith({ roster: team({ rooms: [{ ...ops, preview: 'Editor：Earlier line' }] }) })
  page.start()
  assert.equal(page.notes.length, 0, 'the line already there when the window opened is no news')

  page.roster.set(team({ rooms: [{ ...ops, preview: 'Writer：**Draft** is ready for review' }] }))
  page.roster.set(team({ rooms: [{ ...ops, preview: 'Writer：**Draft** is ready for review' }] }))
  page.roster.set(team({ rooms: [{ ...ops, preview: 'Can someone check the numbers?' }] }))
  assert.deepEqual(page.notes.map(note => [note.title, note.body]), [['Writer in Ops', 'Draft is ready for review']])
  page.notes[0].onclick()
  assert.deepEqual(page.opened, ['r1'])

  page.shown = 'r1'
  page.roster.set(team({ rooms: [{ ...ops, preview: 'Editor：Checked' }] }))
  page.shown = 'other'
  page.replies = false
  page.roster.set(team({ rooms: [{ ...ops, preview: 'Editor：Checked twice' }] }))
  assert.equal(page.notes.length, 1)
})

test('the reply switch is on until it is turned off', () => {
  const page = windowWith()
  const saved = new Map()
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) }
  assert.equal(page.readReplyNotices(storage), true)
  page.writeReplyNotices(false, storage)
  assert.equal(page.readReplyNotices(storage), false)
  page.writeReplyNotices(true, storage)
  assert.equal(page.readReplyNotices(storage), true)
})
