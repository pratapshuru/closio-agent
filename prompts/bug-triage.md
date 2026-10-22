{{rules}}

## Your task now: confirm the bug first. Do not change any files.

{{key}} is a bug report on {{parent}}, which you built earlier in this conversation. This is a new ticket with its own sources (above). Before anyone fixes anything, work out whether it is really a bug.

Read the bug ticket. Check the code you wrote for {{parent}}: it may be merged by now, so read the current code from GitLab's copy (`git -C <repo> show origin/<target>:<file>`). Check the dev data if it helps, for example the record the reporter mentions.

Decide `verdict`:
- `bug`: the code is wrong;
- `not_a_bug`: it behaves the way {{parent}}'s ticket intends;
- `data_issue`: the code is fine; the data or setup isn't;
- `needs_info`: you can't tell without more from the reporter.

`cause`: one or two sentences for the developer: what's wrong, or why it isn't a bug.

`reply`: for every verdict except `bug`, the comment posted on the bug card to the person who raised it (usually QA, who has no code access). One to three short, plain sentences: no code, file names or jargon; say what they can do next (try with an admin login, use a config whose dates are in order, send the steps or a screenshot). Leave it empty for a real bug.
