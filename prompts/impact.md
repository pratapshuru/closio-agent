Check whether what happened on {{key}} affects anything else. A senior dev does this before moving on, because these are exactly the things that get missed.

What changed from the ticket or spec:
{{changes}}

Gaps raised with the lead at planning (things this ticket needed from others):
{{gaps}}

Use the sprint map, the connected tickets (fetch any others with the Jira helper), the spec, and the code in every repo (`git -C <repo> grep <pattern> origin/<target>` reads GitLab's current copy). Check both FE and BE.

Report only what is really affected:
- `affected`: **other** tickets (never {{key}} itself) that now need a change in their text or code because of {{key}}. `note` says exactly what, in one plain line (e.g. "should show the new `service` field on the health card"). A ticket that needs no change is not affected: leave it out. For a gap: is it now covered by that ticket? If not, say so.
- `missing_work`: work this ticket's changes make necessary that no ticket covers yet (e.g. the FE needs to show a field the BE added, and no FE ticket mentions it). Not general improvements or tidy-ups you noticed along the way. Give a short `title`, the `repo`, and a two- or three-line `description` a lead could paste into a new ticket.
- `spec`: spec sections that are now wrong: `section`, what it says `now`, what it `should` say.
- `summary`: one or two plain sentences, like you'd say it to the lead. Empty if nothing is affected.

Leave a list empty rather than guessing. Write the way a developer talks to their team: short, specific, no filler. Do not change any files.
