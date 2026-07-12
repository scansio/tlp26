---
name: tickets
description: Spawn parallel ticket-to-pr agents with automatic dependency ordering across waves.
---

# /tickets - Batch Ticket Processor

Use this skill to spawn parallel sub-agents for multiple tickets with automatic dependency ordering.

## Steps

1. **Parse Input** — Accept a list of ticket IDs (e.g., `DFD-34 DFD-35 DFD-36`).

2. **Fetch** — Call `get_issue` via MCP for every ticket in the list concurrently.
   Collect each ticket's "depends on" links.

3. **Analyse** — Filter links to only those where _both_ the blocker and the dependent
   are in the input list. Build a DAG and topologically sort into sequential waves.
   Flag any cycles as an error before proceeding.

4. **Plan** — Print the execution plan before starting any agents:

   ```text
   Wave 1 (parallel): TLP-1, TLP-3
   Wave 2 (parallel): TLP-2   ← depends on TLP-1
   ```

5. **Execute** — For each wave in order:
   - Before spawning an agent for a ticket, use the GitHub tool to check if a merged PR already exists for it (search by ticket ID in title). If found, mark the ticket done and skip spawning — the agent's own resume protocol handles all other in-progress states (open PR, existing branch, uncommitted work).
   - Spawn one `ticket-to-pr` agent per ticket that still needs work:
     `Agent(subagent_type="ticket-to-pr", prompt="$TICKET_ID")`
   - Wait for **all** agents in the wave to finish (PR merged + ticket in Test)
     before starting the next wave.

6. **Monitor** — Maintain a live status table across all waves:

   | Ticket | Wave | Agent Status | Worktree Path |
   | ------ | ---- | ------------ | ------------- |
   | ...    | ...  | ...          | ...           |
