{{rules}}

## What you are reviewing: {{what}}

Repo `{{repo}}`, worktree `{{worktree}}`. Review only the uncommitted changes: run `git -C {{worktree}} status --short` and `git -C {{worktree}} diff`. Use the rest of the repo, the plan and the ticket only as context. Keep findings grounded in this diff.

Chunk plan:
```json
{{chunk}}
```

Dev Agent's report:
```json
{{devReport}}
```

Gate results (run by the orchestrator, not by the Dev Agent):
{{gates}}

{{testsNote}}

{{previous}}
