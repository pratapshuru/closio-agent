Before this work goes to human review, check that {{key}} is still aligned with its connected tickets. Things change while a ticket is being built: a backend ticket renames a field, a parent ticket gets review fixes, a sibling screen adds a shared helper, or a ticket's acceptance criteria are edited.

## Connected tickets (fresh full text)

{{related}}

The sprint map is listed in your rules if you need to look wider.

## Sprint plan advice

{{advice}}

## Parent branch news

{{parents}}

## This ticket's changes

{{diffs}}

## What to check

For each connected ticket, compare it with what this ticket built:

- **API contracts across FE and BE:** endpoint paths, methods, field names, types, error codes, response shapes.
- **Shared code:** components, utils, types, constants another ticket created or changed. Reuse them; don't keep a parallel copy.
- **Review lessons from the parent ticket:** if the lead asked the parent to change something that this ticket does the same way, apply it here too.
- **Behaviour:** acceptance criteria that were edited, or that now contradict this ticket.
- **Upcoming tickets:** is anything built in a way the next ticket can't reuse?

Then act:

- **`fixed`:** a clear, small mismatch with an obvious right answer. Fix it now in the worktree, without committing.
- **`noted`:** worth telling the reviewer, but not something to change here (for example the other ticket is the one that's wrong).
- **`needs_human`:** a real product or contract decision. Don't guess; describe the decision and your recommendation.

List every connected ticket you checked in `checked`. If everything is aligned, `issues` is empty and you change nothing. `commit_summary` describes any fix (e.g. "align field names with SCRUM-559 contract").
