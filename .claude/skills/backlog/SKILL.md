# /backlog - Pull tickets from Backlog and ship them

Fetch `<number>` ready-to-build tickets from the TLP project Backlog and pass
them to the `/tickets` skill for parallel execution.

Usage: `/backlog <number>`
Example: `/backlog 5`

## Steps

1. **Parse** — Read the number argument. Default to `5` if not provided.

2. **Fetch** — Use `search_issues` via MCP to query the TLP project backlog,
   ordered by priority descending:

   ```
   project: TLP Stage: Backlog order by: Priority desc
   ```

   Fetch `<number> × 2` results (buffer for filtering). Use `get_issue` on
   each to collect their `depends on` links.

3. **Filter — ready tickets only** — A ticket is ready if ALL of its
   `depends on` targets are in stage **Done** or **Test** (i.e. not still
   Backlog / Develop / Review). Drop any ticket where a blocker is unfinished.

4. **Select** — Take the first `<number>` ready tickets after filtering,
   preserving priority order:
   `Show-stopper → Critical → Major → Normal → Minor`

5. **Confirm** — Print the selected tickets before starting:

   ```
   Pulling <n> tickets from TLP Backlog:
     TLP-X  [Critical]  <summary>
     TLP-Y  [Major]     <summary>
     ...
   ```

   If fewer ready tickets exist than requested, say so and proceed with what
   is available.

6. **Hand off** — Invoke the `/tickets` skill with the selected IDs:

   ```
   /tickets TLP-X TLP-Y TLP-Z ...
   ```

   The `/tickets` skill handles dependency ordering, wave planning, and
   parallel agent spawning from this point.
