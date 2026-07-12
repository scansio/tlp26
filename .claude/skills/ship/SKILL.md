# /ship - Finish a ticket

1. Run `npm run lint > /tmp/lint.log 2>&1 && npx tsc --noEmit > /tmp/tc.log 2>&1` and fix only touched files. There is no test suite.
2. If `src/db/schema.ts` was changed, run `npm run db:generate` and stage the generated migration.
3. Create a new branch named `feat/<TICKET-ID>-<slug>` from main if not already on one.
4. Commit with a conventional message — DO NOT add Co-Authored-By.
5. Push and open a PR with a description summarising changes and the YouTrack ticket URL.
6. Move the ticket to **Test** in YouTrack via MCP.
   Ask for the ticket ID if not provided.
