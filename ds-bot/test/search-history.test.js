import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from '../index.js'
import { groupLines } from '../src/host/chat-index.js'
import { fakeContext } from './fake-ctx.js'

// Writer's own chat has an ended part (b2) and the current one (b2p2). Launch (r1) has
// Writer and Coder; Chief is a Main Bot outside it, and Temp a plain Bot outside it.
const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  whaleStored: true,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    b2: { id: 'b2', sessionId: 'b2p2', name: 'Writer', role: '写作', instructions: '', createdAt: 2, segments: [{ sessionId: 'b2', endedAt: 5_000 }] },
    b3: { id: 'b3', sessionId: 'b3', name: 'Coder', role: '代码', instructions: '', createdAt: 3 },
    b4: { id: 'b4', sessionId: 'b4', name: 'Temp', role: '临时', instructions: '', createdAt: 4 },
  },
  rooms: {
    // The group log keeps the latest 60 of the 140 lines of the 70 rounds below.
    r1: {
      id: 'r1', name: 'Launch', named: true, members: ['b2', 'b3'], admin: 'b3', mode: 'everyone', notice: '', sessions: { b2: 'g2', b3: 'g3' }, seq: 140,
      log: Array.from({ length: 60 }, (_, index) => {
        const round = 40 + Math.floor(index / 2)
        return index % 2 === 0 ? { who: 'User', text: `Status ${round}?`, seq: 81 + index } : { who: 'Coder', botId: 'b3', text: `Round ${round} is on track.`, seq: 81 + index }
      }),
    },
  },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

const text = value => [{ type: 'text', text: value }]
const userSaid = (seq, words) => ({ seq, time: seq * 1000, type: 'user/message', data: { source: { kind: 'user' }, content: text(words) } })
const botSaid = (seq, words) => ({ seq, time: seq * 1000, type: 'assistant/message', data: { message: { content: text(words) } } })
const relayCall = (seq, callId) => ({ seq, time: seq * 1000, type: 'tool/call', data: { callId, name: 'group_relay', arguments: '{}' } })
const relayResult = (seq, callId, replies) => ({
  seq, time: seq * 1000, type: 'tool/result',
  data: { message: { role: 'tool', toolCallId: callId, content: text(JSON.stringify({ replies, passed: [] })) } },
})

// A group round: the user's message, the relay, and Coder's reply.
function rounds(count, first = 0) {
  const events = []
  for (let round = 0; round < count; round += 1) {
    const seq = first + round * 3
    const [asked, answered] = round === 0 ? ['Where is the budget sheet?', 'The budget sheet is in drive/finance, tab Q3.'] : [`Status ${round}?`, `Round ${round} is on track.`]
    events.push(userSaid(seq, asked), relayCall(seq + 1, `c${round}`), relayResult(seq + 2, `c${round}`, [
      { botId: 'b3', name: 'Coder', text: answered, time: (seq + 2) * 1000 },
      { kind: 'lookup', botId: 'b2', name: 'Writer', text: 'budget', time: (seq + 2) * 1000 },
    ]))
  }
  return events
}

const HISTORY = {
  b2: [userSaid(0, 'Write the launch note about pricing'), botSaid(1, 'Here is the pricing memo draft.'), userSaid(2, 'Add a UI note')],
  b2p2: [userSaid(0, 'Now polish the intro')],
  r1: rounds(70),
}

function start() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-search-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const history = structuredClone(HISTORY)
  const ctx = fakeContext()
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    sessionController: {
      resolveAgent: async sessionId => ({ agent: { session: { id: sessionId, seq: (history[sessionId]?.at(-1)?.seq ?? -1) + 1 } } }),
      selectModel: async () => {},
      page: async ({ address, beforeSeq, maxMessages }) => {
        const all = (history[address.sessionId] ?? []).filter(event => beforeSeq === undefined || event.seq < beforeSeq).map(event => ({ event }))
        const records = maxMessages === undefined ? all : all.slice(-maxMessages)
        return { records, hasMore: records.length < all.length }
      },
    },
    sessions: { messageProjections: [] },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => {
    route = options
    return register(options)
  }
  apply(ctx, { home })
  const call = async (endpoint, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
    return response.json()
  }
  const tool = (name, args, sessionId) => ctx.registeredTools.get(name).execute(args, { agent: { id: sessionId } })
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { call, tool, history, stop }
}

test('read_group_chat with words finds lines older than the group log keeps, from the user and the members', async (t) => {
  const { tool, stop } = start()
  t.after(() => stop())
  const latest = await tool('read_group_chat', { group: 'Launch' }, 'b2p2')
  assert.match(latest, /Coder: Round 69 is on track\.$/)
  assert.doesNotMatch(latest, /budget/)
  // Round 3 is long out of the log.
  assert.match(await tool('read_group_chat', { group: 'Launch', query: 'round 3 track' }, 'b2p2'), /\] Coder: Round 3 is on track\.$/m)
  const found = await tool('read_group_chat', { group: 'Launch', query: 'budget sheet' }, 'b2p2')
  assert.match(found, /^"Launch", messages mentioning "budget sheet" \(oldest first\):\n\[[^\]]+\] User: Where is the budget sheet\?\n\[[^\]]+\] Coder: The budget sheet is in drive\/finance, tab Q3\.$/)
  // A word under three characters is matched with LIKE.
  assert.match(await tool('read_group_chat', { group: 'Launch', query: 'Q3' }, 'b2p2'), /Coder: The budget sheet is in drive\/finance, tab Q3\./)
  assert.match(await tool('read_group_chat', { group: 'Launch', query: 'budget nowhere' }, 'b2p2'), /no message has all of "budget nowhere"; messages with the most of these words/)
  assert.match(await tool('read_group_chat', { group: 'Launch', query: 'spaceship' }, 'b2p2'), /^Nothing said in "Launch" mentions "spaceship"\.$/)
})

test('only members and Main Bots search a group', async (t) => {
  const { tool, stop } = start()
  t.after(() => stop())
  assert.match(await tool('read_group_chat', { group: 'Launch', query: 'budget' }, 'b4'), /^No group chat called "Launch" that you can see/)
  assert.match(await tool('read_group_chat', { group: 'Launch', query: 'budget' }, 'm1'), /Coder: The budget sheet/)
})

test('a relay still running is searched once its replies are in', async (t) => {
  const { tool, history, stop } = start()
  t.after(() => stop())
  history.r1.push(userSaid(210, 'Who owns the rollout?'), relayCall(211, 'late'))
  assert.match(await tool('read_group_chat', { group: 'Launch', query: 'rollout' }, 'b3'), /^"Launch", messages mentioning "rollout" \(oldest first\):\n\[[^\]]+\] User: Who owns the rollout\?$/)
  history.r1.push(relayResult(212, 'late', [{ botId: 'b3', name: 'Coder', text: 'I own the rollout.', time: 212_000 }]))
  const found = await tool('read_group_chat', { group: 'Launch', query: 'rollout' }, 'b3')
  assert.equal(found.match(/Who owns the rollout/g).length, 1)
  assert.match(found, /Coder: I own the rollout\.$/)
})

test('the palette search finds an earlier part of a Bot\'s chat and a group\'s replies, short words too', async (t) => {
  const { call, stop } = start()
  t.after(() => stop())
  const memo = (await call('search', { query: 'pricing memo' })).value
  assert.deepEqual(memo.map(hit => [hit.chatId, hit.sessionId, hit.seq, hit.who]), [['b2', 'b2', 1, 'Writer']])
  assert.equal(memo[0].snippet, 'Here is the pricing memo draft.')
  const budget = (await call('search', { query: 'budget' })).value
  assert.deepEqual(budget.map(hit => [hit.chatId, hit.who]).sort(), [['r1', 'Coder'], ['r1', 'user']])
  const short = (await call('search', { query: 'UI' })).value
  assert.deepEqual(short.map(hit => [hit.chatId, hit.sessionId, hit.who, hit.snippet]), [['b2', 'b2', 'user', 'Add a UI note']])
  assert.deepEqual((await call('search', { query: ' ' })).value, [])
})

test('groupLines keeps posts the relay did not log, and skips event posts', () => {
  const post = (seq, source, words) => ({ seq, time: seq, type: 'user/message', data: { source: { kind: 'bot', role: 'post', senderName: 'Coder', ...source }, content: text(`[Group post from Coder]\n${words}`) } })
  const { lines, through } = groupLines([
    post(1, {}, 'Done with the build.'),
    post(2, { logged: 4 }, 'Already in a round.'),
    post(3, { done: true }, ''),
    { seq: 4, time: 4, type: 'tool/ptc-dispatch-start', data: { subCallId: 'k:1', name: 'group_relay' } },
    { seq: 5, time: 5, type: 'tool/ptc-dispatch', data: { subCallId: 'k:1', name: 'group_relay', content: text(JSON.stringify({ replies: [{ name: 'Writer', text: 'Thanks.', time: 5 }] })) } },
  ])
  assert.deepEqual(lines.map(line => [line.who, line.text]), [['Coder', 'Done with the build.'], ['Writer', 'Thanks.']])
  assert.equal(through, 5)
})
