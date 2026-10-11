// normalize.js — PERMANENT core. Turn a source-shaped raw item into the normalized shape
// the analysis input expects. Source-agnostic AND channel-aware (specs/superlazy-inputs.md):
// every input item — an email, a note, later a chat burst — becomes this ONE shape; `channel`
// says how downstream code reads it (rendering, body prep, profile stats). Absent channel
// means 'mail', so every existing mail call site is unchanged.
//
// raw: { channel?, item_kind?, msg_id, thread_id, date, from:{address,name}, to:[], cc:[],
//        subject, text, html, labels?, source_ref?, message_id_header?, in_reply_to?, references? }

import { htmlToText } from './htmlToText.js'
import { prepBody, trimFooters } from './replyStrip.js'

// participants beyond the author MEAN different things per channel — the renderer labels them
const PARTICIPANTS_KIND = { mail: 'recipients', messages: 'channel_members', notes: 'attendees', calendar: 'attendees', work: 'agent_dialogue' }

export function normalizeMessage (raw) {
  const channel = raw.channel || 'mail'
  const hasText = raw.text && raw.text.trim()
  const baseText = hasText ? raw.text : (raw.html ? htmlToText(raw.html) : '')
  const fromHtml = !hasText && !!raw.html
  // Body prep is per-channel: reply-stripping exists to cut QUOTED MAIL HISTORY out of a reply.
  // A note or a chat burst has no quoted history — running the stripper there would amputate
  // content that merely LOOKS quoted (pasted agendas, indented lists), so non-mail channels
  // always keep the whole body.
  const { clean_text, body_mode, reason, quoted_dropped } = channel === 'mail'
    ? prepBody(baseText, raw.subject)
    : { clean_text: String(baseText || '').trim(), body_mode: 'whole', reason: 'non-mail channel: whole body', quoted_dropped: 0 }
  // the WHOLE text of a stripped reply (footers trimmed, quoted lines marked "> "), kept so the
  // model can ask for it when the visible part refers to the quoted part — an inline reply
  const full_text = (channel === 'mail' && body_mode === 'stripped' && quoted_dropped > 0) ? trimFooters(String(baseText || '').replace(/\r/g, '').trim()) : null
  return {
    channel,
    item_kind: raw.item_kind || null,                 // finer read hint within a channel (e.g. 'meeting_notes')
    participants_kind: raw.participants_kind || PARTICIPANTS_KIND[channel] || 'recipients',
    msg_id: raw.msg_id,
    thread_id: raw.thread_id,
    date: Number(raw.date) || 0,
    from: raw.from || { address: '', name: '' },
    to: raw.to || [],
    cc: raw.cc || [],
    subject: raw.subject || '',
    labels: Array.isArray(raw.labels) ? raw.labels : [], // mail-system labels/categories, when the source provides them (live mail); [] for the archive
    // an UNSENT draft (source-detected, or the provider's own literal label). Never analysed —
    // it has not happened yet, so it produces phantom to-dos and duplicate-of-my-own-note noise.
    is_draft: raw.is_draft === true || (Array.isArray(raw.labels) && raw.labels.some(l => /^drafts?$/i.test(String(l)))),
    source_ref: raw.source_ref || '', // opaque pointer to the full body, interpreted only by the item's source
    message_id_header: raw.message_id_header || '',
    in_reply_to: raw.in_reply_to || null,   // OUR msg_id of the parent (resolved by the source), or null
    references: Array.isArray(raw.references) ? raw.references : [],
    clean_text,
    quoted_dropped: quoted_dropped || 0, // lines of quoted history left out of clean_text (stripped mail)
    full_text,                           // the whole text when something was left out, else null
    body_mode,
    body_mode_reason: (fromHtml ? 'html→text; ' : '') + (reason || ''),
    from_html: fromHtml,
    // opaque per-channel extras the source wants downstream (messages: authors with per-author
    // counts for profile stats, conv_type, first_ts/msg_count for the renderer). Null for mail.
    channel_data: raw.channel_data || null,
    // a REVISION of an already-analysed item (spec §6.4) — the renderer adds the REVISED marker
    // and the model amends the derived to-dos instead of duplicating them. Notes set this after
    // normalize (noteIngest); chunk sources set it on the raw item (an edited Slack message
    // re-queues its chunk).
    revised: raw.revised === true
  }
}
