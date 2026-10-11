// styleguideFixtures.js — mock data for the styleguide page ONLY. Shapes mirror the real
// records (projects with embedded todos/responses, events, people view models) so the
// styleguide can feed them through the REAL renderers. Never imported by live pages.

const now = Date.now()
const H = 3600e3
const D = 24 * H

export const NAME_OF = (addr) => ({
  'bob.smith@acme.com': 'Bob Smith',
  'maria@yourco.com': 'Maria Lopez',
  'you@example.com': 'You',
  'digest@newsletter.com': 'Industry Digest',
  'billing@vendor.com': 'Vendor Billing'
})[String(addr || '').toLowerCase()] || addr

export const SELF = ['you@example.com']

export const mockProject = {
  project_id: 'p_01',
  name: 'Acme contract renewal',
  summary: 'Renewing the Acme master services agreement before the July 31 deadline; legal review and pricing are in flight.',
  importance: 4,
  computed_importance: 4,
  importance_locked: false,
  status: 'active',
  created_asof: now - 12 * D,
  last_active_asof: now - 2 * H,
  participant_emails: ['bob.smith@acme.com', 'you@example.com', 'maria@yourco.com'],
  thread_ids: ['th1', 'th2'],
  todos: [
    {
      todo_id: 't_1',
      direction: 'i_owe_them',
      short_description: 'Send the revised draft contract to Bob',
      description: 'Bob asked for the redlined MSA with the new payment terms.',
      sender: 'bob.smith@acme.com',
      counterparty: 'bob.smith@acme.com',
      importance: 4,
      importance_locked: true, // shows the "set by you" dot on the badge corner
      llm_importance: 3,       // ...and makes "revert to 3" appear in the task modal's history
      status: 'open',
      created_asof: now - 2 * D,
      // a full three-stage trail, so the row's history strip shows its real shape
      // (first entry · "… N more" · last entry) rather than a single line
      evidence: [
        { type: 'email', msg_id: 'm1', thread_id: 'th1', asof: now - 2 * D, reason: 'Bob asked for the redlined MSA', who: 'bob.smith@acme.com', summary: 'Bob asks for the redlined MSA with the new payment terms.' },
        { type: 'manual', source: 'manual', asof: now - 1.5 * D, reason: 'you priority 3→4', who: 'you', changed: [{ field: 'importance', from: 3, to: 4 }] },
        { type: 'email', msg_id: 'm1b', thread_id: 'th1', asof: now - 0.5 * D, reason: 'Bob pushed the deadline to Friday', who: 'bob.smith@acme.com', changed: [{ field: 'due_hint', from: null, to: 'Friday' }] }
      ]
    },
    {
      todo_id: 't_2',
      direction: 'i_owe_them',
      short_description: 'Confirm the signing date',
      sender: 'bob.smith@acme.com',
      counterparty: 'bob.smith@acme.com',
      importance: 2,
      status: 'open',
      created_asof: now - 5 * D,
      evidence: [{ msg_id: 'm2', thread_id: 'th1', asof: now - 5 * D, reason: 'created', who: 'bob.smith@acme.com' }]
    },
    {
      todo_id: 't_3',
      direction: 'they_owe_me',
      short_description: 'Bob to send the updated pricing schedule',
      sender: 'you@example.com',
      owner: 'bob.smith@acme.com',
      importance: 5,
      status: 'open',
      created_asof: now - 1 * D,
      due_hint: 'this week',
      evidence: [{ msg_id: 'm3', thread_id: 'th2', asof: now - 1 * D, reason: 'created', who: 'bob.smith@acme.com' }]
    },
    {
      todo_id: 't_4',
      direction: 'team_owes',
      short_description: 'Maria to run the legal review of the MSA',
      sender: 'bob.smith@acme.com',
      owner: 'maria@yourco.com',
      importance: 3,
      status: 'in_progress',
      created_asof: now - 4 * D,
      evidence: [{ msg_id: 'm4', thread_id: 'th2', asof: now - 3 * D, reason: 'created', who: 'maria@yourco.com' }]
    },
    {
      todo_id: 't_5',
      direction: 'read_only',
      short_description: 'Acme quarterly newsletter — renewal terms overview',
      importance: 1,
      status: 'open',
      created_asof: now - 6 * D,
      evidence: [{ msg_id: 'm5', thread_id: 'th3', asof: now - 6 * D, reason: 'created' }]
    },
    {
      todo_id: 't_6',
      direction: 'i_owe_them',
      short_description: 'Book the kickoff call',
      sender: 'bob.smith@acme.com',
      counterparty: 'bob.smith@acme.com',
      importance: 3,
      status: 'resolved',
      created_asof: now - 9 * D,
      resolved_asof: now - 3 * D,
      evidence: [{ msg_id: 'm6', thread_id: 'th1', asof: now - 9 * D, reason: 'created', who: 'bob.smith@acme.com' }, { type: 'manual', source: 'manual', msg_id: null, asof: now - 3 * D, reason: 'user resolved', who: 'you' }]
    }
  ],
  responses: [
    {
      response_id: 'r_1',
      todo_id: 't_1',
      direction: 'i_owe_them',
      kind: 'answer',
      to: ['bob.smith@acme.com'],
      cc: [],
      subject: 'Re: Acme MSA — revised draft',
      body: 'Hi Bob — the revised draft with the updated payment terms is attached. Happy to walk through the changes whenever suits.',
      status: 'suggested'
    }
  ]
}

// a second, quieter project so the board section shows variety
export const mockProject2 = {
  project_id: 'p_02',
  name: 'Office move logistics',
  summary: 'Coordinating the September office move: floor plans, movers, and the IT cut-over.',
  importance: 2,
  computed_importance: 2,
  status: 'active',
  created_asof: now - 30 * D,
  last_active_asof: now - 4 * D,
  participant_emails: ['maria@yourco.com', 'you@example.com'],
  thread_ids: ['th7'],
  todos: [
    {
      todo_id: 't_7',
      direction: 'they_owe_me',
      short_description: 'Maria to confirm the mover quotes',
      owner: 'maria@yourco.com',
      importance: 2,
      status: 'open',
      created_asof: now - 4 * D,
      evidence: [{ msg_id: 'm7', thread_id: 'th7', asof: now - 4 * D, reason: 'created' }]
    }
  ],
  responses: []
}

// events shaped like real `events` records (renderEventCard consumes these)
export const mockEvents = [
  {
    kind: 'message',
    msg_id: 'm3',
    thread_id: 'th2',
    asof: now - 1 * D,
    subject: 'Re: Acme contract — updated pricing',
    from_address: 'bob.smith@acme.com',
    latest_delta: { new_for_me: 1, new_todo_ids: ['t_3'], resolved: [] },
    changes: [
      { type: 'created', short: 'Bob to send the updated pricing schedule', project_id: 'p_01' },
      { type: 'status', short: 'Book the kickoff call', todo_id: 't_6', from: 'open', to: 'resolved', project_id: 'p_01' }
    ],
    cost: 0.0123,
    fetch_rounds: 1,
    source_id: 'gmail:work'
  },
  {
    kind: 'workflow_short_circuit',
    msg_id: 'm9',
    thread_id: 'th9',
    asof: now - 26 * H,
    subject: 'Your weekly industry digest — issue 214',
    from_address: 'digest@newsletter.com',
    via_workflow: 'automated',
    latest_delta: {},
    changes: [],
    source_id: 'gmail:work'
  },
  {
    kind: 'manual_edit',
    asof: now - 27 * H,
    target: 'todo',
    field: 'status',
    before: 'open',
    after: 'resolved',
    project_id: 'p_01',
    todo_id: 't_6'
  },
  {
    kind: 'message',
    msg_id: 'm11',
    thread_id: 'th5',
    asof: now - 28 * H,
    subject: 'Fwd: invoice #4471 — please review',
    from_address: 'billing@vendor.com',
    error: 'LLM call failed: rate limited after 2 retries',
    latest_delta: {},
    changes: [],
    source_id: 'gmail:work'
  }
]

// ctx object in the shape eventsUi expects (eventsData builds the real one)
export const mockEventCtx = {
  nameOf: NAME_OF,
  projectName: (id) => ({ p_01: 'Acme contract renewal', p_02: 'Office move logistics' })[id] || id || '',
  todoShort: (projectId, todoId) => {
    const t = (mockProject.todos || []).find(t => t.todo_id === todoId)
    return (t && t.short_description) || ''
  }
}

// people view models (the shape peopleData builds for the list rows)
export const mockPeople = [
  {
    address: 'bob.smith@acme.com',
    name: 'Bob Smith',
    rank: 4,
    disposition: null,
    oweCount: 2,
    owedCount: 1,
    stats: { messagesFrom: 34, messagesTo: 21 },
    lastActivity: now - 2 * H
  },
  {
    address: 'maria@yourco.com',
    name: 'Maria Lopez',
    rank: 3,
    disposition: null,
    oweCount: 0,
    owedCount: 1,
    stats: { messagesFrom: 12, messagesTo: 15 },
    lastActivity: now - 1 * D
  },
  {
    address: 'digest@newsletter.com',
    name: 'Industry Digest',
    rank: 1,
    disposition: 'newsletter',
    oweCount: 0,
    owedCount: 0,
    stats: { messagesFrom: 58, messagesTo: 0 },
    lastActivity: now - 6 * H
  }
]
