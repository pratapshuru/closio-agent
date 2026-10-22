# closio-agent

You give it a Jira ticket. It plans, codes in reviewed chunks, runs the tests itself, opens one MR per repo, and moves the Jira card. After the MR is open, it handles review comments, QA bugs, rebases, and the move to Ready For Test once the MR is merged.

A human is needed in only two places:

- **When a decision can't be made from evidence.** For example, the ticket and the techspec disagree and no merged code shows which is current. The agent posts one consolidated question on the Jira card, mentions the right person (PM or tech lead), and continues when someone replies.
- **Merging the MR.** That always stays human.

How it works inside, and why it's built that way: [docs/how-it-works.md](docs/how-it-works.md).

## How a ticket flows

```text
agent run SCRUM-123
  intake       Jira ticket + attachments + techspec PDF → runs/SCRUM-123/inputs/
               Jira → In Development
               fresh git worktree per repo on the target branch (your checkout is never touched)
               test baseline: which tests already fail before we change anything
  plan         Dev Agent does recon and writes a chunked plan
               Reviewer Agent (a different model) challenges it; they go back and forth until agreement
               recon first: what the sources settle becomes facts with their source; then the Dev Agent
               grills itself on what's still open and logs each decision (question, options, recommended,
               chosen, why) in decisions.md, all of which go in the MR, folded; only extreme
               blockers go to a human
  chunks       for each chunk: Dev codes → orchestrator runs gates → Reviewer reviews the diff
               → Dev accepts/rejects each finding with evidence → … → one atomic commit
  final        full test suite + build vs baseline, whole-ticket audit, simplify pass, write-up
  publish      push, one MR per repo, Jira → Code Review with MR links, QA curls and the handoff note
  after MR     agent watch: lead's MR comments and QA comments on Jira → fix, re-review, push, reply
               conflicts → rebase and resolve; all MRs merged → Jira → Ready For Test
```

### What is enforced, not just asked for

- **Gates run in the orchestrator.** The orchestrator runs the tests, lint and build itself, so an agent's "tests pass" claim is never trusted. A gate fails only on *new* failures, because tests that already fail on `development` are recorded at the start and ignored.
- **The Dev Agent can only write inside the ticket's worktrees.** Other repos are read-only. Edits to `.env` files are blocked. `git commit/push/reset`, `npm run migrate`, `sequelize`, `psql` and `curl` are blocked. If an agent commits anyway, the commit is undone and its changes are kept.
- **Commits are made by the orchestrator, after review.** One approved chunk becomes one commit. Secret files are never committed.
- **Reviewer verdicts are structured JSON, not prose.** The run follows the verdict field, not wording in a paragraph.
- **The Dev Agent keeps one session for the whole ticket.** Each step resumes it, so context carries from recon through to post-MR fixes. Reviewers start fresh every time.

## Setup (once per laptop)

```bash
git clone <this repo> ~/closio-agent && cd ~/closio-agent
npm install
npm link                                   # puts `agent` on your PATH
cp agent.local.example.yaml agent.local.yaml   # set your repo paths
```

Create `.env` in this folder:

```env
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=...        # id.atlassian.com → Security → API tokens
GITLAB_TOKEN=...          # GitLab → Preferences → Access tokens, scopes: api, read_user
DB_RO_URL_WS2TARGETSALES=postgres://readonly_user:...@host/db   # optional: read-only SQL for recon
```

**Figma (optional but recommended for UI tickets):** connect the official Figma MCP once, for your whole user account, not one folder:

```bash
claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp
```

Then run `claude`, type `/mcp`, choose **figma**, and log in in the browser. The dev bot then reads the screens linked in the ticket and saves them for the reviewer.

Without Figma, drop screenshots and CSS dumps into `runs/<TICKET>/1-input/design/`. The pipeline also finds your old `.claude/<number>/figma/` folders in the frontend repo. If a UI ticket has neither, it pauses and tells you where to drop the files.

For trial runs against real repos, put `gitlab: { mr: { draft: true } }` in `agent.local.yaml` so MRs open as Draft.

Then run `agent doctor`. You need `claude` and `codex` logged in, `brew install poppler` for PDF specs, and the VPN on for GitLab.

## Everyday use

```bash
agent run SCRUM-560 --spec ~/Downloads/techspec.pdf     # start (or continue) a ticket
agent run SCRUM-560 --context ~/closio-web-v2/.claude/560   # add screenshots, CSS dumps, notes
agent status                                            # all runs at a glance
agent status SCRUM-560                                  # plan, commits, MRs
agent answer SCRUM-560 "Q1: follow the ticket, the spec is outdated"
agent watch                                             # QA questions (every 5 min), MR comments, conflicts, merges
agent rebase SCRUM-560                                  # rebase onto develop now (backup branch first)
agent impact SCRUM-560                                  # what this ticket's changes affect (other tickets, uncovered work, spec)
agent impact SCRUM-560 --post                           # note it on the affected tickets, after you read the report
agent feedback SCRUM-560 "lead says use the shared date util"
agent session SCRUM-560                                 # open the dev agent's session yourself
agent sprint-plan                                       # once per sprint: whole-sprint report in sprints/<sprint>-plan.md
agent align SCRUM-561                                   # check against connected tickets now (also automatic before every MR)
agent sprint SCRUM-561                                  # refresh and show this sprint's map
agent run SCRUM-561 --base SCRUM-560                    # force building on another ticket's branch (--base develop for none)
```

While a bot works, one line under the current step shows how long it has been running and what it is doing right now (reading a file, running tests, thinking, writing its answer). To read a bot's whole conversation, `agent session <KEY>` prints a command that opens a safe copy of it.

Every question is asked at the terminal first, so whoever runs the pipeline can answer it. A real blocker shows its recommendation: press Enter to take it or type your own answer. A missing design: drop the files in `runs/<KEY>/1-input/design/` and press Enter, or type `continue without design`. A parent ticket with no branch yet: type `build on <KEY>` or `develop`. Type `later` to post the question on the Jira card instead. Under `agent watch` questions always go to Jira; answer with a comment on the card or with `agent answer`.

`agent run` always continues from where a run stopped. If something breaks (VPN drop, model limit), fix the cause and run the same command again.

## Choosing models

Profiles live in `agent.config.yaml` under `models.profiles`. Each role (dev, reviewer, simplifier, and the sprint `planner`) gets a provider, a model and an effort. The dev and the reviewer each keep one session for the whole ticket; the reviewer also does the final whole-ticket check. The default profile is `quality`: Claude Opus writes and Codex reviews, because a different model catches different mistakes.

```bash
agent run SCRUM-560 --profile cheap                     # for trying things out
agent run SCRUM-560 --set reviewer=claude:opus:high     # override one role
```

Set your personal default in `agent.local.yaml` under `models.default_profile`.

`agent sprint-plan` has its own `planner` model in each profile (Claude Opus, high effort, in `quality`; if a profile leaves it out, its dev model is used). Pick another model for one run with `agent sprint-plan --set planner=codex:gpt-5.6-sol:high`.

## Proving it works: replays

A replay rebuilds a ticket that already merged, starting from the commit before it. Then it scores the result against what the human merged:

- **Hidden tests:** the tests the human wrote for that ticket, run against the agent's code.
- **Scope:** which files each side changed.
- **Process:** reviewer rounds, questions it would have asked, disagreements.
- **Time.**
- **A blind A/B patch pair** for the tech lead to judge without knowing which side is which.

```bash
agent replay REPLAY-550 --repo ws2targetsales --base 60afea5 --reference b57cb4c \
  --ticket-file replays/SCRUM-550.md --context replays/SCRUM-550-files --profile cheap
```

Replays never touch Jira or GitLab, and they auto-answer questions with the agent's own recommendation. Each auto-answer is counted in the scorecard.

## Results so far (2026-10-16, `cheap` profile: Sonnet dev, GPT-5.6-luna reviewer)

| Run | What | Outcome | Human input | Agent calls | Agent time |
|---|---|---|---|---|---|
| REPLAY-550 | SCRUM-550 backend bug, ws2targetsales | **64/64** of the human's own tests pass on the agent's code | 0 | 12 | 8 min |
| REPLAY-548 | SCRUM-548 frontend bug (4 issues), Mapping Skor | **17/17** hidden tests pass; 2 disagreements flagged in MR | 0 | 35 | 33 min |
| AGENT-6 | live sandbox ticket | Draft MR !651 opened, Jira moved In Development → Code Review | 0 | 9 | 4 min |

Gaps the runs found and that are now fixed:
- WS2 tests need env loaded.
- The husky hook can't pass locally.
- A hardcoded limit slipped past the cheap reviewer.
- A handoff over-claimed which tests ran.
- Expected test failures had to be re-justified in every chunk.
- Commit types were wrong (`feat` on a tests chunk or a bug fix).

## Connected tickets and building on another ticket

Every run fetches the ticket's sprint and epic from Jira into `sprints/<sprint>.md`, and saves the full text of connected tickets (Jira links, mentioned keys, same feature) into the run. The dev bot reads them while planning, and fetches more itself if needed. If the ticket needs another ticket's **unmerged code** (e.g. Edit reusing Add's form), the branch starts on that ticket's branch, and the MR says to merge the other one first. Before every MR, an **alignment check** compares the work with the connected tickets (contracts, shared code, the parent's review fixes) and fixes small mismatches.

## Trial runs on a live ticket: `--simulate`

`agent run SCRUM-561 --simulate` runs the whole pipeline on a real ticket without touching its Jira card. It still reads the ticket, attachments and connected tickets, but never moves the card, comments or tags anyone; each of those is written to `runs/SCRUM-561/would-post.md` instead, so you can see exactly what a real run would post. Branches get their own name, `scrum-561-simulated` (then `-2`, `-3`… if an earlier simulation left that branch), so a simulation never touches a real developer's branch or MR, and other tickets never build on it. MRs are opened as drafts with no reviewers assigned; replies on them only reach you and anyone who comments there. The run remembers it: resuming it, or `agent watch`, stays a simulation. `--simulate` can be added to a run that hasn't created its branches yet; once it has, start a fresh simulation instead (`agent clean <KEY>`, delete `runs/<KEY>`, run again with `--simulate`). Questions are asked at the terminal as usual.

## Answering the grill yourself: `--ask`

By default the Dev Agent answers its own grill: every decision recon left open is settled by the agent and logged in `decisions.md` with its options, recommendation, choice and why. With `agent run SCRUM-561 --ask` it asks you instead. Recon and the grill come first, then you answer, and only then is the plan written, built on your answers. One question at a time:

```
Grill · SCRUM-561 · question 3 of 7

How do we stop two edits of the same config from overlapping periods?
  a) check for overlap in the service only
  b) service check + the existing exclusion constraint   ← recommended
  c) lock the row with SELECT … FOR UPDATE
Agent's reasoning: the check gives the spec's error code; the constraint catches the race.
Your answer [Enter = recommended · a/b/c · your own words · auto · auto all]:
```

Enter takes the recommendation, a letter picks an option, anything else is your own answer. `auto` leaves that one to the agent, `auto all` the rest. If you choose differently from the recommendation and that opens a decision the sources can't settle, it comes to you as a follow-up, still before the plan; `limits.grill_rounds` (default 3) caps the follow-up rounds, after which the agent decides and notes it would have asked you. After the grill, plan review settles new decisions from the sources and your answers, and asks you only when nothing can settle one (only with `--ask`; without it, the agent takes its recommendation and logs it). Coding never asks. Hard blockers that only the PM or tech lead can answer still go to them on Jira, in both modes.

The reviewer checks your decisions too. If it thinks one is wrong, it doesn't go to the Dev Agent: you see its evidence and keep yours (Enter), switch to another option, or give your own answer. A decision you keep shows on that decision as "you decided; the reviewer challenged it and you kept it", and isn't raised again. Questions are only asked at the terminal and never go to Jira. When nobody is at one (`agent watch`, output to a file), the run stops with "grill questions waiting: run `agent run <KEY>`" and you answer them there. Each decision in `decisions.md` and the plan says **Decided by: you** or **the agent**. `--ask` also works on a run in progress, from its next grill on.

## Sprint plan, handoff notes and your brief

- **Sprint day:** run `agent sprint-plan` once. The AI reads the whole sprint and writes a local report covering dependencies, start order, FE/BE pairs, collision risks, what to build reusably, and unclear tickets for the tech lead. Every run in that sprint reads the parts about its own ticket.
- **Handoff notes:** when a ticket's MR opens, its note for connected tickets (what it built for reuse and where, its contract, gotchas) is posted as its own comment on the Jira card, with a copy in `runs/<KEY>/handoff-note.md`. Connected tickets' runs read it from the card, on any laptop.
- **Your brief:** if you write a prompt for a ticket (`runs/<KEY>/1-input/brief.md`, or your usual `.claude/<number>/<number>-prompt.md`), both bots follow its technical guidance first.

## QA questions

QA asks the developer a question by starting a Jira comment on the card with `QA-Question:` (small variations like `QA Question -` work too). While the card is in code review or in testing (`jira.statuses.testing`, default Ready For Test and In Testing), `agent watch` checks every 5 minutes and the same dev bot that built the card answers on Jira, tagging the QA. It checks the ticket, its code and, if useful, the dev data, then replies in one to three plain sentences: an answer, "that's expected", "that's a data issue", or "yes, that's a bug". It never changes code from a QA comment; real fixes come through the bug ticket. Other comments after merge get no reply; `agent watch` prints the ones that look like they need you. Jira checks are free; AI is used only when there's a question. `agent sync <KEY>` does the same check right away.

## Protected files, repo notes and deploy notes

- **Protected files:** list them per repo in `agent.config.yaml` under `protected:` (`**` = a whole folder). The bots are told about them, and any edit is undone after every step. Existing migrations and seeders in BE repos are always protected; new ones are fine. If one ticket truly needs a protected file changed: `agent run <KEY> --allow-edit <path>`.
  ```yaml
  repos:
    ws1:
      protected:
        - src/middlewares/validateSchema.js
  ```
- **Repo notes:** if a repo has its own `CLAUDE.md`, `.claude/CLAUDE.md` or `AGENTS.md`, both bots get it (today only WS1 has one). Our safety rules win where they clash.
- **Deploy notes (BE only):** new or removed env vars in `.env.example`, env vars the new code reads that `.env.example` is missing, new migrations or seeders, and the deploy order when a ticket spans BE repos. Shown in the MR as one short "Deploy" line and posted on Jira when the MRs merge; nothing when there's nothing to do.

## VPN

GitLab is behind the company VPN. If it's unreachable when a command needs it, or a GitLab call, fetch or push fails midway, the pipeline reconnects by itself: it starts `openfortivpn`, opens the SSO login in your browser (which completes on its own while your company login is valid), and carries on once GitLab answers. The VPN is left running afterwards, like FortiClient. `agent watch` skips a round instead of waiting.

`agent vpn` connects, `agent vpn off` disconnects, `agent vpn status` shows the state. FortiClient still works as before; just don't run both at once.

One-time setup:

1. `brew install openfortivpn`
2. Let it run as admin without a password prompt (only openfortivpn, and only stopping it):
   ```bash
   echo "#$(id -u) ALL=(root) NOPASSWD: /opt/homebrew/bin/openfortivpn *, /usr/bin/pkill -x openfortivpn" | sudo tee /etc/sudoers.d/closio-agent-vpn >/dev/null && sudo chmod 440 /etc/sudoers.d/closio-agent-vpn && sudo visudo -cf /etc/sudoers.d/closio-agent-vpn
   ```
3. Tell macOS to look up GitLab through the VPN's DNS (openfortivpn can't set macOS DNS itself):
   ```bash
   sudo mkdir -p /etc/resolver && printf "nameserver 10.90.0.53\nnameserver 10.190.0.55\n" | sudo tee /etc/resolver/jcvs.japfacomfeed.co.id
   ```
4. Add the `vpn:` block from `agent.local.example.yaml` to `agent.local.yaml`, and check with `agent doctor`.

If IT renews the VPN server's certificate (the current one expires 2027-02-03), the connect stops with the new fingerprint; put it in `vpn.trusted_cert`. When your company browser login expires, sign in once in the browser tab it opens.

## Where things live

| Path | What | Committed |
|---|---|---|
| `agent.config.yaml` | team config: repos, gates, Jira statuses, model profiles | yes |
| `prompts/` | every prompt the agents get; this is the team's shared skill set | yes |
| `agent.local.yaml`, `.env` | your paths and secrets | no |
| `runs/<KEY>/` | everything about one ticket (below) | no |
| `sprints/` | one map per sprint, refreshed every run, plus the sprint plan | no |

One folder per ticket. Open its `README.md` first: where the ticket stands and what to read.

```
runs/SCRUM-561/
  README.md          where it stands, MR links, what to read first
  decisions.md       what-to-build decisions (grill, gap assumptions, blocker answers, questions settled
                     without the PM or lead, a UI built without the design) with options and why
  questions.md       what it asked, and what it's waiting on
  impact.md          what this ticket affects elsewhere
  handoff-note.md    the note later tickets read
  1-input/           ticket, spec, design, connected tickets; put your brief.md and design/ here before running
  2-plan/            the plan and its reviews
  3-build/           one folder per chunk (reviews and test results), then final/
  4-mr/              MR text per repo, deploy notes
  5-after-mr/        review feedback and rebases
  code/              the ticket's own copies of the repos, one branch per ticket
  .agent/            machine files: state, raw answers, logs per step
```

Your old `.claude/<number>/` brief and figma folders in the FE repo still work too.

The repos themselves never get agent files. Personal `.claude/<ticket>` folders still work as `--context`.

## Repo gates

Each repo lists its gates in `agent.config.yaml`:

- `focused` gates run after every chunk.
- `final` gates run before the MR.

Today's gates:

- **Frontend:** related Vitest tests per chunk; the full suite plus a Vite build at the end.
- **WS2:** eslint on changed files plus mocha unit tests.
- **WS1:** eslint only, because it has no tests.

Add `vue-tsc` and an FE lint config to the frontend repo and you get type checking for free.
