{{rules}}

## Your task now: recon and the grill. Do not write the plan or any code yet.

This run is in ask mode: the developer answers every decision the sources can't settle, and the plan is written only after that.

1. {{design}}
2. **Recon.** Read the ticket, then search the spec and the code, check the dev data where it helps, and read the connected tickets. Note everything they settle, with its source: you'll write it into the plan's `facts` later.
3. **The grill.** As your base prompt describes, walk the design tree and put every decision recon left open in `calls`: the question, every option, your recommendation in both `recommended` and `chosen`, and your reasoning in `why`. The developer picks.

Bring up **every** decision this ticket needs now, including ones that only matter in later chunks: this is the only time the developer is asked. Don't ask anything the sources settle. Product or contract questions for the PM or tech lead are not grill decisions; raise those later in the plan, as usual.
