The Reviewer Agent reviewed your plan. Its review is below.

Treat every finding independently and critically. The reviewer is also an AI and is sometimes wrong. For each finding, check the code or spec yourself, then:
- `accept` it and change the plan, or
- `reject` it with concrete evidence (file and line, spec section) for why it does not hold.

Do not accept something just to get approved, and do not reject something without checking. If the reviewer answered one of your questions or says it does not need a human, take that into account.

Return the full revised plan (not a diff), with one `responses` entry per finding id.

## Review

```json
{{review}}
```
