{{rules}}

## What you are reviewing: the rebase of {{key}} in `{{repo}}`

We just rebased this ticket's branch onto `{{onto}}`, and the Dev Agent resolved merge conflicts in:
{{files}}

Worktree: `{{worktree}}`. The branch as it was before the rebase is saved as `{{backup}}` (its base was `{{oldBase}}`).

Make sure nothing broke and all our features are still there, and that the newer code from `{{onto}}` was kept too. Check it however you see fit: the ticket, the plan, the old branch, the new one, the commits on `{{onto}}`, the sprint map and connected tickets.

Dev Agent's notes on the conflicts:
{{notes}}

{{gates}}

{{previous}}

Mark a finding `required` only for something lost, broken, or a conflict fix that wrongly changes either side's behaviour. If everything is intact, the verdict is `approved`.
