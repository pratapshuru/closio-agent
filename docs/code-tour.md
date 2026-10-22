# Code tour: closio-agent, file by file

The goal of this tour: after reading it, you can answer "what does X do, where is it, and why is it built that way?" for any part of the repo, without opening the code.

Read it in this order:

1. **The mental model** (5 minutes). Everything else hangs on it.
2. **What happens when you type `agent run`.** One trip through the code, file by file.
3. **Folder by folder.** Reference: every file and what's in it.
4. **Where to look for X**, and **questions you'll get**, with answers.
5. **Glossary** of the code words you'll hear.

---

## 1. The mental model

The whole repo is **one program** with three layers:

```
  YOU type a command
        │
  ┌─────▼──────────────────────────────┐
  │ FRONT DOOR   src/cli.ts            │  reads your command, picks what to do
  └─────┬──────────────────────────────┘
        │
  ┌─────▼──────────────────────────────┐
  │ THE BRAIN    src/pipeline.ts       │  the orchestrator: runs the stages of a ticket,
  │              (class Run)           │  decides every next step, saves after each
  └─────┬──────────────────────────────┘
        │ uses
  ┌─────▼──────────────────────────────────────────────────────────────┐
  │ THE HANDS (helpers, each does one job)                             │
  │  providers.ts → talks to the AIs (Claude, Codex)                   │
  │  gates.ts     → runs tests, lint, build and judges the results     │
  │  git.ts, stack.ts → git work: copies of repos, commits, rebase     │
  │  jira.ts, gitlab.ts → talk to Jira and GitLab                      │
  │  vpn.ts       → keeps the VPN up                                   │
  │  sprint.ts, design.ts, ingest.ts → gather inputs                   │
  └────────────────────────────────────────────────────────────────────┘
        │ reads
  ┌─────▼──────────────────────────────┐
  │ SETTINGS & TEXT                    │
  │  agent.config.yaml (team)          │  repos, branches, tests, models, Jira statuses
  │  agent.local.yaml  (you)           │  your paths, VPN, draft MRs
  │  .env              (secrets)       │  tokens, DB logins
  │  prompts/*.md                      │  what the AIs are told
  └────────────────────────────────────┘
```

Four ideas explain almost every design choice:

1. **The brain is plain code, not AI.** `pipeline.ts` decides what happens next. The AIs only ever get one task at a time and must answer in a fixed shape.
2. **Two AIs, never talking directly.** The dev (Claude) and the reviewer (Codex) only see each other's work through the program, which passes it back and forth. So each one's work gets challenged.
3. **Everything is saved to files.** `runs/<KEY>/state.json` holds where a ticket is; running the same command again continues from there.
4. **Safety is code, not instructions.** What an AI may run is a permission list; what it shouldn't have done is undone by the program after every step.

---

## 2. What happens when you type `agent run SCRUM-561`

Follow this once and you'll know how the files connect.

1. **`bin/agent`** (a 3-line shell script) starts Node and runs `src/cli.ts` with your words.
2. **`src/cli.ts`** reads the command (`run`) and options (`--profile`, `--spec`…), loads settings with **`src/config.ts`**, and makes sure the VPN is up with **`src/vpn.ts`** (because `run` needs GitLab).
3. If `runs/SCRUM-561/` doesn't exist, `cli.ts` creates a new **`Run`** (from **`src/pipeline.ts`**) with a fresh state (**`src/state.ts`**). If it exists, it loads it and continues.
4. **`Run.advance()`** loops: "what stage am I in? run that stage, save, repeat."
5. **Stage `intake`** (`pipeline.ts`, method `intake`):
   - fetches the ticket via **`src/jira.ts`**;
   - converts the ticket and techspec PDF into text files (**`src/ingest.ts`**);
   - finds your brief and the design (**`src/design.ts`**);
   - builds the sprint map (**`src/sprint.ts`**);
   - fetches the latest code;
   - makes the ticket's own copy of each repo (**`src/git.ts`**, "worktrees");
   - records which tests already fail (**`src/gates.ts`**, "baseline").
6. **Stage `planning`**:
   - the dev AI gets the plan task through **`Run.call()`**, which uses **`src/providers.ts`** to start `claude`;
   - the answer is checked against the Plan shape in **`src/schemas.ts`**;
   - the reviewer AI (`codex`, also via `providers.ts`) reviews it, and they go back and forth.
7. **Stage `implementing`**: for each chunk in the plan:
   - the dev writes code;
   - **`guard()`** undoes anything forbidden (`git.ts`);
   - **`gates.ts`** runs the tests;
   - the reviewer reviews;
   - fix rounds;
   - the program commits (`git.ts`).
8. **Stage `finalizing`**: full tests, the whole-ticket review, the cleanup pass, the alignment check, then the write-up (MR text, decision log, deploy notes, impact check).
9. **Stage `publishing`**: push and open MRs (**`src/gitlab.ts`**), and move Jira to Code Review (**`src/jira.ts`**).
10. The run stops at **`in_review`**. Later, **`agent watch`** (also `cli.ts`) loops over open runs and calls **`Run.qaCheck()`** and **`Run.sync()`**, which handle QA questions, review comments, conflicts and merges.

Throughout:
- **`src/util.ts`** provides small tools (run a command, read and write files, log a line);
- **`src/live.ts`** draws the "what is the bot doing now" line;
- **`src/http.ts`** makes the web requests to Jira and GitLab, with retries.

---

## 3. Folder by folder

### 3.1 The repo root

| File | What it is |
|---|---|
| `package.json` | The project's ID card: name, the `agent` command it installs (`bin`), Node 22.18+ required, and three libraries. **`yaml`** reads config files; **`zod`** describes data shapes (see `schemas.ts`); **`vitest`** runs our tests. Also the scripts `npm test` and `npm run typecheck`. |
| `package-lock.json` | Exact library versions, so every laptop installs the same thing. Generated, never edited by hand. |
| `tsconfig.json` | Settings for the TypeScript checker (`npm run typecheck`): strict checking, no build output (Node runs the `.ts` files directly). |
| `vitest.config.ts` | Settings for our tests: only `test/*.test.ts`, never the other repos' tests inside the ticket folders' `code/`. |
| `agent.config.yaml` | **Team settings, committed.** Jira site and statuses (In Development, Code Review, Ready For Test, testing statuses); GitLab site and MR options; each repo (role, GitLab path, target branch, test commands, protected files, hook setting); which repos BE or FE tickets usually touch; model profiles (quality, balanced, cheap, claude-only, smoke); limits (3 review rounds, 2 fix attempts, 45-minute timeout per AI step); design folder; where run files live. |
| `agent.local.example.yaml` | A template of the personal settings file. |
| `agent.local.yaml` | **Your settings, never committed:** where each repo lives on your laptop, draft MRs while testing, default model profile, VPN gateway and certificate fingerprint. Merged on top of the team file. |
| `.env` | **Secrets, never committed:** Jira email and token, GitLab token, dev database logins. |
| `.gitignore` | Keeps secrets, runs, worktrees, logs and personal folders out of git. |
| `README.md` | Setup and daily use for teammates. |

### 3.2 `bin/`: the commands you can run

| File | What it does |
|---|---|
| `bin/agent` | The `agent` command. A tiny shell script that starts `src/cli.ts` with Node. `npm link` puts it on your PATH, so `agent` works from any folder. |
| `bin/agent-sql` | **Read-only database helper**, the only way an AI can touch a database. Usage: `agent-sql <db> "SELECT …"`, and `--list` shows the databases. It reads logins from `.env` (as `DB_RO_<NAME>_HOST/USER/PASSWORD/NAME`), accepts **only one SELECT-type statement**, runs it inside `BEGIN READ ONLY … ROLLBACK` on a read-only session, with a 15-second timeout and at most 300 lines of output. |
| `bin/agent-jira` | **Read-only Jira helper** an AI may run to read another ticket: `agent-jira SCRUM-560 --save <dir>`. It starts `src/tools/agent-jira.ts`. |

### 3.3 `src/`: the program

#### `src/cli.ts`: the front door (~475 lines)

- **What:** turns your typed command into an action. It holds the help text, the list of commands, and the options.
- **Main pieces:**
  - `parse()` reads options such as `--profile`, `--spec`, `--repo`, `--allow-edit`, `--parent`, `--fresh`, `--post`.
  - `startOptions()` turns them into the settings a new run starts with.
  - `main()` is one big `switch` with a case per command:
    - `run` creates or continues a ticket; on a continued run it can swap models or add `--allow-edit`;
    - `watch` is the endless loop: every 5 minutes it calls `qaCheck()` on reviewed or done runs (no VPN needed); every 30 minutes it checks the VPN, then `sync()` on runs in review and continues paused runs;
    - also `answer`, `feedback`, `sync`, `rebase`, `align`, `impact`, `sprint`, `sprint-plan`, `session`, `status`, `replay`, `score`, `clean`, `vpn`, `doctor`.
  - `preflight()` is the VPN check before commands that need GitLab; at a terminal it waits for you if the VPN can't connect.
  - `doctor()` checks the setup: the CLIs exist, Jira and GitLab tokens work, repos exist, Figma MCP, VPN rule.
  - `drive()` runs `run.advance()` and prints a friendly ending.
- **Also:** `network.recover = () => ensureVpn(config)` means "if a GitLab call or a push fails, try reconnecting the VPN before retrying".

#### `src/pipeline.ts`: the brain, the orchestrator (~2,000 lines)

Almost everything lives in one class, **`Run`**: one ticket's run. Think of it in these groups:

**a) Creating and saving a run**
- `Run.create()` sets up a fresh state: stage `intake`, the models from the profile, empty lists. `Run.load()` reads an existing one.
- `save()` writes `runs/<KEY>/.agent/state.json` and refreshes the ticket's `README.md`. `file()` builds paths inside the ticket folder, putting each kind of file in its place (`place()`). `root` is the ticket's `code/` folder.

**b) Talking to the AIs: `call()`**, the most important method.
- Every AI step goes through `call(role, step, prompt, schema, access)`.
- It decides whether to **continue** the role's conversation (one per ticket) or start one, or, for bug tickets, **start from a copy** of the story's conversation.
- It adds the repo's own `CLAUDE.md` if this conversation hasn't seen it yet (`conventions()`).
- It works out what the AI may read and write (`writableDirs()`, `readDirs()`, `gitDirs()`), and runs it through `providers.ts`.
- It checks the answer against the schema, records it in the **ledger** (every call with its timing), and saves the conversation id.
- If the answer is malformed it retries once. If the reviewer's conversation was lost, it starts a fresh one with the full rules.

**c) What the AIs are told**
- The base prompt depends on the ticket's side, from each repo's `kind`: a BE ticket gets `prompts/dev/backend.md` (dev) and `prompts/reviewer/backend.md` (reviewer), an FE ticket the frontend ones, a ticket touching both gets both. Each conversation gets its base once, ahead of its first step, together with each repo's own `CLAUDE.md` (`conventions()`); if planning adds the other side, that base goes out with the next step. `sourceVars()` fills in the ticket's sources and `repoMap()` the repos.
- `reviewerRules()` gives the **short reminder** instead of the full rules once the reviewer has seen them.
- `decisions()` adds "decisions already made" (your answers, assumptions).

**d) Safety and tests**
- `guard()` runs after every writing step: it undoes any commit the AI made (`enforceHead`), reverts `.env` edits, and undoes protected-file edits via `guardFiles()`. `guardFiles()` alone also runs after each rebase conflict round.
- `gates(repo, 'focused' | 'final')` runs a repo's checks through `gates.ts`. `finalGates()` runs the full suite with fix attempts, then drops stale "chunk committed with failing gates" notes.
- `commit()` makes one commit (skipping hooks if the repo is set to); `commitMessage()` builds `type(KEY): summary`.

**e) Asking people**
- `ask()` handles real-blocker questions: with `--auto-answer` it takes the recommendation; otherwise it asks in the terminal (`askInTerminal()`), or else posts to Jira and stops.
- `pause()` is the one way to wait for a person: it writes `questions.md`, tags people on Jira, and stops cleanly.
- `collectAnswers()` reads answers from the terminal inbox or new Jira comments. `mentions()` and `named()` turn `@tech_lead` into real Jira mentions.

**f) The stages** (each is a method `advance()` calls)
- `intake()`: gathers inputs (see section 2). For bug tickets it calls `findParentRun()` and holds the In Development move. It calls `fetchAll()` to fetch every repo and `ensureRepo()` to make each ticket copy and its baseline.
- `planning()`:
  1. bug tickets first go through `confirmBug()`, and `askWhereBugGoes()` if the story isn't merged;
  2. design via `prepareDesign()` / `waitForDesign()`;
  3. the plan, plan reviews and revisions, the reviewer settling questions;
  4. `postGaps()` raises gaps with the lead on Jira; `logCalls()` records the bot's own calls;
  5. then any blocking questions.
- `awaitingAnswers()`: resumes after an answer (design arrived, dependency chosen, questions answered).
- `implementing()` → `runChunk()` for each chunk: write, guard, checks (with planned failures carried forward until the tests chunk), review rounds, fix rounds, disagreements, commit. Before the first chunk, `resolveDependencies()` decides stacking (`branchFor()`, `startOn`).
- `finalizing()`:
  1. `finalGates()`, then the audit loop;
  2. the simplify pass, discarded if anything fails;
  3. `align('final')`;
  4. the handoff: `deployNotes()`, changes, `impact()`;
  5. the MR text via `mrDescription()`;
  6. the note for later tickets, `handoff-note.md`.
- `publishing()`: push, MRs (create or reuse, linked to each other), Jira to Code Review with the summary comment.

**g) After the MR**
- `sync()`, called by `agent watch` or `agent sync`, checks each MR:
  - all merged → Ready For Test plus deploy notes;
  - closed → stop;
  - changed on GitLab (the lead rebased) → `adoptRemote()`;
  - conflict → `rebase()`;
  - new comments → `newFeedback()` then `feedback()`.
- `feedback()`: the dev fixes or replies per comment; replies go to the MR thread or one Jira comment; fixes are reviewed, checked and pushed; new changes trigger `addChanges()` → `impact()` → `refreshMrText()`.
- `qaCheck()`: answers `QA-Question:` comments in plain language (`isQaQuestion()`); pauses outside testing and stops at Done; flags other comments that may need you (`mayNeedDev()`).

**h) Rebase and stacking**
- `rebase()`: backup branch, rebase onto the MR's target (`targetFor()` asks GitLab), `resolveConflicts()` (the dev resolves; checks for leftover markers), a nothing-lost check (`verifyRestack`), fresh baseline, full checks, `reviewRebase()` if there were conflicts, `reportResolution()` (the MR note with only real calls), then a safe push.
- `restack()`: the same for a stacked ticket whose parent branch moved. `backup()` and `safely()` make the backup and add "how to go back" to any error.
- `align()`: re-reads connected tickets, moves onto a changed parent, the dev fixes or notes mismatches.

**i) Writing things up**
- `decide()` adds a line to `decisions.md`, split into "worth a second look" and "other notes". `logRejections()` records findings the dev pushed back on.
- `mrDescription()` builds the MR text.
- `impact()` and `postImpact()` handle the change cascade.
- `deployNotes()` reads env vars, migrations and deploy order from the diff.

**j) The loop**
- `advance()`: "while not done: run the current stage". It knows two special signals from `util.ts` and the bottom of this file:
  - **`PipelineStop`** means stop cleanly (waiting on a person, or failed);
  - **`RetryPhase`** means "an answer came in, run this stage again".

#### `src/providers.ts`: talking to the AIs (~330 lines)

- **What:** starts the AI command-line tools and reads their answers.
- `runAgent(call)` is the entry point. It shows the live status line, picks Claude, Codex or the test fake, logs the line "dev → plan (claude:opus)", and turns failures into `AgentError`.
- `runClaude()`:
  - builds the `claude -p` command: JSON output, the answer schema, permission settings, `--session-id`, `--resume`, or `--resume … --fork-session` for a copy;
  - feeds the prompt in, reads the JSON answer;
  - follows the conversation file so the live line can say "reading X" (`followJsonl()`, `describeClaudeTool()`).
- `claudeSettings()` is the **allowlist**:
  - **allowed:** read-only shell commands (`READ_BASH`); in writing steps the repos' test, lint and type-check commands (`WRITE_BASH`); edits only inside the ticket's worktrees; read-only `git -C <repo>` commands for known repos (`GIT_READ`); the two helpers;
  - **denied:** `DENY_BASH` (git writes, migrations, psql, curl, `rm -rf`…), plus edits to `.env` files and web access.
- `runCodex()` builds `codex exec` (or `exec resume` / `exec fork`) with the schema, a read-only or limited-write sandbox, and images; it reads the event stream for the live line and progress.
- `registerFake()` / `runFake()`: a pretend AI used only by our tests.
- `claudeSessionFile()`: where Claude stores a conversation on disk (used to copy a story's conversation for bug tickets).

#### `src/schemas.ts`: the answer shapes (~240 lines)

- **What:** describes, with zod, exactly what each AI step must answer. `jsonSchema()` converts each one to the format the AI tools enforce.
- The shapes:

| Shape | Answer of | Main fields |
|---|---|---|
| `Plan` | plan step | facts with sources, calls, gaps, questions, chunks, reuses, analogues, risks, upcoming, done checklist, dependencies |
| `Review` | every review | verdict, findings (severity, required, location), status of earlier findings, question assessments |
| `DevWork` | chunk and fix steps | files changed, verification, new calls, commit summary, accept or reject per finding |
| `Handoff` | write-up | MR summary, decisions, changes, risks, testing, review guide, QA curls, Jira summary, notes for later tickets |
| `Feedback` | MR and Jira comments | per item: fix, reply only, or needs a human |
| `Resolve` | rebase conflicts | files and real decisions |
| `Align` | alignment check | — |
| `Impact` | impact check | — |
| `QaAnswer` | QA replies | — |
| `BugTriage` / `TriageCheck` | bug confirm step and its double-check | — |
| `Simplify` | cleanup pass | — |
| `SprintPlan` | sprint report | — |

- **Why every field is required:** Codex's strict mode refuses optional fields, so "empty" is written as an empty list or string instead.

#### `src/state.ts`: what is saved (~170 lines)

- **What:** the shape of `runs/<KEY>/state.json` (type `RunState`), plus small helpers to find, load, save and list runs.
- Key fields:
  - `phase` (the stage) and `repos` (per repo: its copy, branch, base commit, test baseline, commits, parent ticket, MR, backups);
  - `devSession` and `reviewerSession` (conversation ids), `models`, `plan`, `questions`;
  - `decisions`, `changes`, `impact`, `deploy`, `gateNotes`, `disagreements`;
  - `ledger` (every AI call);
  - `processed` (comment ids already handled), `parentRun` and `bugTriage` (bug tickets), `qaWatchEnded`.
- `totals()` sums the ledger: number of calls and time.

#### `src/config.ts`: settings (~215 lines)

- **What:** reads `agent.config.yaml`, lays `agent.local.yaml` on top (`deepMerge`), loads `.env`, and checks everything against a zod shape, so a typo in the config fails loudly.
- `resolveModels()` turns a profile plus `--set` overrides into the model for each role. `resolvePlanner()` does the same for `sprint-plan`.
- `repoPath()` gives where a repo lives on your laptop. `requireEnv()` fails clearly if a token is missing.

#### `src/gates.ts`: running and judging tests (~175 lines)

- **What:** runs a repo's configured checks and decides pass or fail.
- `runGates()` runs each check: focused checks only get the changed files that match. It parses the results (`parseVitest`, `parseMocha`, `parseEslint`, or the exit code), then **subtracts the baseline**, so only failures this ticket caused count.
- `computeBaseline()` runs the final checks once on the starting code; a crashed suite is an error, never "nothing failed".
- `gatesOk()`, `gateReport()` and `gateFailureDetail()` produce pass or fail, the short report for the MR, and the detailed failures for the dev.
- Every check runs with `PGOPTIONS` set to read-only (`SAFE_ENV`), so tests can't write to a database.

#### `src/git.ts`: git work (~245 lines)

- `ensureWorktree()` fetches the target branch and makes the ticket's own copy of a repo under `runs/<KEY>/code/` on a new branch. `linkDependencies()` links `node_modules` from your checkout instead of reinstalling.
- `changedFiles()`, `filesChangedSince()` and `diffStat()` list what changed. `prepareDiffForReview()` makes new files show up in the diff the reviewer reads.
- `commitChanges()` commits (optionally skipping hooks). `enforceHead()` undoes commits an AI made, keeping the changes.
- `revertSecretEdits()` reverts `.env` and key edits. `revertProtectedEdits()` undoes edits to protected files and existing migrations; `matchesPath()` is the "does this path match `src/views/x/**`" check.
- `push()` pushes, with `--force-with-lease` when rewriting, and retries; it tries a VPN reconnect after a failure.
- `startRebase()`, `conflictedFiles()` and `continueRebase()` drive a rebase. `backupBranch()` makes `backup/<branch>-<time>`.

#### `src/stack.ts`: building on another ticket (~60 lines)

- `resolveRef()` finds another ticket's branch. `isMergedInto()` checks "is it already merged?".
- `startOn()` starts our branch on its tip.
- `startRestack()` moves our own commits onto a new base (`rebase --onto`).
- `verifyRestack()` is the **nothing-lost check**: the new base is underneath, every own commit is present, and no conflict markers remain. `ownSubjects()` lists our commit messages for that check.

#### `src/jira.ts`: Jira (~285 lines)

- The `Jira` class talks to Jira's REST API:
  - `getIssue()`: the ticket with links, epic, reporter, sprint and attachments;
  - `search()`;
  - `comments()`: the newest 100;
  - `addComment()`: with real mentions, resent as plain text if Jira rejects the formatting;
  - `transition()`: moves a card by status name;
  - `status()`: the name, and whether it's in the Done group;
  - `myself()`, `findAccountId()`, `sprintFieldId()`, `attachment()`.
- `adfToMarkdown()` and `markdownToAdf()` convert between Jira's rich-text format (ADF) and plain Markdown.
- `isOurComment()` spots our own comments by the `[closio-agent]` marker, so we never reply to ourselves.

#### `src/gitlab.ts`: GitLab (~145 lines)

- The `GitLab` class talks to GitLab's REST API:
  - `createOrGetMr()` reuses an open MR for the branch, so re-runs never duplicate;
  - `getMr()` returns state, conflicts, head and **current target branch**;
  - `notes()` returns comment threads; `reply()` answers in a thread; `comment()` adds a new note;
  - `updateDescription()`, `openMrs()`, `projectId()`, `userIds()`.

#### `src/http.ts`: web requests (~60 lines)

- `request()` is every JSON call to Jira and GitLab: three tries on network errors, rate limits (429) and server errors (5xx). On a network error to GitLab, it first tries a VPN reconnect. `download()` fetches attachments.

#### `src/sprint.ts`: sprint map and connected tickets (~175 lines)

- `buildSprintContext()`:
  1. builds the **sprint map** file (one line per ticket in the sprint and epic, with where its code is);
  2. picks the connected tickets (links, mentioned keys, same-feature titles via `sameFeature()`, `--related`, sprint-plan advice);
  3. saves them in full.
- `findBranches()` finds each ticket's branch and MR (git remote branches, GitLab MRs, our runs); if git can't be reached it skips after one try.
- `mentionedKeys()` finds keys like SCRUM-560 in text; `branchMatches()`.
- `relatedText()` gives a ticket's text plus its handoff note. `handoffFile()` is where that note lives. `slug()` makes file names.

#### `src/sprintplan.ts`: `agent sprint-plan` (~110 lines)

- `runSprintPlan()` has the planner model read the whole sprint and write a local report (start order, dependencies, FE/BE pairs, collisions, reuse, ticket problems). `renderPlan()` writes it.
- `adviceFor()` gives one ticket its part of that report during a run.

#### `src/design.ts`: design input (~160 lines)

- `prepareDesign()` picks the design source: your folder (`findDesignFolders()`, `collectDesignFiles()`, which follows screenshot paths, even with spaces), files saved earlier, Figma MCP (`figmaMcpStatus()`, with only four read tools in `FIGMA_TOOLS`), or none.
- `designBrief()` writes the matching instructions from `prompts/design/`.
- `findBrief()` finds your brief (`runs/<KEY>/1-input/brief.md`, or your old `.claude` prompt files).
- `designWaitMessage()` is the "drop files here" pause text.

#### `src/ingest.ts`: turning inputs into files (~95 lines)

- `buildInputs()` writes the ticket as Markdown (`ticketMarkdown()`), converts techspec PDFs to text with page markers (`pdftotext`), copies context folders, and saves image attachments. `figmaLinks()` finds Figma links in text.

#### `src/vpn.ts`: VPN auto-connect (~105 lines)

- `reachable()` is a 5-second check: does GitLab answer at all?
- `ensureVpn()` checks reachability, and connects if needed; only one connect runs at a time.
- `connect()`:
  1. starts `openfortivpn` in the background (via the admin rule), logging to `runs/_vpn/openfortivpn.log`;
  2. opens the SSO link in your browser;
  3. waits up to 90 seconds for GitLab;
  4. if it fails, gives clear messages for "admin rule missing", "certificate changed" and "login expired".
- `disconnect()` and `vpnRunning()`.

#### `src/live.ts`: the live status line (~65 lines)

- The `Activity` class redraws one line every second under the current step: time running and what the AI is doing. After 20 seconds of silence it says "thinking". When output goes to a file, it prints a heartbeat every 2 minutes instead.
- `aroundLiveLine()` lets normal log lines print above it cleanly.

#### `src/util.ts`: small shared tools (~125 lines)

- `exec()` / `execOk()` run any command; `ensureDir`, `readJson`, `writeJson` (atomic: temp file, then rename), `writeText`.
- `render()` fills `{{variables}}` in prompts and fails if one is missing; `fill()` does the same for config formats.
- `log()` prints a time-stamped line. `tail()`, `now()`.
- `PipelineStop` is the clean-stop signal.
- Constants:
  - `TOOL_ROOT` is the repo folder;
  - `MARKER` is the `[closio-agent]` tag on our comments;
  - `SAFE_ENV` is the read-only database setting;
  - `network.recover` is the VPN reconnect hook.

#### `src/score.ts`: replay scoring (~95 lines)

- `scoreReplay()`, after `agent replay`, runs the human's own tests (from the merged commit) against the agent's code, compares the files each side changed (`overlap()`), and writes a scorecard plus a blind A/B pair of diffs.

#### `src/tools/agent-jira.ts`

- The code behind `bin/agent-jira`: fetches one ticket and prints it (with its handoff note), optionally saving it for the reviewer too.

### 3.4 `prompts/`: what the AIs are told

| File | Used for |
|---|---|
| `dev/backend.md` | **The BE base prompt**, a complete way of working for a backend ticket: sources (techspec, contract, read-only DB), the BE ticket types (read endpoint, write endpoint, schema change, worker/job, WS1 route only, bug fix) and the plan sections each one must cover (error ladder, field-to-column table, migration safety, idempotency…), how to decide, WS1 vs WS2, engineering rules, chunks and tests. |
| `dev/frontend.md` | **The FE base prompt**: sources including the design, the FE ticket types (list, detail, add/edit form, change to a screen, shared component, bug fix) and their plan sections (field tables, states, error codes, Add/Edit reuse…), how the web app is built, engineering rules, chunks and tests. |
| `reviewer/backend.md`, `reviewer/frontend.md` | The reviewer's base for each side: review method, the side's ticket types it must check the plan covers, and the side's own checks (BE: SQL injection, tenant isolation, transactions, migrations, layers; FE: XSS, reactivity, states, copy, permissions). |
| `plan.md`, `plan-revise.md`, `review-plan.md`, `answers.md` | Planning: write the plan, revise it after review, review it, fold in human answers. |
| `chunk.md`, `chunk-fix.md`, `review-chunk.md` | The chunk loop: write it, fix it, review it. `review-chunk` is also reused for cleanup, alignment and feedback commits. |
| `audit.md`, `fix-final.md` | The whole-ticket review and final fixes. |
| `simplify.md`, `simplify-apply.md` | The cleanup pass. |
| `align.md` | The alignment check against connected tickets. |
| `handoff.md` | The write-up: MR text, decisions, changes, deploy notes, review guide, QA curls, notes for later tickets, with a tone example. |
| `impact.md` | The change-cascade report. |
| `feedback.md` | Handling MR and Jira comments. |
| `qa-answer.md` | Answering `QA-Question:` comments in plain words. |
| `resolve-conflicts.md`, `review-rebase.md` | Rebase conflicts and the "is everything still there?" check. |
| `bug-triage.md`, `bug-triage-check.md` | Confirm-first for bug tickets, and the reviewer's double-check. |
| `sprint-plan.md` | The whole-sprint report. |
| `design/*.md` | One snippet per design situation (your folder, saved, Figma MCP, none, unavailable, skipped, wait), plus rules for saving what's fetched. |

### 3.5 `test/`: our own tests (39, all passing)

| File | What it tests |
|---|---|
| `helpers.ts` | Test kit: makes a throwaway git repo with a fake remote, a test config, and canned AI answers. |
| `units.test.ts` | 19 small checks: Jira text conversion and mentions, "only new failures count", "a crashing check is never a pass", secret file detection, model selection, routing BE tickets to repos, Figma links and folders, branch matching, same-feature detection, mentioned keys, sprint advice per ticket, finding your brief, handoff notes. |
| `pipeline.test.ts` | 20 end-to-end runs with fake AIs on real git:<br>• plan to commit; dev/reviewer loops; failed tests sent back to the dev;<br>• undoing AI commits and never committing `.env`; waiting on questions;<br>• disagreements recorded instead of looping forever; planned failures until the tests chunk;<br>• resuming after a crash; pausing for design; continuing without design; only the dev uses Figma;<br>• stacked branches: build on the parent, move when it changes, pause when it doesn't exist, `--base develop`, adopt a GitLab rebase, an already-merged parent. |

The newest features (VPN, QA answers, cascade, bug tickets, protected files, deploy notes) were checked by hand and live, not by these tests yet. That's the planned "tests at the end" chunk.

### 3.6 `docs/`

| File | What it is |
|---|---|
| `closio-agent-overview.md` | The full description: design, every feature, and why. |
| `code-tour.md` | This file. |

### 3.7 Folders created while running (gitignored)

| Folder | What's in it |
|---|---|
| `runs/<KEY>/` | Everything about one ticket: `README.md` (where it stands, what to read), `decisions.md`, `questions.md`, `impact.md`, `handoff-note.md`; `1-input/` (ticket, spec, design, your brief, connected tickets); `2-plan/`; `3-build/` (a folder per chunk with its reviews and test results, then `final/`); `4-mr/`; `5-after-mr/`; `code/` (the ticket's copies of the repos); `.agent/` (state, raw answers, logs per step). Laid out by `Run.file()` and `place()` in `pipeline.ts`. |
| `runs/_baselines/` | Cached test baselines per repo and commit. |
| `runs/_vpn/` | The VPN log. |
| `sprints/` | Sprint maps and sprint-plan reports. |
| `runs/_tmp/` | Throwaway code copies for test baselines and replay scoring. |
| `replays/` | Old tickets used for replays. |

---

## 4. Where to look for X

| If someone asks about… | It's in |
|---|---|
| a command or option | `src/cli.ts` (`main`, `parse`, HELP text) |
| the order of stages, resuming | `src/pipeline.ts` (`advance`, each stage method), `src/state.ts` |
| how an AI is called | `pipeline.ts` `call()` → `providers.ts` `runAgent` / `runClaude` / `runCodex` |
| what an AI may run or edit | `providers.ts` `claudeSettings()` (allow and deny lists) |
| what gets undone | `pipeline.ts` `guard()` / `guardFiles()` → `git.ts` (`enforceHead`, `revertSecretEdits`, `revertProtectedEdits`) |
| what an AI is told | `prompts/*.md`; filled in by `devRules()` / `reviewerRules()` / `repoMap()` |
| what an AI must answer | `src/schemas.ts` |
| tests and "only new failures" | `src/gates.ts` (`runGates`, `computeBaseline`) |
| repo copies, commits, push | `src/git.ts` |
| building on another ticket | `src/stack.ts` + `pipeline.ts` `resolveDependencies` / `restack` |
| rebase | `pipeline.ts` `rebase` / `resolveConflicts` / `reviewRebase` |
| Jira moves and comments | `src/jira.ts`; when they happen: `intake` (In Development), `publishing` (Code Review), `sync` (Ready For Test) |
| MRs | `src/gitlab.ts`; text from `pipeline.ts` `mrDescription()` |
| `agent watch` | `cli.ts` case `watch` → `pipeline.ts` `qaCheck()` and `sync()` |
| QA questions | `pipeline.ts` `qaCheck()`, `isQaQuestion()`, `prompts/qa-answer.md` |
| bug tickets | `pipeline.ts` `findParentRun()`, `confirmBug()`, `askWhereBugGoes()`; `providers.ts` fork support |
| change cascade | `pipeline.ts` `postGaps()`, `addChanges()`, `impact()`, `postImpact()` |
| decision log | `pipeline.ts` `decide()`, `decisionLines()` → `runs/<KEY>/decisions.md` |
| deploy notes | `pipeline.ts` `deployNotes()` |
| sprint map | `src/sprint.ts` `buildSprintContext()` |
| design | `src/design.ts` |
| database access | `bin/agent-sql`; read-only for tests via `SAFE_ENV` in `util.ts` |
| VPN | `src/vpn.ts`; reconnect hooks in `http.ts` and `git.ts` |
| the live line | `src/live.ts`, fed by `providers.ts` |
| settings | `agent.config.yaml`, `agent.local.yaml`, `.env`; read by `src/config.ts` |

---

## 5. Questions you'll get, and the answers

**Is it one program or several?**
One program, the `agent` CLI. `run`, `watch`, `sync`, `rebase` and the rest are commands of the same program. `watch` is the same orchestrator kept running in a loop.

**What language, what framework?**
TypeScript on Node 22, run directly with no build step. No agent framework: the orchestrator is a plain class with one method per stage. The only libraries are `yaml`, `zod`, and `vitest` for tests.

**Where's the "AI agent" code?**
There's no AI inside our code. We start Claude Code and Codex as command-line tools (`providers.ts`) and give them a prompt plus the exact answer shape. Our code decides when to call them, with what, and what to do with the answer.

**How do the two AIs talk to each other?**
They don't. `pipeline.ts` passes the dev's plan or code, plus the test results, to the reviewer; the reviewer's findings back to the dev; and the dev's answers back to the reviewer. Each keeps its own conversation for the ticket.

**How does it remember things between steps?**
Two ways. Each AI keeps one conversation per ticket (resumed with `--resume`), and the program saves everything to `runs/<KEY>/state.json` after every step.

**What happens if my laptop sleeps or it crashes?**
The state was saved after the last step. `agent run KEY` continues from there. An approved chunk that wasn't committed yet commits without being reviewed again.

**How do you stop the AI from deleting things or touching the database?**
Before each step, Claude runs in "dontAsk" mode with an allowlist (`claudeSettings()`): anything not listed is refused. Codex runs in a read-only sandbox. After each step, `guard()` undoes commits, `.env` edits and protected-file edits. Databases are read-only at three levels (`agent-sql`, plus `PGOPTIONS` for every process).

**How does it know which tests to run?**
Each repo's test commands are in `agent.config.yaml` (focused and final). `gates.ts` runs them and reads the JSON results.

**Why do old failing tests not block it?**
`computeBaseline()` records failures on the starting code; `runGates()` only counts failures that weren't there before.

**How does it pick the repos for a ticket?**
A first guess from labels and the title (`routing` in the config), then the plan can add or drop repos with a reason.

**How does it decide to build on another ticket's branch?**
The plan lists real code dependencies; `resolveDependencies()` looks up that ticket's branch (`stack.ts`, sprint map) and starts on its tip, unless it's merged already, or you override with `--base`.

**How are MR descriptions written?**
The dev writes the parts in the Handoff shape (`prompts/handoff.md` has a tone example). `mrDescription()` assembles them, hides empty sections, and adds deploy notes and the folded details.

**What's in the decision log and how does it get to the MR?**
`decide()` appends every call made without asking a person: the bot's own choices, gaps, findings it rejected, your answers, branching. The important ones go into the MR as "Worth a second look"; the full log is linked.

**How does it answer QA?**
`qaCheck()` (from `agent watch` every 5 minutes) finds comments starting with `QA-Question:`, sends them to the same dev conversation with `prompts/qa-answer.md`, and posts each reply tagging the QA.

**How do bug tickets get the story's memory?**
`findParentRun()` finds the story among the bug's Jira parent, links or mentions that has a run on this laptop. The first dev and reviewer calls then start from **copies** of the story's conversations (`--fork-session`, `codex exec fork`). The confirm step runs before anything else.

**How does the VPN connect by itself?**
`vpn.ts` starts `openfortivpn` with SAML login and opens the company SSO page in the browser. `cli.ts` checks before GitLab commands, and `http.ts` and `git.ts` call it again after network failures.

**How is it tested?**
39 tests run against fake AIs and real git repos (`test/`). The pipeline was also run on replays of shipped tickets and on live sandbox tickets. Newer features were checked live and by hand; their automated tests are the planned final chunk.

**Where would I change X?**
- Rules or tone: `prompts/`.
- Repos, branches, tests, protected files, models, Jira statuses: `agent.config.yaml`.
- Your paths, VPN or draft MRs: `agent.local.yaml`.
- Behaviour: `src/pipeline.ts`, the stage in question.

---

## 6. Glossary of code words

| Word | Meaning here |
|---|---|
| **CLI** | Command-line interface: a program you run by typing in a terminal, like `agent run`. |
| **TypeScript / Node** | The language (JavaScript with types) and the engine that runs it. |
| **Module / file** | Each `src/*.ts` file is one module with one job. |
| **Function / method** | A named piece of code that does one thing. A method is a function belonging to a class (e.g. `Run.planning()`). |
| **Class** | A bundle of data plus the functions that work on it. `Run` is one ticket's run. |
| **async / await** | "This takes time (network, an AI, a command); wait for it before continuing." |
| **Subprocess** | Another program started by ours, e.g. `claude`, `codex`, `git`, `npx vitest`. |
| **Schema / zod** | A description of the exact shape data must have; zod is the library that checks it. |
| **JSON** | The text format the AIs answer in and state is saved in. |
| **Prompt template** | A Markdown file with `{{blanks}}` the program fills in before sending it to an AI. |
| **Session / conversation id** | The id of one AI conversation, used to continue it (`--resume`) or copy it (`--fork-session`). |
| **Worktree** | A second checkout of a repo in another folder, on its own branch, so the ticket never touches your own checkout. |
| **Baseline** | The tests that already failed before the ticket's changes. |
| **Gate / check** | One configured test, lint or build command. |
| **Guard** | The after-step safety pass that undoes forbidden changes. |
| **Allowlist** | The list of commands an AI may run; everything else is refused. |
| **REST API** | How programs talk to Jira and GitLab over the web. |
| **ADF** | Jira's rich-text format, converted to and from Markdown. |
| **MCP** | Model Context Protocol: how Claude connects to tools like Figma. |
| **Fork (a conversation)** | Copy a conversation so it can continue separately; the original is untouched. |
| **force-with-lease** | A push that refuses to overwrite commits someone else pushed. |
| **Rebase / restack** | Move our commits on top of newer code; restack = onto a parent ticket's new tip. |
| **Ledger** | The list of every AI call in a run, with timing. |
