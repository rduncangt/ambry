# Ambry — instructions for Claude / agents

Ambry is a single-user pantry-inventory PWA: local-first, phone-primary (iPhone,
installed to home screen), no server, no accounts. `PLAN.md` is the authoritative
design document — read it before changing domain semantics. `ambry-planning-brief.md`
is the original brief behind it.

Inventory counts never expire. Never prompt, nag, badge, or queue the user to
recheck inventory because time has passed. Shelf reviews are entirely voluntary;
leaving one must never require resolving unchecked items.

## Commands

- `npm run dev` — Vite dev server
- `npm run build` — type-check (`tsc --noEmit`) + production build to `dist/`
- `npm test` — Vitest, single run
- `npm run test:watch` — Vitest in watch mode

## Architecture rules (violating these is a bug, not a style choice)

1. **One chokepoint.** Every data mutation goes through the command functions in
   `src/store/`. UI components never write to storage or construct events themselves.
   The command updates the item, appends its history event, evaluates flag
   transitions, and stamps timestamps — atomically, in one saved document.
2. **Current state lives on the item; events are self-contained observations.**
   Items never derive state from events; no event references another event. Any
   event must be prunable without breaking anything.
3. **Storage is one versioned JSON document** (`schema_version` at top) behind the
   adapter in `src/store/adapter.ts`. Migrations are ordered pure functions; import
   runs the same migration pipeline as load. Never delete a migration function.
4. Timestamps are ISO-8601 UTC strings. Expiry is a plain `YYYY-MM-DD` string,
   never a timestamp. IDs come from `crypto.randomUUID()`.
5. Soft deletes only (`deleted_at`); exports are full-fidelity (tombstones, events,
   settings included).
6. Domain logic lives in pure modules under `src/domain/` with Vitest coverage.
   UI (`src/ui/`) stays thin and untested; tests are for the code that guards data.
7. Runtime dependencies: Preact. Adding any other runtime dependency needs an
   explicit, stated justification.

## Git conventions

- Subject line: imperative verb (Add/Remove/Update/Refactor/Fix), ≤50 chars.
- Body: detailed, explains *why*, wrapped at 72.
- Milestone branches (`m0-rails`, `m1-aisle`, …) merged to `main` with `--no-ff`.
- Never commit `node_modules/` or `dist/`.
