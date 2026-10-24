All chunks are committed and the final review passed. Write the write-up: what's different from the ticket, the QA curls, and the handoff note (only if a ticket below builds on this one). The program builds the MR from the decisions log and these fields, so keep every field short.

**Tone:** write like a developer posting to their own team. Plain words, short, specific, full sentences. No jargon, no filler, no restating the ticket. If a field has nothing real to say, leave it empty (empty string or empty list). Never write "None".

Commits:
{{commits}}

Final gates:
{{gates}}

Decisions made during this run:
{{decisions}}

Produce:
- `changes`: only what makes the ticket or spec wrong now, so the PM and QA know. These are:
  - behaviour that differs from the ticket (`ticket`);
  - differs from the spec (`spec`);
  - built beyond the ticket (`added`);
  - left out or deferred (`removed`);
  - an API, field, error code or shared component interface that changed (`contract`).

  `what` is what's different, in plain words, and `why` is one plain sentence. How the code is organised never counts, and neither does not doing something the ticket didn't ask for. If a difference also goes against a connected ticket, name that ticket's key in `what` or `why`. Usually this list is empty. The bar, from a different ticket:
  > - kind: ticket, what: "End date is optional, not required", why: "the BE already accepts it empty and the ticket didn't say either way"
  > - kind: added, what: "Added a `service` field to the health response", why: "so the FE can tell services apart"
- `qa_curls`: {{curlRule}}
- `handoff_note`: {{handoffFor}} When written, it's posted on the Jira card, where their runs read it. Only what those tickets can't learn from the code or their own ticket: where this ticket differs from the ticket or spec, gotchas, the contract the other side must match, and review lessons. Never file paths, column lists or a summary of what was built. At most 5 bullets, one line each. If there's nothing like that, leave it empty.
