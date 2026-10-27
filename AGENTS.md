# Ambry — project instructions

Ambry is a single-user pantry-inventory PWA: local-first, phone-primary (iPhone,
installed to home screen), no server, no accounts. `PLAN.md` is the authoritative
design document — read it before changing domain semantics. `ambry-planning-brief.md`
is the original brief behind it.

Inventory counts never expire. Never prompt, nag, badge, or queue the user to
recheck inventory because time has passed. Shelf reviews are entirely voluntary;
leaving one must never require resolving unchecked items.

## Team responsibilities

- `ambry-pm` manages scope, priorities, assignments, the task list, acceptance
  decisions and releases. Delegate application development to `ambry-dev`,
  including small fixes; do not implement it in the PM session.
- `ambry-dev` investigates bugs, implements application changes and runs the
  relevant technical checks.
- `ambry-ux` independently reviews usability, appearance and accessibility,
  reproduces problems and verifies fixes. Distinguish executed checks from
  checks that still need a physical device.

Use the existing Herdr agents. Coordinate shared files and browser sessions.
Bring in additional specialists only for a specific need beyond these roles.

## Shared language

Use plain, specific language that users and developers will understand the same
way. Avoid terms with competing everyday and technical meanings. When a technical
term is necessary, explain it on first use. This applies to app text, task lists,
documentation, and agent messages.

For example, say "inventory and storage tests," not "domain tests" (which can
sound like tests of a website address). Say "prepare the app files for publishing"
when explaining a production build, and distinguish that from publishing them.

## Commands

- `npm run dev` — Vite dev server
- `npm run build` — check TypeScript, prepare app files in `dist/`, and stamp the
  offline cache/update identifier; does not publish the app
- `npm test` — run the inventory and storage tests once with Vitest
- `npm run test:watch` — Vitest in watch mode
- `node scripts/check-git.mjs` — check new commits against `origin/main`,
  whitespace and tracked inventory exports
- `node --test scripts/check-git.test.mjs` — verify the Git safeguards
- `node scripts/check-git.mjs --message-file /tmp/message.txt` — check a
  proposed commit message before committing

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

- Keep each commit focused on one logical change. Separate unrelated fixes,
  documentation housekeeping and tooling when they can stand independently.
  Make useful checkpoint commits on the feature branch during longer work.
- Subject: imperative verb, at most 50 characters. Examples include Add, Fix,
  Remove, Update, Refactor, Release, Document, Keep and Group. Also accepted:
  Merge, Preserve, Record, Improve, Verify, Prevent, Reject, Allow, Clarify,
  Test, Configure, Enforce and Track. Explain why in the body and wrap lines
  at 72 characters.
- Inspect the staged diff and run the relevant checks before committing. Never
  include an unrelated working-tree change merely to make the checkout clean.
- Push a feature branch and open a pull request targeting `main`. PM manages
  review and merge; routine PR creation does not require another user approval.
  Independent UX review remains required for user-facing changes.
- Wait for the PR's repository, inventory/storage and app-preparation checks
  to pass on the current revision before merging. Use a merge commit to keep
  the branch history; do not squash unrelated logical changes together.
- Production publishing runs only from `main` after its checks pass. Verify
  published files, then create and push an annotated release tag at the exact
  published commit. Documentation/tooling-only changes need no app version bump.
- Never rewrite published commits or move release tags for cosmetic cleanup.
  Delete fully merged task branches after merge/release verification; retain
  unfinished work. Configure local `main` to track `origin/main`.
- Keep the shared task list in `TODO.md` and concise release/acceptance summaries
  in `docs/RELEASES.md`. Update the durable record after user acceptance; local
  temporary files must not be the only record of an unresolved issue or result.
- Never commit `node_modules/`, `dist/`, personal inventory exports, disposable
  browser profiles or raw user data. Keep synthetic evidence summaries concise.
