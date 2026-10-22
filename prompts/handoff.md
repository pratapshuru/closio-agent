All chunks are committed and the final review passed. Write the handoff. A teammate opens this MR and should get it in 30 seconds.

**Tone:** write like a developer posting to their own team. First person, casual, short, specific. Full sentences, not telegraph style. No headings inside fields, no filler ("This MR aims to…"), no restating the ticket, no listing what the tests cover. If a field has nothing real to say, leave it empty (empty string or empty list). Never write "None".

Here is the bar. This example is for a different ticket, so copy its tone and length, not its content:

> mr_summary_md: "Adds the Edit screen for overdue date configs. It reuses the Add form, so both stay in sync, and adds the PUT call to the config API."
>
> decisions:
> - decision: "Kept the outlined BaseButton for Save instead of the filled one in Figma", why: "every other form in incentive uses outlined, and this looked like a design slip."
> - decision: "Left the end date optional, though the techspec says required", why: "the merged BE accepts null and the ticket doesn't mention it; easy to flip if the spec is right."
>
> risks_md: "" (nothing real to flag)
>
> testing_md: "Unit and component tests pass, build is green. Didn't click through it in a browser."

Commits:
{{commits}}

Final gates:
{{gates}}

Judgement calls made during this run without asking a human:
{{decisions}}

Unresolved reviewer disagreements (shown separately in the MR):
{{disagreements}}

Produce:
- `mr_summary_md`: what this MR does and why, in one to three plain sentences.
- `changes`: only what makes the ticket or spec wrong now, so the PM and QA know. These are:
  - behaviour that differs from the ticket (`ticket`);
  - differs from the spec (`spec`);
  - built beyond the ticket (`added`);
  - left out or deferred (`removed`);
  - an API, field, error code or shared component interface that changed (`contract`).

  `what` is what's different, in plain words, and `why` is half a line. How the code is organised never counts. Usually this list is empty. The bar, from a different ticket:
  > - kind: ticket, what: "End date is optional, not required", why: "the BE already accepts it empty and the ticket didn't say either way"
  > - kind: added, what: "Added a `service` field to the health response", why: "so the FE can tell services apart"
- `decisions`: don't repeat anything already in `changes`. Only the calls above that a teammate should take a second look at, merged where they overlap, at most 5. These are choices no source settled, or places I went against the ticket, spec or design. Following an existing pattern, reusing code, or leaving out what the ticket doesn't ask for are not decisions, so skip them. Each one has a short `decision` (what I did) and a one-line `why`. Empty list if nothing qualifies.
- `risks_md`: real risks or gaps QA or the lead must know, as short bullets. Empty string if there are none.
- `testing_md`: one sentence on what was verified. Claim only what the gate results above or your own successful runs show, and say what wasn't run.
- `review_guide`: one entry per changed file, in a sensible reading order. `what` is one or two plain sentences: what changed and why.
- `qa_curls`: {{curlRule}}
- `manual_checks`: concrete steps to click through, each one line. Empty if none are needed.
- `jira_summary`: two or three sentences for the Jira card.
- `next_tickets_md`: a short, lean handoff note for tickets that come later (an Edit after this Add, a FE ticket calling this BE endpoint). At most about 15 lines, facts only. Cover:
  - what this ticket built that others should reuse, and exactly where (components, functions, types, endpoints and their contract);
  - calls and their reasons;
  - gotchas;
  - review lessons;
  - what was deliberately left for upcoming tickets.
