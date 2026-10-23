{{rules}}

## Your task now: recon and plan. Do not write code.

1. Decide what kind of work this ticket is, using the types in your base prompt. Start `plan_markdown` with `Type: …` and cover every section those types need. {{design}}
2. Read the ticket, then search the spec and the code. Work out:
   - what is being asked,
   - what already exists and can be reused,
   - what is genuinely new,
   - where the risky integration points are,
   - and, for backend contracts, which parts you verified in code and which rest on the spec alone.
3. Find the connected tickets in the sprint map: the same feature, the same epic, the other side of the API (FE ↔ BE), tickets touching the same code, and upcoming tickets that will build on this one. Read their full text (fetch any that are missing). List them in `related_tickets`, each with why it matters. Use them in the plan: contracts to match, components to reuse, things to build in a reusable way.
   Then decide **dependencies**: does this ticket need another ticket's code that is not merged into the target branch yet (for example a shared component that ticket creates)? If so, add one entry per repo to `dependencies` with the reason. Only list a real code dependency. If you only need an API contract, write against the contract from the ticket or spec instead. If the other ticket is already merged, it is not a dependency.
   Then look for **gaps**: problems **between this ticket and another ticket or the spec**, which only the lead can sort out across tickets:
   - this ticket needs something another ticket or the spec should provide, and it isn't there (e.g. the FE needs an object in the response that the spec has but the BE ticket doesn't);
   - two tickets, or a ticket and the spec, contradict each other;
   - two tickets plan to build the same thing, or this ticket needs something only planned for a later one.
   This ticket's own unclear or missing details (no acceptance criteria, an unstated colour, what happens when a list is empty) are **not** gaps: settle them in the grill, as decisions.
   Add each to `gaps`: `ticket` (the other ticket's key, or "spec"; never this ticket), `what` (one or two plain sentences, first person, like a message to the lead), `assumption` (what you'll build on meanwhile), `alternative` (a fallback if the lead says no, or ""). Then keep planning on that assumption. Only a gap where guessing wrong means throwing the work away becomes a blocking question instead. Leave `gaps` empty when everything lines up, which is the usual case.
4. Decide which repos this ticket touches. The candidate repos were guessed from the ticket and may be wrong; add or drop repos with a reason. Backend tickets usually need the WS1 gateway plus one WS2 service.
5. Recon, then grill yourself, as your base prompt describes. What the sources settle goes in `facts` with its source. Every decision still open after recon is one entry in `calls`: the question, every option, the recommended one, what you chose and why. Real blockers go in `questions`. {{grillMode}}
6. Split the work into reviewable chunks. Each chunk is one atomic commit in exactly one repo, small enough to review in one sitting, and ordered so each builds on the last. Put contract-owning work first (WS2 before WS1, backend before frontend in a combined ticket) unless there is a reason not to. If a repo or area already has tests, put its tests chunk last for that repo; if it has none, follow that convention and add no tests chunk there.
7. Raise a question only for an extreme blocker (see the rules). Most tickets need none. Mark it `blocking` when a chunk cannot be built correctly without the answer. Everything else is a call.

Also answer the developer's usual questions explicitly, in the plan fields:
- `reuses`: what earlier tickets or existing code already built that this ticket uses (exact components, functions, types, and where they are), so nothing gets rebuilt.
- `analogues`: the closest existing files to mirror, and why. When two analogues disagree (for example one shares a form between Add and Edit and another doesn't), pick one deliberately and justify it against this ticket and upcoming tickets, not against which file is newer.
- `risks`: the easy-to-miss, high-impact points (the "money bugs").
- `upcoming`: tickets that will build on this one (from the sprint map, sprint advice or epic) and what they need from it, so it is built reusably now. Say what you are deliberately not abstracting yet.
- `done_checklist`: concrete checks that prove this ticket is done: each acceptance criterion, key states and edge cases, and existing flows that must still work.

`plan_markdown` is the full plan a human would read: the `Type:` line and the sections it requires, approach and why, files and areas to change, what is reused vs extended, how existing behaviour is protected, chunks, risks, out of scope. Use plain language. `responses` is empty on the first plan.
