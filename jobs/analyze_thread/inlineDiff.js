// inlineDiff.js — PERMANENT core. The sender's INLINE additions to a quoted chain, found by COMPARISON,
// not by markers (user, 2026-09-26): whatever text sits inside a reply's quoted region and was not in
// the earlier messages of the thread is what the sender wrote there — the answers typed under the
// questions. Mail clients disagree about how they mark quoted text (Apple Mail and Gmail wrap it in
// blockquotes, which htmlToText renders as "> "; Outlook marks nothing and separates the chain with a
// divider + "From:" block), so a marker-based detector is always partly wrong. A diff against text we
// already hold is right for all of them.
//
// Pure. inlineInsertions(replyFullText, priorTexts) → [{ context, text }]: each passage of new text
// with the quoted paragraph just above it (its question). Nothing here decides what the answers MEAN;
// assemble renders them and the model reads them.

import { quoteCutIndex, unquote, isQuotedLine } from './replyStrip.js'

// Rendering ARTEFACTS a quoting client adds around the same text: Outlook's text rendering of a
// link ("name<mailto:name>", "site<https://…>"), inline-image placeholders ("[cid:…]", "<image001.png>",
// "<a href=…></a>"), bare URLs. Stripped before comparison; a line left empty by that is not text.
const artefacts = (l) => l
  .replace(/<(?:mailto|https?):[^>\s]*>/gi, '')
  .replace(/\[cid:[^\]]*\]/gi, '')
  .replace(/<[^<>\s]*\.(?:png|jpe?g|gif|bmp|webp|svg)>/gi, '')
  .replace(/<a\b[^>]*>.*?<\/a>/gi, '')
  .replace(/https?:\/\/\S+/gi, '')
  .replace(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi, '') // a bare address is contact detail, not prose
// one comparable form for a line: quote marks off, artefacts off, whitespace collapsed, case and
// trailing punctuation dropped — HTML→text renderings of the same paragraph differ in exactly those
// ways — and a space restored after sentence punctuation ("week.Hope" → "week. hope"): an HTML→text
// pass can glue two paragraphs where the quoting client broke the line (measured on the corpus)
const norm = (l) => artefacts(unquote(l)).replace(/([.!?])(?=[A-Za-z])/g, '$1 ').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[\s.:;,!?…"'`-]+$/g, '')
// a sign-off opens the SIGNATURE ZONE of a quoted message: everything until the next quote header is
// name / title / phone / address / disclaimer — never an inline answer (measured on the archive)
const SIGNOFF = /^(best|kind regards|warm regards|regards|best wishes|my best|thanks|thank you|thank you in advance|many thanks|cheers|cordialement|bien à vous|meilleures salutations|salutations|amitiés|merci)[,.!]?\s*\w{0,20}$/i
const HEADER = /^(on\b.{0,200}\bwrote\s*:?|-{2,}\s*original message\s*-{2,}|from\s*:.*|le\b.+a écrit\s*:?|el\b.+escribió\s*:?|am\b.+schrieb.*:)$/i
// contact / signature lines and the artefact-only lines that survive normalisation
const SIGLINE = /^(tel|tél|t|m|f|fax|mobile|mob|phone|office hours|w|e|d)\b\s*[.:]|^\+?\d[\d\s().-]{6,}$|^www\.|^[\w.+-]+@[\w-]+\.[a-z]{2,}$|^sent from (my |outlook)/i
const WORDS = (n) => (n.match(/[a-zà-ÿ]{2,}/gi) || []).length

// lines that a client adds around a quoted chain and that never appear in the message it quotes
const BOILERPLATE = [
  /^on\b.{0,200}\bwrote\s*:?$/i, /^-{2,}\s*original message\s*-{2,}/i, /^(from|to|cc|sent|date|subject|envoyé|de|à|objet)\s*:/i,
  /^[_\-–—]{3,}$/, /^you don'?t often get email from/i, /^learn why this is important/i, /^sent from my /i,
  /^(this (e-?mail|message)|the information (contained|transmitted)|if you (are not the intended recipient|have received this)|confidentiality notice|disclaimer)/i,
  /^\*{5,}$/, /^caution:? this (e-?mail|message) originated/i,
  /^\**\s*this (e-?mail|message) (has )?originated from outside/i, /^\[external\]\s*$/i, /^(when|where|organi[sz]er|attendees|required|optional)\s*:/i,
  /^(regards|kind regards|best regards|best|thanks|thank you|many thanks|cheers),?$/i,
  /^sent from (my |outlook)/i, /^students can book time/i
]
const isBoilerplate = (n) => !n || BOILERPLATE.some(re => re.test(n))

/**
 * @param {string} replyFullText  the reply's WHOLE text (normalize.full_text: footers trimmed, quotes marked)
 * @param {string[]} priorTexts   the earlier messages of the thread (each its full or clean text)
 * @param {object} [o]            minChars: the shortest unmarked line taken as an addition (default 12)
 * @returns {Array<{ context: string, text: string }>}
 */
// minKnownShare: the quoted region must be MOSTLY made of text we hold — otherwise the thread's
// earlier message is not in storage (the user's own sent mail, or mail from before the history
// window) and every quoted line would look "new"; then nothing is claimed and the request falls back
// to its "quoted lines not shown — ask for the body" flag. Measured 2026-09-26 on the stored corpus:
// the false positives were exactly these unstored-parent cases plus client banners.
export function inlineInsertions (replyFullText, priorTexts, { minChars = 12, minKnownShare = 0.5 } = {}) {
  const lines = String(replyFullText || '').replace(/\r/g, '').split('\n')
  const cut = quoteCutIndex(lines)
  if (cut < 0) return []
  const prior = (priorTexts || []).map(t => String(t || '')).filter(Boolean)
  if (!prior.length) return []
  const knownText = ' ' + prior.map(t => t.split('\n').map(norm).filter(Boolean).join(' ')).join(' ') + ' '
  const knownLines = new Set(prior.flatMap(t => t.split('\n').map(norm)).filter(Boolean))
  // a line is "known" when it appears in the earlier messages — as a whole line, or as a run of
  // the thread's text (a paragraph re-wrapped by the quoting client)
  // (the run test from minChars up: a short sentence the quoting client put on its own line — "hope
  // she is well" — is a run of the stored paragraph it came from; measured on the corpus 2026-09-26)
  const known = (n) => knownLines.has(n) || (n.length >= minChars && knownText.includes(' ' + n + ' ')) || (n.length >= 60 && knownText.includes(n.slice(0, 60)))

  // coverage check first: how much of the quoted region's substantive text do we recognise?
  let substantive = 0; let recognised = 0
  for (let i = cut; i < lines.length; i++) {
    const raw = lines[i]; const n = norm(raw)
    if (!n || isBoilerplate(n) || n.length < minChars) continue
    substantive++
    if (isQuotedLine(raw) || known(n)) recognised++
  }
  if (!substantive || recognised / substantive < minKnownShare) return []

  const out = []
  let context = ''
  let current = null
  let inSignature = false
  // an addition counts only UNDER a known quoted paragraph (context set): text at the top of the
  // quoted region with nothing recognised above it is the start of a quoted message we do not hold
  // (typically the user's own sent reply, quoted back), not something the sender typed in here
  const flush = () => { if (current && current.text.trim() && context.trim()) out.push({ context: context.trim(), text: current.text.trim() }); current = null }
  for (let i = cut; i < lines.length; i++) {
    const raw = lines[i]
    const n = norm(raw)
    if (!n) { if (current) current.text += '\n'; continue }
    if (HEADER.test(n)) { flush(); inSignature = false; context = ''; continue } // a new quoted message begins
    if (SIGNOFF.test(n)) { flush(); inSignature = true; continue }
    if (isBoilerplate(n) || SIGLINE.test(n)) { flush(); continue }
    if (isQuotedLine(raw) || known(n)) {
      // quoted text — the question side; remember the last one as the context of what follows
      flush()
      if (!inSignature && WORDS(n) >= 4) context = unquote(raw).replace(/\s+/g, ' ').trim()
      continue
    }
    // in a signature zone, or too short / too few words to be prose: not an answer
    if (inSignature || n.length < minChars || WORDS(n) < 3) { flush(); continue }
    // an unmarked line that the thread does not contain: the sender wrote it here
    if (!current) current = { text: '' }
    current.text += (current.text && !current.text.endsWith('\n') ? '\n' : '') + artefacts(raw).replace(/\s+/g, ' ').trim()
  }
  flush()
  return out
}

/** The request section for a message with inline additions (assemble renders it under the body). */
export function renderInlineInsertions (insertions) {
  if (!insertions || !insertions.length) return ''
  const parts = [`## Inline answers in this message (${insertions.length}) — text the sender wrote INSIDE the quoted part, found by comparing it with the earlier messages of this thread; each is shown under the quoted paragraph it answers`]
  for (const ins of insertions) {
    if (ins.context) parts.push('> ' + ins.context.slice(0, 300))
    parts.push(ins.text.slice(0, 1500))
    parts.push('')
  }
  return parts.join('\n').trimEnd()
}
