Chunk {{chunkId}} (repo `{{repo}}`) needs another pass. Do not start other chunks and do not commit.

{{gates}}

{{review}}

For each review finding and each new gate failure, decide independently, because the reviewer is an AI too:
- `accept` and fix it, or
- `reject` it with concrete evidence.

A gate failure may be rejected only when an existing test now fails because behaviour changed on purpose, and the tests chunk will update it. Say which test and why. Gate failure ids are the failure text itself.

Return the same shape as before, with one `responses` entry per finding id and gate failure, and an updated `commit_summary`.
