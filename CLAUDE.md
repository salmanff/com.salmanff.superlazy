@freezr-context.md

## The freezr dev server belongs to the USER, never to a Claude session

The user starts/stops the freezr dev server (`npm run dev` / `node server.mjs` in the
freezrPrivate root, port 3000) from their own terminal. If you start one to verify
work against the API: kill it and confirm the port is free (`lsof -ti :3000`) before
ending that task; never run it as a background task that survives your turn, and never
restart/"restore" one after it dies or on session resume. If a server is already
listening, use it and leave it alone; if the port is unexpectedly busy, report it to
the user rather than killing anything (their command: `lsof -ti :3000 | xargs kill`).
Extra instances also each open a Slack Socket Mode connection and split events
randomly, silently breaking live ingestion.

## Prompt-regression tests — read before running, changing or reporting on tests

The analysis prompt is guarded by a regression battery. Machinery (public, generic) lives in
`test/regression/`; everything confidential lives in the GITIGNORED `testConfidential/` — the frozen
store snapshot, the input emails, the test definitions, every run's results and the results table.
Never copy content from `testConfidential/` into `test/`, docs or commits.

**Where things are**
- `testConfidential/results/report.html` — **the record of all test results**: every test × every
  run, ✓ / C- / ✗ per repeat, "what went wrong, and why", the latest result per model, each test's
  pass criteria and the experiment registry. Rebuilt automatically at the end of every real run
  (`node test/regression/report.mjs` rebuilds it by hand). This is what the user reviews.
- `testConfidential/cases.md` — plain-English list of every test + the status/failure analysis.
- `testConfidential/cases/*.json` — the test definitions; `experiments.json` — names every kind of
  trial; `failure-reasons.json` — the "because" shown beside each failure; `results/RUNLOG.md` —
  one section per run.
- `test/regression/README.md` — how the runner, checks, grades (C-) and isolation work.

**Running** (`node test/regression/run.mjs …`)
- Always `--dry` first after changing a test or the prompt (free; builds every request).
- Benchmark recipe: `--reps 1 --rerun-failures` (a second repeat only when the first is not ✓).
- Online/metered (production-faithful): default route, `--family` to pick the model. Local and free
  but drawing on the user's subscriptions: `--via local --family haiku-4|sonnet-5|opus-5` (Claude
  CLI), `--via codex --family gpt-5.6-luna|gpt-5.6-sol|gpt-6-astra` (Codex CLI).
- Before any PAID run that tests new prompt or instruction wording, show the user the exact wording
  and wait for approval. Give a cost estimate for anything beyond a few tests.
- Check the run's last lines: `isolation:` must show no collections read and no network calls
  refused, and `results table →` confirms report.html was rebuilt.

**After every run — keep the record current**
1. Make sure report.html was rebuilt; summarise for the user from it (what changed vs earlier runs).
2. If the run was a new KIND of trial (prompt arm, trial instruction, card-line file, overrides off),
   add an entry to `testConfidential/experiments.json` — otherwise its column shows "E?".
3. If a failure has a newly understood cause, add a line to `testConfidential/failure-reasons.json`.
4. If the overall picture changed, update the status section of `testConfidential/cases.md`.
5. `--accept` (new baseline) only for production-prompt, production-model runs, when the user agrees.

**When adding or changing a test**: edit `testConfidential/cases/*.json` AND its plain-English row in
`testConfidential/cases.md` in the same edit; give it a `title`, per-check `note`s and a `nuance`;
put any new fixture under `testConfidential/`; dry-run and check the request really carries what the
test is about. **When changing `jobs/analyze_thread/prompt.js`**: bump `PROMPT_VERSION` (with a
changelog line) and `JOB_VERSION`, then run the full battery.
