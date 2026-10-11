// userStyle.js — PERMANENT core. Distil a short WRITING-STYLE guide from the user's own sent
// mail (fetched via the injected MailSource), so suggested replies sound like them. Run ONCE per
// session; the result is passed into every analysis request (assemble → the prompt's "user's
// writing style" section). Best-effort: if there are no samples or the call fails, returns ''
// and drafting simply proceeds without a style guide.

const STYLE_PROMPT = `You are profiling ONE person's email writing style from samples of their own sent mail, so an assistant can later draft replies that sound like them. Output a SHORT guide (5-8 bullet points, no preamble) covering: typical greeting and sign-off, formality, average length / brevity, sentence style, recurring phrases or habits, use of names, and any quirks (emoji, punctuation, lowercase, etc.). Be concrete and specific. Do NOT quote whole emails; describe the style.`

// freezr: the client API; source: a MailSource (provides loadSentSamples); meSet: the user's
// addresses; model: {provider,family}. Returns a style-guide string ('' if unavailable).
export async function buildUserStyle (freezr, { source, meSet, model } = {}) {
  let samples = []
  try { samples = source ? await source.loadSentSamples(meSet, { max: 8 }) : [] } catch (e) { samples = [] }
  if (!samples.length) return ''

  const corpus = samples.map((s, i) => `--- sample ${i + 1} (subject: ${s.subject}) ---\n${s.text}`).join('\n\n')
  // thinking off: a 500-token ceiling with default thinking on a recent model can be consumed
  // entirely by reasoning, returning an empty guide after paying for it
  const opts = { context: STYLE_PROMPT, max_tokens: 500, thinking: false }
  if (model && model.provider) opts.provider = model.provider
  if (model && model.family) opts.family = model.family

  try {
    const res = await freezr.llm.ask('Here are the user\'s sent emails. Describe their writing style:\n\n' + corpus, opts)
    if (res && res.success !== false && res.response) return String(res.response).trim()
  } catch (e) { /* fall through */ }
  return ''
}
