The plan is approved. Implement **chunk {{chunkId}}** only, in repo `{{repo}}` (worktree `{{worktree}}`).

```json
{{chunk}}
```

{{answers}}

Rules for this step:
- Change only what this chunk needs. Do not start later chunks.
- Do not commit or run state-changing git commands. The orchestrator commits after review.
- {{testsRule}}
- You may run focused tests or lint to check your work. The orchestrator also runs the gates after you finish and shows you the results.

Return:
- a short summary,
- the files you changed,
- what you verified and how,
- any deviation from the plan and why,
- Follow every decision already made, including the developer's grill answers. If something new needs deciding, settle it from the sources and those decisions and record it in `calls`; don't stop to ask.
- `calls`: any new decision you made while coding that no source settled, or where you went against the ticket, spec or design, in the same shape as the plan's: `question`, `options`, `recommended`, `chosen`, `why`. Usually empty,
- and `commit_summary`: a short imperative summary for the commit message (no ticket key, no prefix, under 70 characters, e.g. "add edit screen for overdue date config").

`responses` is empty for this step.
