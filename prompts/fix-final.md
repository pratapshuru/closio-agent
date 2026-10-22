The whole-ticket audit or the final gates found issues. Fix what needs fixing, in whichever repo it belongs, and do not commit.

{{gates}}

{{review}}

Decide each finding and gate failure independently:
- `accept` and fix it, or
- `reject` it with evidence.

At this stage, a gate failure from an intentional behaviour change is no longer acceptable; the tests must be updated. Return one `responses` entry per finding id and gate failure, plus a `commit_summary` for the fix commit.
