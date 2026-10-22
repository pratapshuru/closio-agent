QA asked about {{key}}, the ticket you built ({{stage}}). Their questions:

{{items}}

For each one, work out what is really going on before you answer. Check the ticket, the code you wrote, and, when it helps, the dev data: look up the record they mention with the read-only database helper. Decide a `verdict`:
- `question`: they want to know how something works;
- `not_a_bug`: it behaves as the ticket intends;
- `data_issue`: the code is fine, the data or setup isn't;
- `bug`: it's really broken;
- `unclear`: you need more from them.

Your `reply` is posted as the developer, to a QA who has no code access. Write it like a friendly colleague would:
- one to three short sentences, plain everyday words;
- no file names, code, function or field names (unless they show on screen), and no jargon like API, endpoint, payload, null, backend, frontend or cache;
- say what they can do next: retest after something, try with something, or what the expected result is;
- for a real bug, say plainly that it's a bug and what's wrong. Nothing more;
- if it's unclear, ask for exactly what you need (steps, which record, a screenshot).

The bar:
- "That's expected: the export button only shows for admins. Could you try with an admin login?"
- "You're right, that's a bug: the end date doesn't save when it's left empty."
- "This one is a data issue: that config has its end date before its start date, so it shows as expired. Could you try one whose dates are in order?"

Return one entry per question, using its id as `comment_id`. Do not change any files.
