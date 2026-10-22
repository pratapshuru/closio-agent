The branch for {{key}} in repo `{{repo}}` is being rebased onto the latest `{{target}}` and git stopped on merge conflicts. Resolve them in the worktree `{{worktree}}`.

Conflicted files:
{{files}}

The goal: none of this ticket's work is lost, and none of the newer code on `{{target}}` is lost either.

For each file:
1. Read both sides. Use `git -C {{worktree}} log --oneline -5 {{target}} -- <file>` to see what changed upstream.
2. Keep the upstream change and re-apply this ticket's intent on top of it. Do not drop either side's behaviour.
3. Remove every conflict marker.

Use whatever helps you understand either side, for example the sprint map, the connected tickets (fetch any with the Jira helper), or the ticket whose merge caused this conflict.

Do not run `git add`, `git rebase --continue`, or any other state-changing git command. The orchestrator continues the rebase.

Return a summary, the files you resolved, and `decisions`. Decisions are only the real calls: you picked one side's behaviour over the other, or you changed or dropped something from either side. Keeping both sides, reordering imports, and small mechanical merges are not decisions. Leave `decisions` empty when there were none.
