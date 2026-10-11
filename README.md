# superlazy

superlazy reads your email, Slack conversations and AI coding-agent sessions, and maintains a to-do
list for you. It uses your own LLM API key to work out what each message means for you:
what you owe, what others owe you, what your team owes, and what is just there to read. It creates 
to-do's, assigns them and resolves them as it reads each message. 

superlazy is a [freezr](https://freezr.info), app. It has no backend of its
own: your mail, your to-dos and the model calls all go through your own freezr server and your own
LLM account.

## What it does
Superlazy lets you be **lazy like Linus**

- **Inputs.** Superlazy reads your mail (Gmail, Microsoft 365 / Outlook, or IMAP, through freezr's mail
  connections), Slack conversations you choose to track, notes you add by hand, and transcripts of
  your Claude Code and Codex sessions (local servers only; see below).
- **Projects and to-dos.** Each input is analysed in the context of your existing projects. To-dos
  have a direction (I owe / they owe me / team owes / to read), an owner, a priority, an optional
  due date and an evidence trail back to the messages that created or changed them.
- **People.** It builds a profile of the people you correspond with (role, what they usually handle
  for you) and uses it to decide who a piece of work belongs to and how important it is.
- **Views.** A dashboard of projects, a to-do list, a mail-client-style Threads view, a
  chronological Events feed and a People directory. You can open the original message and draft or
  send a reply from any of them.
- **Standing instructions.** Plain-language rules you can add (eg "invoices from this sender are low priority and
  belong to X") these are added to the prompt and applied to every relevant message.
- **Weekly clean-up.** An optional periodic pass that proposes merges, closures and archiving. You
  accept or ignore each proposal.
- **Background processing.** A freezr background job checks for new mail on a schedule, so the
  browser doesn't have to stay open.
- **Other apps.** It can deliver matching emails to other freezr apps that ask for them, but only
  for requests you approve (see `app-comms.md`).

Nothing is sent from your accounts unless you press Send.

## Requirements

- A freezr server and an account on it.
- An LLM API key (Claude or ChatGPT), added in freezr under **Account → Resources**. The app steers
  Claude users to the small, fast model (haiku); on ChatGPT it uses your default model.
- At least one input: a mail connection, a Slack connection, or (on a local server) an AI-agent
  file store.
- Although superlaxy can run on front end, it is relly most useful when it is running in background - so ideally, you want to run it on a freezr server where you are admin and can accept the code, or you can use serverless credentials in any freezr app to run the background jobs.

## Install

1. **Install** Add the zip or the url to the repo to your freezr server to install. 
2. **Grant permissions** in the app's Settings page (`/account/app/settings/com.salmanff.superlazy`).
   Grant only what you need:
   - `use_ai`: required.
   - `read_account_email`, plus `send_replies` if you want to send replies from the app.
   - `messaging_read`, plus `send_messages`, for Slack.
   - `run_training_job` and `schedule_training_job` for background processing.
   - `read_work_sessions` for Claude Code / Codex sessions (on localhost pnly).
   - `msg_subscribers` and `share_originals`, only if other apps will request emails from superlazy.
   - `read_archive`, only if you use the Email Cabinet app as a mail archive.
3. **Add connections** at `/account/resources` on your freezr server: your mail account(s), Slack, and your LLM key.
4. **Open the app and go to Setup & Prefs.** Pick a mailbox and a history window. The first run
   reads that window in one large pass and proposes your starting projects, people and questions.
   Correct it, then save. After that, new mail is analysed as it arrives.

### Background processing

The job (`jobs/analyze_thread`) runs either on the freezr server itself or in your own serverless
cloud account. You choose where when you grant the job permissions. To run it on the server, an
admin has to trust the job. Background mode is switched on in Setup & Prefs.

### Claude Code and Codex sessions (local server only)

superlazy can read the transcripts your coding agents leave on your machine. It turns the work you
asked for and left unfinished into to-dos, in the same projects as your mail. This uses freezr's
local file access, so it only works when freezr runs on the same computer, and only for an admin
user:

1. As an admin, turn on `local_fs_access_enabled` in the freezr admin preferences.
2. At `/account/resources`, add a local file store for each agent: `~/.claude/projects` for Claude
   Code, `~/.codex/sessions` for Codex.
3. Grant `read_work_sessions` and pick the store(s). Then choose the repos to track in Setup &
   Prefs.

Session files are read in place; superlazy never writes to them.

## Code Layout

| folder | what is in it |
|---|---|
| `pages/` | the app's pages: the main shell (Dashboard, To-dos, Threads, Events, People), Setup & Prefs, Clean-up |
| `shared/` | components used by several pages (email viewer, project card, editors, top bar, styles) |
| `jobs/analyze_thread/` | the analysis engine and the background job: prompt, request assembly, reconcile, persistence, the clean-up |
| `jobs/bootstrap/` | the first-run pass used by Setup |
| `labs/` | developer tools, not in the menu: single-message inspector, Slack and agent dry runs, request audit, style guide, replay |
| `specs/` | design docs; start with `pipeline-walkthrough.md`, then `pipeline-backlog.md` for open items |
| `test/` | offline tests (`node test/verifyMessages.mjs` etc.) and the regression-battery machinery |

`app-comms.md` is the contract for other apps that want to request emails from superlazy.
`freezr-context.md` is freezr's own app-development guide.

## Tests

The `test/verify*.mjs` files run offline with plain `node` and make no LLM calls. Some read the
local freezr datastore if one exists, and fall back to synthetic data if not. The regression battery
(`test/regression/`) replays real requests against a frozen snapshot. That data is private and not
in this repository, so only the machinery is here. See `test/regression/README.md`.

## License

MIT. See `LICENSE`.
