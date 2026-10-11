// replyStrip.js — PERMANENT core. Decide body_mode and strip quoted history.
// Heuristic v0.1 — deliberately simple; tune against real data (per the build plan,
// don't over-build parsing before the first real run).
//
// Returns { clean_text, body_mode, reason, quoted_dropped }:
//   stripped — clean reply: quoted history removed (the thread holds prior messages separately);
//              quoted_dropped = how many lines were left out, so the request can say so
//   whole    — forwards (the quoted chain IS the content) and inline-comment messages

function isQuotedLine (l) { return /^\s*>/.test(l) }

function isForward (text, subject) {
  if (/^\s*(fwd|fw)\s*:/i.test(subject || '')) return true
  if (/-{2,}\s*forwarded message\s*-{2,}/i.test(text)) return true
  if (/^\s*begin forwarded message\s*:/im.test(text)) return true
  return false
}

// "From:"-style labels that open a quoted header block, in the languages we have seen.
const FROM_LABEL = /^(From|De|Von|Da|Van|Från|Fra)\s*:\s/i
const FIELD_LABEL = /(Sent|Date|Envoyé|Enviado|Gesendet|Inviato|Verzonden|To|À|A|An|Aan|Til|Subject|Objet|Asunto|Betreff|Oggetto)\s*:\s/i
// Outlook draws the divider above a quoted chain as a border, which the HTML→text pass renders as a
// run of underscores or dashes on its own line.
const DIVIDER = /^[_\-–—]{5,}\s*$/

// a line's text without its quote marks — Apple Mail puts the "On … wrote:" header INSIDE the
// blockquote, so once htmlToText marks quotes the header arrives as "> On … wrote:"
const unquote = (l) => String(l || '').replace(/^(\s*>\s?)+/, '')

// Lines that mark the start of a quoted reply chain.
function isQuoteHeader (raw, lines, i) {
  const l = unquote(raw)
  if (/^On\b[\s\S]{0,200}\bwrote:\s*$/i.test(l)) return true
  if (/^-{2,}\s*original message\s*-{2,}/i.test(l)) return true
  if (/^\s*Le\b.+a écrit\s*:?\s*$/i.test(l)) return true
  if (/^\s*El\b.+escribió\s*:?\s*$/i.test(l)) return true
  if (/^\s*Am\b.+schrieb\b.*:\s*$/i.test(l)) return true
  if (FROM_LABEL.test(l)) {
    // the header block spread over several lines (the usual plain-text rendering)
    const near = (lines[i + 1] || '') + ' ' + (lines[i + 2] || '') + ' ' + (lines[i + 3] || '')
    if (FIELD_LABEL.test(near)) return true
    // …or COLLAPSED ONTO ONE LINE, which is what an Outlook HTML reply usually becomes once the
    // markup is stripped: "From: X <x@y> Sent: 27 July 2026 To: me Subject: RE: …". Without this the
    // whole quoted chain reads as original body — the 115k-character message that motivated it.
    if (FIELD_LABEL.test(l.replace(FROM_LABEL, ''))) return true
  }
  // a divider line, then a From: block within a couple of lines
  if (DIVIDER.test(l)) {
    for (let j = i + 1; j <= i + 3; j++) {
      if (lines[j] != null && FROM_LABEL.test(unquote(lines[j]).trim())) return true
    }
  }
  return false
}

// ---- trailing-footer trim ---------------------------------------------------------------------
// Legal disclaimers, confidentiality notices and unsubscribe blocks are pure boilerplate that eats
// the request budget (and, worse, survives truncation while real content is cut — bootstrap
// experiment run 1). TRAILING-ONLY and deliberately conservative: a block-opener must sit in the
// trailing part of the body, and enough real text must remain after the cut. Applied to every
// clean_text prepBody returns, so assemble, event snippets and the bulk dump all benefit.
const FOOTER_OPENERS = [
  /^this (e-?mail|message|communication)( and any (attachments|files))?[^\n]{0,120}(confidential|privileged|intended)/i,
  /^the information (contained|transmitted) in this (e-?mail|message)/i,
  /^(confidentiality|legal) (notice|disclaimer)\b/i,
  /^disclaimer\s*:?\s*$/i,
  /^important( notice)?\s*:\s*this (e-?mail|message)/i,
  /^if you (are not the intended recipient|have received this (e-?mail|message) in error)/i,
  /^this (e-?mail|message) is intended (only|solely) for/i,
  /^you (are receiving|received) this (e-?mail|message) because/i,
  /^(unsubscribe|update your (email )?preferences|manage (your )?subscription)\b/i,
  /^please consider the environment before printing/i
]
const FOOTER_MIN_HEAD = 120     // chars of real body that must survive the cut
const FOOTER_TAIL_SHARE = 0.4   // opener must sit in the trailing 60% of the body

export function trimFooters (text) {
  const t = String(text || '')
  if (t.length < FOOTER_MIN_HEAD * 2) return t
  const lines = t.split('\n')
  let cut = -1
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = unquote(lines[i]).trim() // a disclaimer quoted from the replied-to mail is still a disclaimer
    if (offset >= t.length * FOOTER_TAIL_SHARE && line && FOOTER_OPENERS.some(re => re.test(line))) { cut = i; break }
    offset += lines[i].length + 1
  }
  if (cut < 0) return t
  const head = lines.slice(0, cut).join('\n').trim()
  return head.length >= FOOTER_MIN_HEAD ? head : t
}

// Where the quoted history starts: the index of the first quote-header line, else of the first
// quote-marked line, else -1. Exported for inlineDiff.js, which compares what follows it with the
// earlier messages of the thread.
export function quoteCutIndex (lines) {
  for (let i = 0; i < lines.length; i++) if (isQuoteHeader(lines[i].trim(), lines, i)) return i
  for (let i = 0; i < lines.length; i++) if (isQuotedLine(lines[i])) return i
  return -1
}
export { unquote, isQuotedLine }

export function prepBody (rawText, subject) {
  const text = String(rawText || '').replace(/\r/g, '')
  if (!text.trim()) return { clean_text: '', body_mode: 'stripped', reason: 'empty', quoted_dropped: 0 }

  if (isForward(text, subject)) {
    return { clean_text: trimFooters(text.trim()), body_mode: 'whole', reason: 'forward', quoted_dropped: 0 }
  }

  const lines = text.split('\n')
  let cut = lines.length
  for (let i = 0; i < lines.length; i++) {
    if (isQuoteHeader(lines[i].trim(), lines, i)) { cut = i; break }
  }
  const head = lines.slice(0, cut)

  // Interleaving test: new (non-quoted) text appearing AFTER quoted text => the sender interleaved
  // comments; send the whole body. Requires a MEANINGFUL amount of such text: a stray word or a
  // signature line after a quote used to promote a whole long chain to 'whole', which is the
  // expensive direction to be wrong in.
  const INTERLEAVE_MIN_CHARS = 40
  let seenQuote = false
  let afterQuote = 0
  for (const l of head) {
    if (isQuotedLine(l)) seenQuote = true
    else if (seenQuote) afterQuote += l.trim().length
  }
  if (afterQuote >= INTERLEAVE_MIN_CHARS) {
    return { clean_text: trimFooters(text.trim()), body_mode: 'whole', reason: 'inline comments', quoted_dropped: 0 }
  }

  // An HTML reply answered INLINE — the sender's paragraphs written BELOW the "On … wrote:" header,
  // between the quoted ones — is deliberately NOT detected here (2026-09-26, user): no heuristic is
  // reliable across mail clients, and guessing wrong in either direction is costly. Instead the
  // stripped message REPORTS how much it left out (quoted_dropped, shown in the request), the whole
  // text stays available (normalize.full_text), and the model asks for it when the visible text
  // refers to the part below (prompt: "Forwards and inline comments").
  const clean = head.filter(l => !isQuotedLine(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  const droppedQuoted = head.filter(isQuotedLine).length + Math.max(0, lines.length - cut)
  return { clean_text: trimFooters(clean || text.trim()), body_mode: 'stripped', reason: cut < lines.length ? 'reply trimmed' : 'no quote found', quoted_dropped: clean ? droppedQuoted : 0 }
}
