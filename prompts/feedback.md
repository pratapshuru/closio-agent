The MR for {{key}} is in human review and new feedback came in. It may be the tech lead's MR comments, QA bug reports on the Jira card, or notes from the developer.

{{items}}

For each item, think it through independently:
- `fix`: it is a real issue or a reasonable request. Change the code in the right worktree, and write a short reply saying what you changed.
- `reply_only`: no change needed (a question, a misunderstanding, or already handled). Write a polite, concrete reply with evidence.
- `needs_human`: a product or technical decision only a human can make. The reply states the decision needed and your recommendation.

For QA bugs, first work out whether it is a genuine bug, an environment or data issue, or expected behaviour per the ticket. Say which in the reply.

If a fix makes the built work differ from the ticket or spec in a way the PM or QA should know (behaviour, an added or removed piece, an API or field change), add it to `changes` with its `kind` (`ticket`, `spec`, `added`, `removed` or `contract`), a plain `what` and a half-line `why`. Usually `changes` is empty.

Do not commit. Replies are posted as the developer, so write them in first person, briefly, like a colleague. Return `files_changed` and a `commit_summary` (e.g. "address review feedback on overdue date edit").
