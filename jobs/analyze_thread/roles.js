// roles.js — PERMANENT core. Per-thread role tagging. Only ME is seeded (the user's own
// address(es) from meSet); everyone else carries NO seed — the model decides each person's
// team/external role PER PROJECT from content (a shared email domain is a weak hint at most:
// companies contain many teams, and a same-domain person can be external to a given effort).

export function domainOf (address) {
  const a = String(address || '').toLowerCase()
  const i = a.lastIndexOf('@')
  return i >= 0 ? a.slice(i + 1) : ''
}

export function seedRoster (addresses, meSet) {
  const roster = {}
  for (const raw of addresses) {
    const a = String(raw || '').toLowerCase()
    if (!a) continue
    roster[a] = meSet.has(a) ? 'me' : null
  }
  return roster
}

export function roleOf (address, roster) {
  return roster[String(address || '').toLowerCase()] || null
}
