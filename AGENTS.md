# AGENTS.md — superlazy (a freezr app)

This file is read by Codex and other agents automatically (Claude Code reads CLAUDE.md, which points
at the same sources). It is deliberately short: the full framework guidance lives in
`freezr-context.md` in this folder (about 90 KB — too big to inline here), and you MUST read it.

## Read before you touch the app

1. **Read `freezr-context.md` in full before any change to `manifest.json`, any file that calls the
   `freezr` API, or any new page/module.** It is the same guidance the freezr creator gives its own
   model: the manifest spec, the API reference (`freezr.create/query/update…`, files, permissions,
   LLM, mail, messaging, jobs), the permission patterns, and the output/edit conventions. Open it with
   your file tools; do not rely on memory of freezr.
2. For the app's own design, the living specs are `specs/pipeline-walkthrough.md` (how a check
   runs), `specs/pipeline-backlog.md` (issues / TODOs / resolved log) and `specs/superlazy-sessions.md`
   (the work channel). Update the walkthrough and the backlog when you change the pipeline.
3. Any edit under `jobs/` must bump `JOB_VERSION` in `jobs/analyze_thread/index.mjs` and rebuild the
   job zip: `cd jobs/analyze_thread && rm -f ../analyze_thread.zip && zip -q -X ../analyze_thread.zip *.js *.mjs maintenance/*.js`.
4. Run the offline suites after pipeline changes: `node test/verifySessions.mjs`,
   `node test/verifyMessages.mjs`, `node test/verifyProjectMerge.mjs`, `node test/verifyStranded.mjs`
   (pending-queue scan, stranded recovery, per-account failure isolation),
   `node test/verifySubscriptionPrompt.mjs` (subscription prompts never cut; refusal ceiling).

## HARD RULES (violations will break the app — follow these exactly)
1. NEVER use inline <script> tags in HTML files. All JavaScript MUST go in separate .js files listed in the manifest "modules" array. Freezr blocks inline scripts entirely.
2. NEVER use <<< or >>> anywhere in your text, code, or explanations — these are reserved delimiters. Exception: <<<SEARCH>>>, <<<REPLACE>>>, and <<<END_REPLACE>>> are required inside action="edit" file blocks.
3. HTML files must contain only inner-body content. Do NOT include <!DOCTYPE>, <html>, <head>, or <body> tags — freezr wraps these automatically.
4. All apps have access to the freezrApiV2.js which provides the global `freezr` object for reading and writing to the database and user file system. A detailed API reference is included in the project context. 
5. Collection names must NOT contain dots, periods, or special characters.
6. When accessing another app's data (read_all / write_all / write_own), you MUST use the two-step pattern: (a) call freezr.perms.validateDataOwner() to get an access token, then (b) pass that token as appToken in the subsequent freezr.query / freezr.create / etc. call. Skipping step (a) will fail silently.
7. The 'files' collection is reserved for uploaded files (via freezr.upload) — do not use it as a general-purpose collection. Each upload creates one 'files' record whose _id is the file's path (use options.targetFolder to organise into folders). Store per-file metadata in options.data so it lands on that SAME record — do NOT create a parallel collection to track files. freezr auto-adds _mime_type, _file_extension and _file_size. See the File Operations section of the API reference.
8. A JS file goes in the page manifest's `modules` array ONLY if it uses ES module syntax (`import` / `export`). Files that rely on globals (no import/export) must go in `script_files` instead. The two arrays load with different `<script>` types and mixing them up will break the page silently. **Default to writing ES modules** for all in-house JS — use `script_files` only for third-party libraries that have no ESM build.
9. Indexing is limited: only `_date_modified` (auto-set on every record) and `_id` are reliably indexed on all storage backends. So to list recent records, sort by `_date_modified` (e.g. `freezr.query('notes', {}, { sort: { _date_modified: -1 } })`) instead of your own date field — prefer this for simple apps. Querying/sorting by OTHER fields works on some backends but FAILS where indexing is enforced; only do it when the app genuinely needs it, and when you do, state in your explanation that the user must manually create an index for that field on that table.
10. freezr injects its own button (`#freezer_img_button`) on EVERY app page: a 32×32px element fixed to the top-right of the viewport at `top:8px; right:8px` with `z-index:10000`, so it floats above your content. Keep that corner clear — don't put app controls or important content in the top-right, and ensure your top-right elements sit clear of roughly the top-right 48×48px (the button's ~40px footprint plus a small margin), e.g. with top/right padding on a fixed/sticky header. Do not use `z-index` ≥ 10000 in the top-right area.

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
