import { t } from './i18n.js'
import { STORAGE } from './storage.js'
import { currentPart, isHiddenTurn, stripHeader } from './text.js'

// System notifications for what a Bot sends the user while the window is in the
// background or shows another conversation: approvals and questions, which hold work
// up and always notify, and replies, which notify while the switch in Settings is on.
// Only where the platform already allows notifications: DS Bot never asks for the
// permission.

export function readReplyNotices(storage = globalThis.localStorage) {
  try { return storage.getItem(STORAGE.replyNotices) !== 'off' } catch { return true }
}

export function writeReplyNotices(on, storage = globalThis.localStorage) {
  try { storage.setItem(STORAGE.replyNotices, on ? 'on' : 'off') } catch { /* storage unavailable */ }
}

const allowed = () => typeof Notification === 'function' && Notification.permission === 'granted'

// A reply's first words as plain text: no relay header, no Markdown marks.
export function snippet(text, max = 100) {
  const plain = stripHeader(String(text ?? ''))
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/(^|[^\w*])\*(\S(?:[^*]*?\S)?)\*(?![\w*])/g, '$1$2')
    .replace(/(^|\W)_(\S(?:[^_]*?\S)?)_(?!\w)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain
}

// The host writes a Bot's group line as "Name：text" and the user's as the bare text;
// the longest name wins, so "新 Bot 2" is not read as "新 Bot".
const posterOf = (bots, line) => bots
  .filter(bot => line.startsWith(`${bot.name}：`))
  .sort((a, b) => b.name.length - a.name.length)[0]

// `polled` changes after each pull of the team state. A reply waits for one, so the
// roster already knows whether its turn was a hidden Bot-to-Bot exchange.
export function noticeBots({ work, roster, sessions, polled, shownSession, openSession, repliesOn = readReplyNotices, since = Date.now() }) {
  const lookingAt = place => document.visibilityState === 'visible' && shownSession() === place
  const show = (title, body, tag, target) => {
    const note = new Notification(title, { body, tag })
    note.onclick = () => {
      window.focus()
      openSession(target)
      note.close()
    }
  }
  const nameOf = id => roster.getSnapshot().byId[id]?.name ?? t('A Bot')

  const toldApprovals = new Set()
  const noticeApprovals = () => {
    const approvals = work.getSnapshot().approvals ?? []
    for (const id of toldApprovals) {
      if (!approvals.some(entry => entry.id === id)) toldApprovals.delete(id)
    }
    if (!allowed()) return
    for (const entry of approvals) {
      if (toldApprovals.has(entry.id)) continue
      toldApprovals.add(entry.id)
      // Waiting before this window opened is no news: the sidebar shows it.
      if ((entry.at ?? 0) < since || lookingAt(entry.roomId ?? entry.sessionId)) continue
      const room = entry.roomId ? roster.getSnapshot().roomsById[entry.roomId] : undefined
      show(t('{name} is waiting for your approval', { name: nameOf(entry.botId) }), [room?.name, entry.tool].filter(Boolean).join(' · '),
        `ds-bot-approval-${entry.id}`, entry.roomId ?? entry.botId)
    }
  }

  // Questions are keyed by the Session that asked, always a Bot's own chat. The
  // notification names the Bot only: the card is where the question is read and answered.
  const toldQuestions = new Set()
  const noticeQuestions = () => {
    const asked = Object.entries(roster.getSnapshot().questions ?? {}).map(([sessionId, question]) => ({ sessionId, key: question.id ?? `${sessionId}:${question.askedAt}`, at: question.askedAt ?? 0 }))
    for (const key of toldQuestions) {
      if (!asked.some(entry => entry.key === key)) toldQuestions.delete(key)
    }
    if (!allowed()) return
    for (const entry of asked) {
      if (toldQuestions.has(entry.key)) continue
      toldQuestions.add(entry.key)
      if (entry.at < since || lookingAt(entry.sessionId)) continue
      const bot = roster.getSnapshot().byId[entry.sessionId]
      show(t('{name} asked you a question', { name: bot?.name ?? t('A Bot') }), '', `ds-bot-question-${entry.key}`, bot?.id ?? entry.sessionId)
    }
  }

  // A reply in a Bot's own chat is a turn of its current part that ended with text
  // (DSH's turn outline, which the sidebar preview reads too). Per part, the newest turn
  // taken; the turns of a part already on the team when the roster came are no news.
  const takenTurns = new Map()
  // The session list changes far more often than an outline; an outline already read is skipped.
  const readOutlines = new Map()
  let startParts = null
  let replies = []
  let polls = 0
  const takeReplies = () => {
    const team = roster.getSnapshot()
    if (!team.ready) return
    startParts ??= new Set(team.bots.map(currentPart))
    const list = sessions.getSnapshot()
    for (const bot of team.bots) {
      const part = currentPart(bot)
      const outline = list.projectionsBySession?.[part]?.values?.turnOutline ?? list.byId?.[part]?.projectionValues?.turnOutline
      if (!Array.isArray(outline) || readOutlines.get(part) === outline) continue
      readOutlines.set(part, outline)
      const answered = outline.filter(entry => entry.response !== '')
      const newest = answered.at(-1)?.turn ?? -1
      if (!takenTurns.has(part)) takenTurns.set(part, startParts.has(part) ? newest : -1)
      const taken = takenTurns.get(part)
      for (const entry of answered) {
        if (entry.turn > taken) replies.push({ part, botId: bot.id, turn: entry.turn, text: entry.response, poll: polls })
      }
      if (newest > taken) takenTurns.set(part, newest)
    }
  }
  const noticeReplies = () => {
    polls += 1
    const due = replies.filter(entry => entry.poll < polls)
    replies = replies.filter(entry => entry.poll >= polls)
    const team = roster.getSnapshot()
    for (const entry of due) {
      const bot = team.byId[entry.botId]
      if (!bot || bot.hidden || isHiddenTurn(team, entry.part, entry.turn)) continue
      if (!repliesOn() || !allowed() || lookingAt(entry.part)) continue
      show(t('{name} replied', { name: bot.name }), snippet(entry.text), `ds-bot-reply-${bot.id}`, bot.id)
    }
  }

  // A group's last line, as the sidebar shows it, changes with every post there.
  let groupLines = null
  const noticeGroupPosts = () => {
    const team = roster.getSnapshot()
    if (!team.ready) return
    const earlier = groupLines
    groupLines = new Map(team.rooms.map(room => [room.id, room.preview ?? '']))
    if (earlier === null) return
    for (const room of team.rooms) {
      const line = room.preview ?? ''
      if (line === '' || line === earlier.get(room.id) || room.hidden) continue
      const poster = posterOf(team.bots, line)
      if (!poster || !repliesOn() || !allowed() || lookingAt(room.id)) continue
      show(t('{name} in {group}', { name: poster.name, group: room.name }), snippet(line.slice(poster.name.length + 1)), `ds-bot-reply-${room.id}`, room.id)
    }
  }

  const onRoster = () => {
    noticeQuestions()
    noticeGroupPosts()
    takeReplies()
  }
  noticeApprovals()
  onRoster()
  const offs = [
    work.subscribe(noticeApprovals),
    roster.subscribe(onRoster),
    sessions.subscribe(takeReplies),
    polled.subscribe(noticeReplies),
  ]
  return () => { for (const off of offs) off() }
}
