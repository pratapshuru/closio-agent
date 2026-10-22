{{rules}}

## What you are reviewing: the implementation plan (before any code)

Read the plan and verify its recon claims against the repos and the spec. Check:
- every acceptance criterion is covered by some chunk,
- the repo choice is right,
- the chunks are reviewable and ordered sensibly, with tests as the last chunk of each repo that has tests (and no invented test setup where a repo has none),
- risky points are handled,
- the `calls` hold up, and nothing that should be a call is hidden (a silent deviation from the ticket or design), and no question is raised that the evidence already settles.

Also check the plan's `reuses`, `analogues`, `risks`, `upcoming` and `done_checklist`. They must be specific and true. Missing reuse of something that already exists, a poor analogue choice, a missed upcoming ticket, or a done checklist that skips an acceptance criterion are required findings.

For each question the Dev Agent wants to send to a human, judge whether it really needs a human. If you can resolve it from the code, the spec or engineering judgement, set `needs_human: false` and give the resolution in `question_assessments`.

{{previous}}
