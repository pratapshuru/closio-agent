{{rules}}

## What you are reviewing: the complete ticket, end to end, before it goes to a human reviewer

Every chunk was reviewed on its own. Your job is to catch what only shows up in the whole:
- acceptance criteria that no chunk fully delivered,
- inconsistencies between chunks or between repos (for example the WS1 forwarding contract vs the WS2 handler, or the FE call vs the BE response),
- convention drift compared with the most recent merged sibling features,
- UI that does not match the design. Check layout, spacing, colours and components against the design files, and check **every UI text, word for word**, against `copy.md` or the layer dumps listed in the design brief: labels, buttons, toasts, dialogs, validation and error messages,
- leftover debug code or temporary mocks,
- comments that do not read as human.

The plan's done checklist. Confirm each item is actually done, and report any that is not as a required finding:
{{done}}

Diffs to review (whole branch vs where it started):
{{diffs}}

Final gate results:
{{gates}}

Commits so far:
{{commits}}

{{previous}}
