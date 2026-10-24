# closio-agent

Give it a Jira ticket and it builds it: plans, codes, gets its work reviewed, runs the tests and opens the MR. After that it fixes review comments, answers QA questions, rebases when needed and moves the card once the MR is merged.

A human is needed in only two places:

- **When something can't be settled from the sources.** For example, the ticket and the techspec disagree and no merged code shows which one is right. The agent asks on the Jira card, tags the relevant person and carries on when they reply.
- **Merging the MR.** That always stays with a person.

How it works inside, and why: [docs/how-it-works.md](docs/how-it-works.md).

## What happens when you run a ticket

1. **Intake:** reads the ticket, attachments, your techspecs, connected tickets and the code. Moves the card to In Development. Makes its own copy of each repo, so your checkout is never touched. Notes which tests already fail, so those don't count against it later.
2. **Plan:** first it checks the sources, then lists what's still unclear and makes a call on each one (or asks you, with `--ask`). Every call goes in `decisions.md` with the options and why. Then it writes a plan in small chunks, and a second AI reviews it until they agree.
3. **Build:** one chunk at a time. The agent codes, the pipeline runs the tests itself, the reviewer checks the diff, and the approved chunk becomes one commit.
4. **MR:** full tests and build, one last review of the whole ticket, a clean-up pass, then one MR per repo. The card moves to Code Review with the MR links and QA curls, plus a handoff note when another ticket builds on this one.
5. **After the MR:** with `agent watch` running, it fixes the reviewers's MR comments, answers QA on Jira and rebases on conflicts. When all MRs are merged, the card moves to Ready For Test.

### What it can't get around

- **It runs the tests itself.** An agent saying "tests pass" is never trusted. Only *new* failures count.
- **It can only write inside the ticket's own repo copies.** It can't touch `.env` files, commit, push, run migrations, or call `psql` or `curl`.
- **Commits happen only after review.** One approved chunk, one commit. Secret files are never committed.

## Setup (once per laptop)

```bash
git clone <this repo> ~/closio-agent && cd ~/closio-agent
npm install
npm link                                       # puts `agent` on your PATH
cp agent.local.example.yaml agent.local.yaml   # then set your repo paths
```

Create a `.env` in this folder:

```env
JIRA_EMAIL=you@company.com
JIRA_API_TOKEN=...        # id.atlassian.com → Security → API tokens
GITLAB_TOKEN=...          # GitLab → Preferences → Access tokens, scopes: api, read_user
DB_RO_URL_WS2TARGETSALES=postgres://readonly_user:...@host/db   # optional: lets the agent look at dev data
```

You also need `claude` logged in (and `codex`, only if you use a profile with a Codex reviewer), `brew install poppler` for PDF specs, and the VPN (see [VPN](#vpn)). Then check everything:

```bash
agent doctor
```

## Giving it sources

The agent reads the ticket and its Jira attachments by itself. Everything else, you point it to.

**Techspecs:** list them once in `agent.local.yaml`, newest first. Every run gets all of them:

```yaml
techspecs:
  - ~/specs/newest-spec.pdf
  - ~/specs/older-spec.pdf
```

When a new spec comes in, add it at the top. Runs pick it up from their next start. If two specs disagree, the newer one wins, unless the ticket or the merged code says otherwise. That order is only between specs, never over the ticket or the code.

A spec for just one ticket: attach it to the Jira card, or pass `--spec file.pdf` when starting the run.

**Figma:** connect the Figma MCP once, for your whole account:

```bash
claude mcp add --scope user --transport http figma https://mcp.figma.com/mcp
```

Then run `claude`, type `/mcp`, pick **figma** and log in in the browser. The agent then reads the screens linked in the ticket.

**Screenshots and CSS dumps:** no Figma? Put them in `runs/<KEY>/1-input/design/`. A `.claude/<number>/figma/` folder in the FE repo is picked up too. If a UI ticket has no design at all, the run pauses and tells you where to drop the files.

**Your own prompt or brief:** put it in `runs/<KEY>/1-input/brief.md`, or in `.claude/<number>/<number>-prompt.md` in the FE repo. Both the agent and the reviewer follow its technical guidance first.

**Anything else** (notes, extra screenshots): `agent run SCRUM-560 --context <folder>`.

**Repo notes:** if a repo has a `CLAUDE.md` or `AGENTS.md`, the agent reads it.

## Commands

```bash
agent sprint-plan                  # once per sprint, before anyone runs a ticket: how the sprint's tickets connect

agent run SCRUM-560                # start a ticket, or pick up where it stopped
agent run SCRUM-560 --ask          # you answer the planning questions yourself
agent run SCRUM-560 --simulate     # trial run on a real ticket: draft MR, nothing posted on Jira
agent run SCRUM-561 --base SCRUM-560   # force building on another ticket's branch (--base develop for none)

agent status                       # all your runs
agent status SCRUM-560             # one run: plan, commits, MRs
agent answer SCRUM-560 "Q1: follow the ticket, the spec is outdated"
agent watch                        # leave it running: QA questions, MR comments, conflicts, merges (see below)

agent feedback SCRUM-560 "reviewer says use the shared date util"
agent rebase SCRUM-560             # rebase onto develop now (makes a backup branch first)
agent impact SCRUM-560             # what this ticket affects: other tickets, missing work, spec
agent impact SCRUM-560 --post      # note it on the affected tickets, after you've read it
agent align SCRUM-561              # check against connected tickets (also runs before every MR)
agent sprint SCRUM-561             # show this sprint's map
agent session SCRUM-560            # open the agent's conversation yourself
agent sync SCRUM-560               # check for QA questions right now
```

If a run breaks (VPN drop, model limit), fix the cause and run the same command again. It carries on from where it stopped.

While it works, one line under the current step shows how long it's been going and what it's doing.

## When it needs you

Every question shows up in the terminal first:

- **A real blocker:** shows its recommendation. Press Enter to take it, or type your own answer.
- **Missing design:** drop the files in `runs/<KEY>/1-input/design/` and press Enter, or type `continue without design`.
- **A parent ticket with no branch yet:** type `build on <KEY>` or `develop`.

Type `later` to post the question on the Jira card instead. Under `agent watch` questions always go to Jira; answer with a comment on the card or with `agent answer`.

## `agent watch`: looking after open MRs

Run `agent watch` in a spare terminal and leave it open. It looks after every ticket that has an open MR:

- **Every 5 minutes:** checks Jira for QA questions and answers them on the card.
- **Every 10 minutes:** fixes new MR review comments, rebases if there are conflicts, picks up the lead's changes if they pushed to the branch, and resumes runs whose questions have been answered. Once all MRs are merged, it moves the card to Ready For Test.

These are the defaults. To check MRs more or less often for one session, use `agent watch --interval 20` (minutes). To change them for everyone, edit `JIRA_CHECK_MINUTES` and `WATCH_INTERVAL_MINUTES` at the top of `src/cli.ts`.

If the VPN is down, it connects it by itself (see [VPN](#vpn)). If that doesn't work, say the SSO login wasn't finished, it skips that round's MR checks and tries again next round. QA questions don't need the VPN, so those keep getting answered. While it's running, any new question goes to Jira instead of the terminal. Stop it with Ctrl+C.

## `--ask`: answer the planning questions yourself

Normally the agent makes its own calls on anything unclear and writes them down. With `--ask` it asks you first, one question at a time, before the plan is written:

```
Grill · SCRUM-561 · question 3 of 7

How do we stop two edits of the same config from overlapping periods?
  a) check for overlap in the service only
  b) service check + the existing exclusion constraint   ← recommended
  c) lock the row with SELECT … FOR UPDATE
Agent's reasoning: the check gives the spec's error code; the constraint catches the race.
Your answer [Enter = recommended · a/b/c · your own words · auto · auto all]:
```

- Enter takes the recommendation, a letter picks an option, anything else is your own answer.
- `auto` lets the agent decide this one, `auto all` the rest.
- If your answer opens a new question, it asks a follow-up. It stops after `limits.grill_rounds` rounds (default 3).
- The reviewer checks your answers too. If it disagrees, it shows you why and you keep yours, switch, or type a new one.
- Questions only the PM or tech lead can answer still go to them on Jira.

`decisions.md` marks each call as **Decided by: you** or **the agent**.

## `--simulate`: try it on a real ticket

Runs the whole pipeline but leaves the Jira card alone: no comments, no status changes, no tags. What it would have posted goes into `runs/<KEY>/would-post.md`.

- The branch is named `<key>-simulated` (then `-2`, `-3`), so it never touches the real developer's branch, and other tickets never build on it.
- MRs are drafts with no reviewers.
- Resuming the run, or `agent watch`, stays a simulation.

To turn a run that already has branches into a simulation, start fresh: `agent clean <KEY>`, delete `runs/<KEY>`, and run again with `--simulate`.

## Sprint plan and connected tickets

- **Sprint plan:** run `agent sprint-plan` once at the start of a sprint. It reads every ticket and writes a report: which ticket needs another's code, start order, FE/BE pairs, tickets that touch the same files, what to build reusably, and unclear tickets. Each ticket's run reads its own part.
- **Building on another ticket:** if your ticket needs another ticket's unmerged code (like Edit reusing Add's form), it starts on that ticket's branch, and the MR says which one to merge first.
- **Alignment check:** before every MR it compares the work with connected tickets (contracts, shared code) and fixes small mismatches.
- **Handoff notes:** only when an existing ticket builds on this one (like Edit on Add, or the other side of an API), it posts a short note on the Jira card: gotchas, the contract, where it differs from the ticket. Their runs read it, on any laptop. No such ticket, no note.

## QA questions

QA starts a Jira comment with `QA-Question:` (small variations work too). While the card is in Code Review or testing, `agent watch` checks every 5 minutes and replies on the card, tagging the QA, in one to three plain sentences: an answer, "that's expected", "that's a data issue", or "yes, that's a bug".

It never changes code from a QA comment. Real fixes come through the bug ticket.

## Protected files and deploy notes

- **Protected files:** list them per repo in `agent.config.yaml` under `protected:` (`**` for a whole folder). Any edit to them is undone. Existing migrations and seeders are always protected; new ones are fine. To allow one for a single ticket: `agent run <KEY> --allow-edit <path>`.
  ```yaml
  repos:
    ws1:
      protected:
        - src/middlewares/validateSchema.js
  ```
- **Deploy notes (BE only):** new env vars, new migrations or seeders, and deploy order across BE repos. Shown as one short "Deploy" line in the MR, and posted on Jira once merged.

## Choosing models

Profiles live in `agent.config.yaml` under `models.profiles`. The default, `quality`, is Claude Opus for every role.

```bash
agent run SCRUM-560 --profile cheap                    # for trying things out (reviewer is Codex)
agent run SCRUM-560 --set reviewer=claude:opus:high    # change one role
agent sprint-plan --set planner=claude:opus:high       # change the sprint planner
```

Set your own default in `agent.local.yaml` under `models.default_profile`.

## Tests it runs

Each repo lists its checks in `agent.config.yaml`: `focused` ones after every chunk, `final` ones before the MR.

- **Frontend:** related Vitest tests per chunk; the full suite and a Vite build at the end.
- **WS2:** eslint on changed files and mocha unit tests.
- **WS1:** eslint only, since it has no tests.

## Replays: checking it on old tickets

A replay rebuilds a ticket that's already merged, starting from the commit before it, and compares the result with what the developer merged: their tests run against the agent's code, files changed, review rounds and time. Replays never touch Jira or GitLab.

```bash
agent replay REPLAY-550 --repo ws2targetsales --base 60afea5 --reference b57cb4c \
  --ticket-file replays/SCRUM-550.md --context replays/SCRUM-550-files --profile cheap
```

## Where things live

| Path | What | Committed |
|---|---|---|
| `agent.config.yaml` | team config: repos, tests, Jira statuses, models | yes |
| `prompts/` | every prompt the agents get | yes |
| `agent.local.yaml`, `.env` | your paths and secrets | no |
| `runs/<KEY>/` | everything about one ticket | no |
| `sprints/` | sprint maps and the sprint plan | no |

One folder per ticket. Open its `README.md` first.

```
runs/SCRUM-561/
  README.md          where it stands, MR links, what to read first
  decisions.md       every call it made, with the options and why
  questions.md       what it asked, and what it's waiting on
  impact.md          what this ticket affects elsewhere
  handoff-note.md    the note connected tickets read
  1-input/           ticket, specs, design, connected tickets (put brief.md and design/ here)
  2-plan/            the plan and its reviews
  3-build/           one folder per chunk, then final/
  4-mr/              MR text per repo, deploy notes
  5-after-mr/        review feedback and rebases
  code/              the ticket's own copies of the repos
  .agent/            machine files: state, logs
```

## VPN

GitLab is behind the company VPN. Once this is set up, the agent connects by itself whenever GitLab can't be reached: it starts `openfortivpn`, opens the SSO login in your browser, and carries on. `agent watch` just skips a round instead of waiting.

Manual control: `agent vpn`, `agent vpn off`, `agent vpn status`. FortiClient still works, just don't run both at once.

One-time setup:

1. Install it:
   ```bash
   brew install openfortivpn
   ```
2. Let it run without a password prompt (only openfortivpn, and only stopping it):
   ```bash
   echo "#$(id -u) ALL=(root) NOPASSWD: /opt/homebrew/bin/openfortivpn *, /usr/bin/pkill -x openfortivpn" | sudo tee /etc/sudoers.d/closio-agent-vpn >/dev/null && sudo chmod 440 /etc/sudoers.d/closio-agent-vpn && sudo visudo -cf /etc/sudoers.d/closio-agent-vpn
   ```
3. Point GitLab lookups at the VPN's DNS:
   ```bash
   sudo mkdir -p /etc/resolver && printf "nameserver 10.90.0.53\nnameserver 10.190.0.55\n" | sudo tee /etc/resolver/jcvs.japfacomfeed.co.id
   ```
4. Copy the `vpn:` block from `agent.local.example.yaml` into `agent.local.yaml`, then run `agent doctor`.

