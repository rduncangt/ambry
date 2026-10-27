# Ambry — task list

Current app: **1.0.2**, published from `edd97a2` on 2026-10-26.
The v1 milestone is complete. No confirmed unresolved app defect remains from
current review. Release evidence and limitations are in [docs/RELEASES.md](docs/RELEASES.md).
[PLAN.md](PLAN.md) remains the authoritative product design.

## Repository practices

- [x] Preserve this shared task list and release summaries in Git.
- [x] Remove obsolete project instruction references.
- [x] Extend ignore rules to current inventory-file names.
- [x] Add PR/feature-branch checks for commit hygiene, accidental exports,
      inventory/storage tests and app-file preparation. All 11 safeguard tests
      and four additional independent repository cases passed locally.
      Require a passing hosted PR check before merging.
- [ ] Enable GitHub protection for `main`: require a PR and passing checks;
      block force-push/deletion. No mandatory second-human approval for this
      single-owner repository. Independent agent review is still required.
      Required check: `Validate changes`; require branches up to date and apply
      to administrators too. Leave force-push and deletion disabled. Configure
      under [GitHub branch settings](https://github.com/rduncangt/ambry/settings/branches).
      Pending: the connected GitHub tools cannot change repository settings.
- [x] Remove 13 fully merged local task branches and the merged remote
      stabilization branch; configure local `main` to track `origin/main`.
      Future changes use the checked PR workflow in `AGENTS.md`.

## Usability improvements to review

- [ ] Consider keeping New item's title and Close control visible while its long
      form scrolls. The existing control is reachable; this is a convenience idea.
- [ ] Simplify technical wording in unit changes, damaged-file errors and the
      action currently called “Prune now.”

## Verification follow-ups

- [ ] Test VoiceOver labels, reading order, modal isolation and focus return on
      a physical iPhone before claiming screen-reader support. This was explicitly
      untested and accepted as a follow-up for the personal-use v1 release.
- [ ] Repeat a complete physical-iPhone restore after changes to storage or the
      inventory file format. Current acceptance combines the earlier iPhone
      recovery drill, recent desktop restore and current iPhone save/read checks.

## Optional features — not commitments

- [ ] Read-only desktop inventory-file viewer.
- [ ] Optional expiring-soon indicators/filter and an out-of-stock-only filter.
- [ ] Barcode scanning.
- [ ] Seasonal item archiving, if useful.
- [ ] Richer history and search that tolerates misspellings.
- [ ] Sync or combining imported inventories; these require revisiting the
      single-device design before implementation.

## Maintenance

- [ ] Review publishing-action deprecation warnings and update pinned actions
      where warranted, checking current official documentation first.

## Recently completed

- [x] 1.0.2: place Search/Clear/Create directly above results, with no large blank
      gap. Independent browser checks and the user's actual iPhone acceptance
      passed. Close the reported search layout issue.
- [x] 1.0.0: complete scoped v1 acceptance and publish the first stable release.
- [x] Remove temporary text-editing diagnostics. The earlier caret issue is no
      longer reproducible in ordinary iPhone use; its cause remains unknown.
- [x] Full existing/custom unit and optional package selection before item save.
- [x] Block hidden background checkout while item details are open.
- [x] Reject invalid numeric creation drafts instead of silently saving 1.
- [x] Search clear control, explicit staged checkout, stable inventory filename,
      voluntary shelf tools and removal of timed stock-review prompts.

Dev implements and tests; UX independently reviews; PM owns scope, acceptance,
records and releases. Optional features do not reopen the completed v1 milestone.
