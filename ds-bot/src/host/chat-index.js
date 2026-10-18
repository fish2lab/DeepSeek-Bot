// Reading a Bot's own chat and a group's history: Session history pages, the SQLite
// FTS5 index, the search, latest, and around reads behind read_own_chat, the search
// behind read_group_chat, and the search palette's.
//
// Chat index. read_own_chat searches a SQLite FTS5 table of every part of a Bot's own
// chat, ranked by BM25. The trigram tokenizer matches any run of three or more
// characters, so Chinese needs no word splitting; shorter words fall back to LIKE.
// The index is derived from the Session logs: a part catches up when it is read, an
// ended part is sealed once it is complete, and deleting the file only costs a
// rebuild. A group's own Session is in the same table: the user's messages, the Bots'
// posts, and the replies each relay collected, of which the group log keeps only the
// latest. Without SQLite, read_own_chat and read_group_chat scan the logs as before,
// and the palette finds no earlier messages.
import { mkdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { ANCHOR_LINE_MAX, GROUP_CHAT_SEARCH, HISTORY_PAGE, HISTORY_PAGES_MAX, HISTORY_TIMEOUT_MS, OWN_CHAT_BRIEF, OWN_CHAT_LINE_MAX, OWN_CHAT_READ, OWN_CHAT_SEARCH, SOURCE_KIND } from './constants.js'
import { reminderText } from './schedules.js'
import { excerpt, textOf } from './text.js'

const INDEX_VERSION = 3
const AROUND_LINES = 6
const SEARCH_TERMS_MAX = 6
const ANY_TERM_HITS = 50
const INDEX_TIMEOUT_MS = 120_000
// A part still gets a few events (a title, a late reply) just after it ends.
const SEAL_AFTER_MS = 60_000
// The palette asks again at each pause in typing; a part caught up this recently is
// searched as far as it was indexed.
const PALETTE_FRESH_MS = 10_000
const PALETTE_HITS = 20
const SNIPPET_BEFORE = 24
const SNIPPET_MAX = 120
const MESSAGE_HEADER = /^\[(?:Message|Reply) from ([^\]·\n]+?)\s*(?:·[^\]\n]*)?\]\n?/

const termsOf = query => [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, SEARCH_TERMS_MAX)

// A post a running round already logged reaches the group in that round's replies, and
// an event post (a failure, work picked up, stopped or done) is no line of the group.
const loggedElsewhere = source => source.logged !== undefined || Boolean(source.failed || source.resumed || source.stopped || source.done)

// A message into a group's own Session as a line of the group: the user's (or a
// scheduled task's, which the group gets as the user's), or a Bot's post.
function postLine(event) {
  const source = event.data?.source
  const content = textOf(event.data?.content)
  let line
  if (source?.kind === 'user') line = { who: 'user', text: content }
  else if (source?.kind === 'schedule') line = { who: 'user', text: reminderText(content) }
  else if (source?.kind === SOURCE_KIND && source.role === 'post' && !loggedElsewhere(source)) {
    line = { who: source.senderName ?? 'Bot', text: content.replace(/^\[Group post from [^\]]*\]\n?/, '') }
  }
  return line === undefined || line.text.trim() === '' ? undefined : { ...line, seq: event.seq, time: event.time ?? 0 }
}

// The members' messages in a relay's result; its events (passes, failures, lookups)
// carry a kind.
function relayLines(content, event) {
  let value
  try { value = JSON.parse(textOf(content)) } catch { return [] }
  return (Array.isArray(value?.replies) ? value.replies : [])
    .filter(reply => reply?.kind === undefined && typeof reply.name === 'string' && typeof reply.text === 'string' && reply.text.trim() !== '')
    .map(reply => ({ who: reply.name, text: reply.text, seq: event.seq, time: Number.isFinite(reply.time) ? reply.time : event.time ?? 0 }))
}

// What a group's own Session says, oldest first, from its events oldest first.
// `through` is the last seq that is complete: a relay still running has no result yet,
// so it and what follows it wait for the next read.
export function groupLines(events) {
  const lines = []
  const running = new Map()
  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'user/message') {
      const line = postLine(event)
      if (line !== undefined) lines.push(line)
    } else if (event.type === 'tool/call' && data.name === 'group_relay') {
      running.set(data.callId, event.seq)
    } else if (event.type === 'tool/ptc-dispatch-start' && data.name === 'group_relay') {
      running.set(data.subCallId, event.seq)
    } else if (event.type === 'tool/result' && running.has(data.message?.toolCallId)) {
      running.delete(data.message.toolCallId)
      lines.push(...relayLines(data.message.content, event))
    } else if (event.type === 'tool/ptc-dispatch' && running.has(data.subCallId)) {
      running.delete(data.subCallId)
      lines.push(...relayLines(data.content, event))
    } else if (event.type === 'turn/end') {
      // A call cut off with its turn never gets a result.
      running.clear()
    }
  }
  const open = Math.min(...running.values())
  return { lines, through: open === Infinity ? events.at(-1)?.seq : open - 1 }
}

const likeOf = term => `%${term.replace(/[\\%_]/g, char => `\\${char}`)}%`
// Each term is a quoted FTS5 phrase when trigrams can match it, else a LIKE filter.
export function termQuery(terms, sessions, limit, hidden) {
  const long = terms.filter(term => [...term].length >= 3)
  const short = terms.filter(term => [...term].length < 3)
  const where = ['session IN (SELECT value FROM json_each(?))']
  const args = [JSON.stringify(sessions)]
  if (hidden !== undefined) {
    where.push('NOT (session = ? AND seq >= ?)')
    args.push(hidden.session, hidden.from)
  }
  if (long.length > 0) {
    where.unshift('lines MATCH ?')
    args.unshift(long.map(term => `"${term.replace(/"/g, '""')}"`).join(' '))
  }
  for (const term of short) {
    where.push("text LIKE ? ESCAPE '\\'")
    args.push(likeOf(term))
  }
  return { sql: `SELECT text, session, seq, time, who FROM lines WHERE ${where.join(' AND ')} ORDER BY ${long.length > 0 ? 'rank' : 'time DESC'} LIMIT ${limit}`, args }
}

export function install(rt) {
  const { ctx, home } = rt

  const indexPath = join(home, 'chat-index.sqlite')
  let chatIndex
  let indexOpening

  // A Session's events from newest to oldest, also for an archived part.
  async function* eventsBackwards(sessionId, signal, maxPages = HISTORY_PAGES_MAX) {
    const agent = await rt.resolveAgent(sessionId)
    const throughSeq = Number(agent.session.seq) - 1
    let beforeSeq
    for (let pages = 0; throughSeq >= 0 && pages < maxPages; pages += 1) {
      const page = await ctx.sessionController.page({
        address: { kind: 'session', sessionId },
        throughSeq,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
        maxMessages: HISTORY_PAGE,
      }, signal)
      const events = page.records.map(record => record.event)
      for (let index = events.length - 1; index >= 0; index -= 1) yield events[index]
      if (!page.hasMore || events.length === 0) return
      beforeSeq = events[0].seq
    }
  }

  function openIndex() {
    if (chatIndex !== undefined) return Promise.resolve(chatIndex)
    const opening = indexOpening ??= (async () => {
      let DatabaseSync
      try {
        ({ DatabaseSync } = await import('node:sqlite'))
        await mkdir(home, { recursive: true })
      } catch (error) {
        rt.warn('ds-bot: no chat index, read_own_chat scans the logs: %s', error)
        return null
      }
      // A damaged file is rebuilt from the logs once.
      for (const fresh of [false, true]) {
        try {
          if (fresh) await unlink(indexPath).catch(() => {})
          return createIndex(new DatabaseSync(indexPath))
        } catch (error) {
          if (fresh) rt.warn('ds-bot: no chat index, read_own_chat scans the logs: %s', error)
        }
      }
      return null
    })().then((index) => {
      // The plugin may have been disposed while the file opened.
      if (indexOpening !== opening) {
        index?.db.close()
        return null
      }
      return chatIndex = index
    })
    return opening
  }

  function createIndex(db) {
    try {
      db.exec('PRAGMA journal_mode = WAL')
      if (db.prepare('PRAGMA user_version').get().user_version !== INDEX_VERSION) {
        db.exec(`
          DROP TABLE IF EXISTS lines;
          DROP TABLE IF EXISTS marks;
          CREATE VIRTUAL TABLE lines USING fts5(text, session UNINDEXED, seq UNINDEXED, time UNINDEXED, who UNINDEXED, tokenize = 'trigram');
          CREATE TABLE marks (session TEXT PRIMARY KEY, through INTEGER NOT NULL, keep INTEGER NOT NULL, sealed INTEGER NOT NULL, turn INTEGER NOT NULL);
          PRAGMA user_version = ${INDEX_VERSION};`)
      }
      return {
        db,
        mark: db.prepare('SELECT through, keep, sealed, turn FROM marks WHERE session = ?'),
        setMark: db.prepare('INSERT OR REPLACE INTO marks (session, through, keep, sealed, turn) VALUES (?, ?, ?, ?, ?)'),
        insert: db.prepare('INSERT INTO lines (text, session, seq, time, who) VALUES (?, ?, ?, ?, ?)'),
        before: db.prepare('SELECT text, session, seq, time, who FROM lines WHERE session = ? AND seq < ? ORDER BY seq DESC LIMIT ?'),
        from: db.prepare('SELECT text, session, seq, time, who FROM lines WHERE session = ? AND seq >= ? ORDER BY seq LIMIT ?'),
      }
    } catch (error) {
      db.close()
      throw error
    }
  }
  ctx.effect(() => () => {
    chatIndex?.db.close()
    chatIndex = undefined
    indexOpening = undefined
  }, 'ds-bot: chat index')

  // Adds what a part said since its mark. Reads of one part wait for each other, so no
  // line is added twice. A group's own Session is a part that never ends.
  const catchingUp = new Map()
  const caughtUpAt = new Map()
  function catchUp(index, part) {
    const running = catchingUp.get(part.sessionId)
    if (running) return running
    const job = (async () => {
      const mark = index.mark.get(part.sessionId)
      if (mark?.sealed) return
      const through = mark?.through ?? -1
      const events = []
      for await (const event of eventsBackwards(part.sessionId, AbortSignal.timeout(INDEX_TIMEOUT_MS), Infinity)) {
        if (event.seq <= through) break
        events.push(event)
      }
      if (events.length > 0 && events.at(-1).seq !== through + 1) throw new Error(`the history of ${part.sessionId} came back with a gap`)
      events.reverse()
      if (index !== chatIndex) return
      const seal = part.endedAt !== undefined && Date.now() - part.endedAt > SEAL_AFTER_MS
      index.db.exec('BEGIN')
      try {
        const next = part.group ? addGroupLines(index, part.sessionId, events, mark) : addOwnLines(index, part.sessionId, events, mark)
        index.setMark.run(part.sessionId, next.through, next.keep ? 1 : 0, seal ? 1 : 0, next.turn)
        index.db.exec('COMMIT')
      } catch (error) {
        index.db.exec('ROLLBACK')
        throw error
      }
    })().then(() => { caughtUpAt.set(part.sessionId, Date.now()) }).finally(() => catchingUp.delete(part.sessionId))
    catchingUp.set(part.sessionId, job)
    return job
  }

  // A part of a Bot's own chat: what the user, other Bots and the Bot said; returns the
  // new mark.
  function addOwnLines(index, sessionId, events, mark) {
    let keep = mark ? mark.keep === 1 : false
    let turn = mark?.turn ?? -1
    let through = mark?.through ?? -1
    for (const event of events) {
      through = event.seq
      if (event.type === 'turn/start') turn = event.seq
      const entry = rt.historyEntry(event, false)
      if (entry === undefined) continue
      if (entry.answer) {
        if (keep) index.insert.run(entry.text, sessionId, event.seq, event.time ?? 0, 'you')
        continue
      }
      keep = entry.keepAnswers
      if (entry.text !== '') index.insert.run(entry.text, sessionId, event.seq, event.time ?? 0, entry.who)
    }
    return { through, keep, turn }
  }

  // A group's own Session: its lines up to the last complete seq, each with who said it
  // ("user", or the Bot's name then).
  function addGroupLines(index, sessionId, events, mark) {
    const { lines, through } = groupLines(events)
    const last = through ?? mark?.through ?? -1
    for (const line of lines) {
      if (line.seq <= last) index.insert.run(line.text, sessionId, line.seq, line.time, line.who)
    }
    return { through: last, keep: false, turn: -1 }
  }

  // A message's anchor: its part (once there are several) and its seq in that part.
  const anchorOf = (parts, row) => {
    const part = parts.find(item => item.sessionId === row.session)
    return `${parts.length > 1 ? `part ${part?.number ?? '?'} ` : ''}#${row.seq}`
  }
  const rowLine = (parts, row, terms = [], max = OWN_CHAT_LINE_MAX) => {
    const lower = row.text.toLowerCase()
    const wanted = terms.find(term => lower.includes(term)) ?? ''
    const text = row.who === 'user' ? `User: ${row.text}` : row.who === 'you' ? `You: ${row.text}` : row.text
    return `[${anchorOf(parts, row)} · ${rt.clock(row.time)}] ${excerpt(text, wanted, max)}`
  }

  // Every part, caught up. Asked from the current part, the turn that asks is left out
  // (`hidden`): it is in context, and its own question would match.
  async function indexedParts(botId, askingId) {
    const index = await openIndex()
    if (index === null) return { index }
    const parts = rt.partsOf(botId)
    // A part that cannot be read now is searched as far as it was indexed.
    for (const part of parts) await catchUp(index, part).catch(error => rt.warn('ds-bot: indexing %s failed: %s', part.sessionId, error))
    const turn = askingId !== undefined && askingId === parts.at(-1)?.sessionId ? index.mark.get(askingId)?.turn : undefined
    return { index, parts, hidden: turn === undefined || turn < 0 ? undefined : { session: askingId, from: turn } }
  }

  // Messages with all the words, best first; with none of them having all, those with
  // the most of them.
  function findRows(index, terms, sessions, limit, hidden) {
    const run = (wanted, max) => {
      const { sql, args } = termQuery(wanted, sessions, max, hidden)
      return index.db.prepare(sql).all(...args)
    }
    const rows = run(terms, limit)
    if (rows.length > 0 || terms.length < 2) return { rows, every: true }
    // One relay result holds several lines, so a seq alone does not name a line.
    const found = new Map()
    for (const term of terms) {
      for (const row of run([term], ANY_TERM_HITS)) {
        const key = `${row.session}#${row.seq}#${row.time}#${row.who}`
        const hit = found.get(key) ?? { row, count: 0 }
        hit.count += 1
        found.set(key, hit)
      }
    }
    return { rows: [...found.values()].sort((a, b) => (b.count - a.count) || (b.row.time - a.row.time)).slice(0, limit).map(hit => hit.row), every: false }
  }

  // Shown oldest first.
  async function searchOwnChat(botId, query, { askingId, limit = OWN_CHAT_SEARCH } = {}) {
    const terms = termsOf(query)
    const { index, parts, hidden } = await indexedParts(botId, askingId)
    if (index === null) return { lines: await scanOwnChat(botId, query, limit), every: true }
    const sessions = parts.map(part => part.sessionId)
    const byTime = (a, b) => (a.time - b.time) || (sessions.indexOf(a.session) - sessions.indexOf(b.session)) || (a.seq - b.seq)
    const { rows, every } = findRows(index, terms, sessions, limit, hidden)
    return { lines: rows.sort(byTime).map(row => rowLine(parts, row, terms)), every }
  }

  const groupPart = room => ({ sessionId: room.id, group: true })
  const groupLine = (line, terms = []) => {
    const lower = line.text.toLowerCase()
    const wanted = terms.find(term => lower.includes(term)) ?? ''
    return `[${rt.clock(line.time)}] ${line.who === 'user' ? 'User' : line.who}: ${excerpt(line.text, wanted)}`
  }

  // A group's whole history, older than its log too, oldest first.
  async function searchGroupChat(room, query, { limit = GROUP_CHAT_SEARCH } = {}) {
    const terms = termsOf(query)
    const index = await openIndex()
    if (index === null) return { lines: await scanGroupChat(room, query, limit), every: true }
    const part = groupPart(room)
    await catchUp(index, part).catch(error => rt.warn('ds-bot: indexing group %s failed: %s', room.id, error))
    const { rows, every } = findRows(index, terms, [part.sessionId], limit)
    return { lines: rows.sort((a, b) => (a.time - b.time) || (a.seq - b.seq)).map(row => groupLine(row, terms)), every }
  }

  async function scanGroupChat(room, query, limit) {
    const wanted = query.toLowerCase()
    const events = []
    for await (const event of eventsBackwards(room.id, AbortSignal.timeout(HISTORY_TIMEOUT_MS))) events.push(event)
    return groupLines(events.reverse()).lines
      .filter(line => line.text.toLowerCase().includes(wanted))
      .slice(-limit)
      .map(line => groupLine(line, [wanted]))
  }

  // Who said a line, for the palette: "user", or a Bot's name.
  const speakerOf = (row, chatId, group) => {
    if (group || row.who === 'user') return row.who
    if (row.who === 'you') return rt.botOf(chatId)?.name ?? null
    return MESSAGE_HEADER.exec(row.text)?.[1] ?? null
  }
  const snippetOf = (row, terms) => {
    const text = (row.who === 'bot' ? row.text.replace(MESSAGE_HEADER, '') : row.text).replace(/\s+/g, ' ').trim()
    const lower = text.toLowerCase()
    const at = Math.min(...terms.map(term => lower.indexOf(term)).filter(found => found >= 0))
    const from = at === Infinity ? 0 : Math.max(0, at - SNIPPET_BEFORE)
    return `${from > 0 ? '…' : ''}${text.slice(from, from + SNIPPET_MAX)}${from + SNIPPET_MAX < text.length ? '…' : ''}`
  }

  // The search palette: messages in every part of every Bot's own chat and in every
  // group, best first. Without the index it finds none here: scanning every log at
  // each pause in typing would cost too much.
  async function searchHistory(query, { limit = PALETTE_HITS } = {}) {
    const terms = termsOf(query)
    if (terms.length === 0) return []
    const index = await openIndex()
    if (index === null) return []
    const chats = new Map()
    for (const bot of Object.values(rt.state.bots)) {
      for (const part of rt.partsOf(bot.id)) chats.set(part.sessionId, { chatId: bot.id, part })
    }
    for (const room of Object.values(rt.state.rooms)) chats.set(room.id, { chatId: room.id, part: groupPart(room) })
    const now = Date.now()
    const stale = [...chats.values()].filter(({ part }) => !(now - (caughtUpAt.get(part.sessionId) ?? -Infinity) < PALETTE_FRESH_MS))
    await Promise.all(stale.map(({ part }) => catchUp(index, part).catch(error => rt.warn('ds-bot: indexing %s failed: %s', part.sessionId, error))))
    const { sql, args } = termQuery(terms, [...chats.keys()], limit)
    return index.db.prepare(sql).all(...args).map((row) => {
      const { chatId, part } = chats.get(row.session)
      return { chatId, sessionId: row.session, seq: row.seq, time: row.time, who: speakerOf(row, chatId, part.group), snippet: snippetOf(row, terms) }
    })
  }

  // The latest messages across all parts, oldest first.
  async function latestOwnChat(botId, { askingId, limit = OWN_CHAT_READ } = {}) {
    const { index, parts, hidden } = await indexedParts(botId, askingId)
    if (index === null) return scanOwnChat(botId, '', limit)
    const rows = []
    for (const part of [...parts].reverse()) {
      const below = hidden?.session === part.sessionId ? hidden.from : Number.MAX_SAFE_INTEGER
      rows.push(...index.before.all(part.sessionId, below, limit - rows.length))
      if (rows.length >= limit) break
    }
    return rows.reverse().map(row => rowLine(parts, row))
  }

  // The messages around an anchor, in its part.
  async function aroundOwnChat(botId, anchor) {
    const { index, parts } = await indexedParts(botId)
    if (index === null) return { error: 'Anchors need the chat index, which is unavailable here. Search with words instead.' }
    const found = /(?:part\s*)?(\d+)?\s*#\s*(\d+)/i.exec(anchor)
    if (found === null) return { error: `"${anchor}" is not an anchor. Anchors look like "part 2 #1234", or "#1234" in the current part.` }
    const number = found[1] === undefined ? parts.length : Number(found[1])
    const part = parts[number - 1]
    if (part === undefined) return { error: `Your own chat has no part ${number}.` }
    const seq = Number(found[2])
    const rows = [...index.before.all(part.sessionId, seq, AROUND_LINES).reverse(), ...index.from.all(part.sessionId, seq, AROUND_LINES + 1)]
    return { part, exact: rows.some(row => row.seq === seq), lines: rows.map(row => rowLine(parts, row, [], row.seq === seq ? ANCHOR_LINE_MAX : OWN_CHAT_LINE_MAX)) }
  }

  // Without the index: what the user, other Bots, and the Bot itself said, across all
  // parts, oldest first, by reading the logs.
  async function scanOwnChat(botId, query, limit) {
    const wanted = query.toLowerCase()
    const parts = rt.partsOf(botId)
    const signal = AbortSignal.timeout(HISTORY_TIMEOUT_MS)
    const lines = []
    for (const part of [...parts].reverse()) {
      for await (const line of rt.partLines(part.sessionId, signal)) {
        if (wanted !== '' && !line.text.toLowerCase().includes(wanted)) continue
        lines.push(`[${parts.length > 1 ? `part ${part.number} · ` : ''}${rt.clock(line.time)}] ${excerpt(line.text, wanted)}`)
        if (lines.length >= limit) break
      }
      if (lines.length >= limit) break
    }
    return lines.reverse()
  }

  // The parts of a Bot's own chat, for the model: when each ran.
  const partIndex = parts => parts.map(part => `part ${part.number} (${rt.clock(part.startedAt)} – ${part.endedAt === undefined ? 'now' : rt.clock(part.endedAt)})`).join(', ')

  async function ownChatBrief(member) {
    let lines = []
    try { lines = await latestOwnChat(member.id, { limit: OWN_CHAT_BRIEF }) } catch (error) { rt.warn('ds-bot: brief for %s failed: %s', member.name, error) }
    return [
      'Your own chat with the user so far (latest messages, oldest first; private, so share only what the group needs):',
      lines.length > 0 ? lines.join('\n') : 'Nothing yet.',
      'This brief does not change. Call read_own_chat when you need something newer or older from your own chat.',
    ].join('\n')
  }

  Object.assign(rt, { eventsBackwards, searchOwnChat, latestOwnChat, aroundOwnChat, searchGroupChat, searchHistory, partIndex, ownChatBrief })
}
