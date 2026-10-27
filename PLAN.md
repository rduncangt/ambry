# Ambry v1 — Build Plan

*2026-08-27. Inputs: `ambry-planning-brief.md` plus three clarifications: the **phone is the
device of record** (mobile-first UI, laptop occasional); the phone is an **iPhone**; **no
stack preference**. Produced from three independent plans (friction-first, integrity-first,
longevity-first) plus a red-team pass over the brief; every disagreement below survived
adversarial verification against the brief's text and the iOS platform facts.*

---

## 0. Summary

The brief's decisions are almost all sound, and none of them gets overturned here. What the
review found instead is a consistent pattern: **five of your decisions are correct but
missing their second half** — the flag that clears on purchase has no purchase event; the
"display-mode" ladder has no defined write direction; the mutable unit also denominates the
threshold and the history; the "not separately stored" shopping list contains entries that
must be stored; and "export and import" is one line of scope carrying the entire durability
story of an app whose platform (iPhone browser storage) actively deletes data. The plan
below incorporates the fixes; §1 argues each one.

The permanent URL is decided: **`ambry.sciomedes.com`** (§6.1). Browser storage and
the home-screen install are keyed to that origin; keep it stable across releases.

### v1 release scope (revised 2026-10-11)

The user authorized the project manager, developer and UX reviewer to execute the
stabilization recommendations. V1 covers the existing phone-first pantry, search,
quantity editing, shopping/cart/checkout, inventory files, recovery, history,
organization and optional shelf tools. Counts never expire and no completed pantry
audit or minimum item count is required for release.

The release pass fixes recovery-screen update access, truthful snapshot saves,
retryable restore file-read errors, removal/undo of unwanted shopping extras, and
accessible modal sheets. Inventory and storage tests, app packaging checks, and
independent UX review must pass;
device-only iPhone/iCloud/VoiceOver checks must be identified honestly rather than
described as passed by a desktop browser simulation.

**Explicitly deferred after v1:** a read-only desktop inventory-file viewer, expiry
badges/expiring-soon filtering, and an Out-only filter. The existing optional expiry
field and visible zero/Out quantities remain. These are future enhancements, not
unfulfilled v1 release requirements. Barcode scanning, sync, seasonal archival and
richer history also remain outside v1.

The app can move directly from 0.11.x to 1.0.0 once acceptance is complete. The app
version and `schema_version` are separate: a release number alone never requires a
data migration or changes to the user's saved inventory.

### v1 acceptance decision (2026-10-26)

PM, dev and independent UX review accept the existing app for the personal-use
1.0.0 release. No confirmed unresolved defect remains from the reviewed flows.
This is a release-number change, with no inventory schema migration.

- All 682 inventory and storage tests passed on the accepted 0.12.5 code;
  app-file preparation and independent browser checks passed.
- The user confirmed actual installed-iPhone editing, ordinary updates preserving
  inventory, same-file replacement and readable restore preview, full-close
  offline reopening, Close with the keyboard open, and child-dialog Close/Back.
- A controlled pending save survived an actual browser update restart exactly
  once. Injected save failure and conflict blocked restart; retry after the save
  failure succeeded. These were real worker transitions with controlled test
  conditions, not claims of real device storage exhaustion.
- Restore acceptance combines the historical completed iPhone recovery drill,
  recent completed desktop restore, unchanged restore/storage code since that
  desktop check, and current iPhone file replacement/readable preview. A complete
  restore was not repeated on the current iPhone release; reassess after changes
  to storage or the file format.
- VoiceOver remains untested and is an explicit accessibility follow-up, not a
  claimed pass or certification. PM accepts that limit for this personal-use
  release; the keyboard microphone is dictation, not VoiceOver evidence.

The earlier iPhone cursor report is no longer reproducible in normal use. Its
cause remains unknown; no specific app fix or phone cause is claimed. Temporary
diagnostic code and its visible entry were removed in 0.12.5. Optional feature
ideas remain deferred and do not expand the release scope.

---

## 1. Where I disagree with the brief

You asked to hear this now rather than in month two. In severity order. The data model and
build order in §2–§4 already incorporate every fix here.

### 1.1 "Export and import" is one line of scope doing the work of a durability system — HIGH

The brief is right that export is the only backup and "isn't optional." But on the actual
device of record, the unhandled cases are *total-loss* cases, and there are two distinct
ones:

- **ITP eviction.** Safari deletes ALL script-writable storage (localStorage *and*
  IndexedDB — the storage-tech choice changes nothing) for a non-installed web app after
  ~7 days of Safari use without visiting it. A casually-used pantry app will hit this. An
  installed home-screen app is exempt — but iOS has no install-prompt API, so install can
  only be detected and nagged for, never enforced.
- **Device loss/upgrade.** Even a perfectly installed PWA has no documented storage
  migration to a new iPhone, and a backup file sitting in on-device Downloads dies with
  the phone.

One silent total-loss event is your drift failure mode at its maximum: trust never
recovers and the project dies. So the following are **v1 core scope in the first usable
milestone**, not polish:

1. Install-to-home-screen onboarding that states the real reason ("Safari deletes
   uninstalled web-app data after ~7 days of disuse") and nags until standalone mode is
   detected.
2. `navigator.storage.persist()` at startup — best-effort only; Apple does not promise it
   prevents eviction.
3. A "backup is N days old" indicator driven by `last_export_at` + `writes_since_export`,
   with one-tap export.
4. Export through the **Web Share API share sheet** so the default destinations are
   off-device (iCloud Drive, AirDrop) — never a bare `<a download>`, which has a history
   of silent failure in standalone iOS web apps.
5. Export is **full fidelity**: soft-delete tombstones, event history, settings, UUIDs,
   timestamps. A backup that omits tombstones silently destroys the retrofit insurance
   you're paying for.
6. The accepted loss window, in writing: *data since the last export is unprotected; the
   nag threshold bounds that window.* That makes the residual risk a decision instead of
   an accident.

### 1.2 The sticky flag's clearing condition references an event the model never captures — forced fix

"Stays up until I actually buy the thing, not when the number ticks back up" defines
clearing by an event — *purchase* — that exists nowhere in a model whose history is bare
quantity changes, and quantity increase is explicitly disqualified as the signal. As
written, the resupply model is unimplementable; you'd have hit this in week one. The fix
is small and keeps the shopping-list-as-view decision intact:

- **Checkout IS the purchase gesture (revised 2026-09-26).** The shopping cart icon
  stages an item without changing pantry stock. A separate **Check out** action books
  every staged item together: writes `purchase` events, clears their flags, and adds
  the chosen amounts. Walking the aisles must not claim the groceries are home already.
- **Events carry a `kind`** (`purchase` / `use` / `recount` / …), inferred from the
  gesture — you are never asked to classify. A few bytes per event; a migration later
  otherwise.
- **The latch is edge-triggered**: the flag auto-raises only on a *downward crossing*
  (before > threshold ≥ after), never from level evaluation. Otherwise "flag butter at 1
  stick," buy back to exactly 1, re-raises instantly.
- **A one-tap manual clear** ("have plenty") for the two flag paths that never end in a
  purchase: raised in error, or raised for a party that got cancelled. Without it those
  flags are permanent by construction and the shopping view accretes exactly the ignored
  nags `never_prompt` was invented to prevent.

### 1.3 The phone/laptop split is a silent multi-week data-loss path — MEDIUM

"Runs on both my phone and my laptop" plus "single device, local storage only" was never
reconciled, and import semantics were never defined. The moment the laptop is seeded via
import it becomes a second, independent, immediately-stale database; importing any file
older than local state silently reverts edits; and merge-on-import is exactly the sync
work v1 excludes. Three explicit rules, stated in the plan so future-you doesn't casually
seed the laptop:

1. **The phone is the only routine write device in v1.**
2. **Import is whole-file REPLACE, never merge.** Before replacing: compare the file's max
   `updated_at` against the local store's; refuse with a loud override when the file is
   older. Auto-snapshot the current data first.
3. **The read-only laptop file viewer is deferred after v1 (2026-10-11).** V1
   does not offer a separate viewer and must not imply that it does. A laptop
   import creates an independent editable pantry; it never synchronizes with the
   phone. An intentional transfer requires import → edit → export → guarded
   replace-import on the phone before further phone edits.

### 1.4 v1 scope omits duplicate prevention while naming duplicates as how the inventory rots — MEDIUM

The hard-parts section demands the plan address near-duplicates; the frozen feature list
contains nothing that does. Search-and-filter doesn't cover it, because duplicates are
born in the post-shop entry window when nobody searches first — and soft delete makes it
worse: re-creating "paprika" six months after deleting it mints a new UUID, orphans the
history, and leaves a colliding tombstone. The fix is one named v1 feature, about a day of
work, blessed by your own Scale section:

- **Creation IS search.** The add flow is the search flow; "Create '⟨typed⟩'" is the
  fallback row beneath the matches. Matching is normalized (case-fold, strip punctuation,
  sort tokens, naive plurals) over names + aliases **including soft-deleted items** —
  tapping a live match opens it, tapping a tombstone *restores* it (same UUID, history
  intact). "Create new anyway" stays one tap, so no friction is added when there's no match.

### 1.5 Unit coherence is under-scoped: three other things share the mutable unit — MEDIUM

The brief's unit-coherence hard part implicitly covers the quantity field, but the
**threshold**, every **history event**, and (via package size) the meaning of all of the
above are denominated in the same mutable unit. Change flour from "bag" to "g" without
converting the threshold and "flag at 1" becomes "flag at 1 g" — auto-raise goes
permanently dead or permanently on, silently, and the sticky design never self-corrects.
Edit "1 bag = 1 kg" to "1 bag = 2 kg" and every stored number changes meaning with no
record. So:

- **Unit and package-size change is a guarded migration flow, never a bare field edit**:
  convert quantity AND threshold together when package size gives a conversion; force
  re-entry of both when it doesn't; for package-size edits ask "keep amount or keep
  count?"; write a `unit_change` event either way.
- **Every event snapshots the unit it was recorded in** at write time, so history stays
  self-describing forever.
- Stated limitation, chosen not discovered: one package size per item cannot represent a
  500 g and a 1 kg bag of the same flour held simultaneously. Deliberate approximation.

### 1.6 "Not separately stored state" is unimplementable for ad-hoc entries — MEDIUM

A view can only derive from stored state, and "birthday candles" derives from nothing.
iOS will kill the page between aisle 3 and aisle 7, so anything not persisted at write
time doesn't survive a shopping trip, let alone the week between typing and shopping. The
principle survives restated as **"no duplicated ITEM state"**: list membership for
inventory items stays purely derived from the flag; ad-hoc entries get their own minimal
record type (UUID, text, timestamps, soft delete — your own retrofit shape). A cart tap
stages the entry; checkout soft-deletes it and offers "add to pantry?" so one-off buys
can graduate instead of being retyped as near-duplicates later.

### 1.7 The ladder's write direction destroys multi-container quantities — MEDIUM

Rung values are fractions of ONE container. Tap "Low" on an item holding 3 bags — or the
everyday case of an open bottle plus an unopened backup (1.5) — and 0.2 overwrites a
multi-container count. The victims are exactly the spice-and-condiment items the feature
exists for. Also: *which* items use the ladder is per-item stored state, and no such field
is in the brief's field list. Fixes, all preserving the single-number model: an explicit
`display_mode` field; quantity ≥ 1 renders as "Full +N"; a rung tap when quantity > 1
asks for confirmation instead of writing silently; and for ladder items the threshold is
*picked as a rung* in the UI (stored as its numeric value, default 0.25 so "Low" = 0.2
crosses it).

---

## 2. Data model

Three design rules everything hangs on:

> **R1 — One chokepoint.** Every mutation goes through a single persistence-layer command.
> The command atomically updates the item, appends its history event, evaluates flag
> transitions, and stamps timestamps. The UI cannot forget to log, and the future sync
> queue has exactly one place to hang. (Your retrofit-insurance decision, made load-bearing.)
>
> **R2 — Current state lives on the item; events are self-contained observations nothing
> references.** Items never derive state from events; no event references another. Any
> event can be pruned and nothing breaks — this is what makes retention, merges, and unit
> edits provably unable to corrupt current state.
>
> **R3 — Storage is one versioned document.** `schema_version` at the top, migrations are
> ordered pure functions, and **import runs the same migration pipeline as load** — so a
> 2026 export imports cleanly into the 2030 app.

All IDs `crypto.randomUUID()`. All timestamps ISO-8601 UTC strings, rendered local.
Expiry is a plain `YYYY-MM-DD` calendar date, never a timestamp (timezone shifts move
printed best-before dates across midnight otherwise).

```ts
interface AmbryDoc {
  schema_version: number;
  items: Item[];
  events: HistoryEvent[];        // append-only, age-pruned
  extras: ShoppingExtra[];       // ad-hoc shopping lines (§1.6)
  settings: Settings;
}

interface Item {
  id: string;                    // UUID
  name: string;
  aliases: string[];             // merge residue + search hits; default []
  notes: string;
  category: string | null;       // picked from existing values, explicit "add new" (§5)
  location: string | null;       // same; seeded pantry/fridge/freezer

  unit: string;                  // "bag", "stick", "g" — the unit carries granularity
  quantity: number;              // THE number, in `unit`; rounded to 3 decimals, clamped ≥ 0
  package_size: { amount: number; unit: string } | null;   // 1 bag = 1000 g
  display_mode: "number" | "ladder";

  threshold: number | null;      // in `unit`; null = no auto-flag
  flagged: boolean;
  flag_source: "threshold" | "manual" | null;   // provenance survives event pruning
  flagged_at: string | null;
  restock_amount: number;        // default purchase quantity, in `unit`; default 1
  shopping_amount?: number;     // this trip's chosen amount; absent = use the default
  carted_at?: string;            // staged for checkout, with an explicit shopping_amount
  never_prompt: boolean;         // suppresses auto-raise ONLY; manual flag still works

  expiry: string | null;         // "YYYY-MM-DD"
  barcodes: string[];            // reserved for phase-2 scanning; costs nothing now
  verified_at: string | null;    // last explicit count/confirmation; never a review deadline
  merged_into: string | null;    // set on the losing row of a merge

  created_at: string;
  updated_at: string;            // bumps on EVERY mutation incl. soft delete
  deleted_at: string | null;     // soft delete
}

interface HistoryEvent {
  id: string;                    // events need UUIDs so future import-merge can union by id
  item_id: string;               // as it was at write time — never rewritten by merges
  at: string;
  kind: "create" | "add" | "use" | "recount" | "purchase"
      | "unit_change" | "merge" | "delete" | "restore" | "import";
  qty_before: number;            // before+after, not delta: every event self-contained,
  qty_after: number;             //   pruning gaps visible instead of corrupting a sum
  unit: string;                  // SNAPSHOT of item.unit at write time (§1.5)
  unit_before?: string;          // unit_change only: qty_before is in unit_before
  note?: string;                 // e.g. merge records the loser's name
}

interface ShoppingExtra {
  id: string;
  text: string;                  // "birthday candles"
  created_at: string;
  updated_at: string;
  carted_at?: string;            // staged for checkout
  deleted_at: string | null;     // checkout or explicit removal; hard-pruned after ~7 days
}

interface Settings {
  retention_days: number;        // default 365, per brief
  last_export_at: string | null;
  writes_since_export: number;   // stored, not derived — pruning can't distort it
  device_label: string;          // goes in the export envelope
}
```

### Semantics (the part that is actually the product)

**Quantity gestures → event kinds.** Kind is inferred, never asked: stepper up → `add`,
stepper down → `use`, absolute entry / ladder tap / audit fix → `recount`, shopping
checkout → `purchase`. Staging and put-back write no quantity events. Stepper bursts
debounce (~2 s settle) into one event. `recount`
stamps `verified_at`. Decrement below zero writes 0.

**Flags.** Inside the mutation command, on every quantity write: if
`before > threshold ≥ after` and `!never_prompt` → raise, `flag_source: "threshold"`.
Only a `purchase` event or an explicit manual clear lowers it; recount-up never does
(sticky rule made mechanical). Manual raise always available; `never_prompt` items show a
muted no-bell marker in normal views so silent suppression stays auditable. Flag changes
are item fields, not events — provenance survives pruning (R2).

> **Revision (2026-08-28).** The strict-crossing raise (`before > threshold ≥ after`)
> had two dead zones, both confirmed on device and both contradicting the UI's
> "auto-flags at or below N" promise: an item first-counted AT its threshold never
> flagged (its seeded `before` of 0 is not above the threshold), and an item sitting
> exactly at its threshold that then dropped below never flagged either. The raise rule
> is now: raise when `!never_prompt`, the item has a threshold, is not already flagged,
> the write lands `after ≤ threshold`, and either the move is downward (`after <
> before`) or it is the item's first observation (`verified_at` still null pre-write —
> a first count landing low, including a first count of exactly 0, IS the news that
> stock is low). Purchase still always clears and never raises, so buying back to
> exactly the threshold still does not instantly re-raise; upward writes on counted
> items still never raise (no nag on corrections). Implemented in `src/domain/flags.ts`.

**Ladder.** Read buckets over quantity: ≥ 0.75 Full, ≥ 0.35 Half, > 0 Low, 0 Out;
qty > 1 renders "Full +N". Write: rung tap = `recount` to 1.0 / 0.5 / 0.2 / 0, confirm
required when qty > 1 (§1.7). Mapping is a code constant, not a setting.

**Shopping view (revised 2026-09-26)** has two distinct steps: **To buy → In the cart →
Check out**. To buy contains flagged live items and live extras that are not staged.
The cart icon sets optional `carted_at` on the item/extra. Item staging also captures
the chosen `shopping_amount` (or its usual default). Pantry stock, flags, verification
stamps, and quantity history do not change. Amounts remain editable in the cart.
Put back and the 3-second staging Undo remove only the marker, retaining the amount
and original flag. Cart contents persist across navigation, reopening, and midnight.

**Checkout** validates the entire cart, prepares all purchases, and saves one complete
document synchronously before publishing the new state. Each staged item gets one
`purchase` event, its amount added to the current pantry quantity, and its flag cleared.
Staged extras are soft-deleted and can then graduate via "add to pantry?". Completed
staging markers and plans are cleared; unbought needs and plans stay on the list.
Saving failures leave the cart and stock untouched for retry; another checkout on the
empty cart is a no-op. `last_trip_ended_at` records the completed checkout.

> **Revision (2026-09-13).** Shopping amount edits persist immediately through the
> store in optional `Item.shopping_amount` (same unit as quantity), rather than
> component state that resets on navigation or reopening. Missing means use
> `restock_amount`; the “Usually buy” default stays separate. Editing the plan
> changes no stock, flags, observation stamp, or history. Staging uses the plan
> and keeps it for Undo/Put back. Checkout clears completed items' plans while
> unbought items retain theirs; explicit removal/deletion discards the plan.
> Unit/package conversions also convert the plan, or discard it when the guarded
> unit flow requires re-entry (also returning that item to To buy for restaging).
> Existing v1 backups need no new required field.

> **Revision (2026-09-17).** Shopping cards label current stock “Have” and
> the planned purchase “Buy”. As of 2026-09-26, pending cart amounts are labelled
> “In cart”, beside unchanged “Have” stock. Existing purchase events are already
> completed purchases: loading/importing an older backup never stages or rebooks
> them. Optional staging markers keep old v1 backups compatible without a schema
> migration; malformed markers return to the ordinary list without changing stock.

**Bulk organization (2026-09-17).** Pantry → Organize items selects live items
by search/location, then applies location and/or category in one store commit.
Untouched fields, stock, flags, verification stamps and events stay unchanged.
Existing vocabulary casing wins; new values and explicit clearing are allowed.
The whole selection is validated before writing. Undo restores only fields that
still match the bulk edit, preserving intervening edits and deletions.

**Manual update checks (2026-09-17).** More shows the installed version and a
Check for updates action with checking/downloading/current/ready/error states.
An update is ready only after installation finishes. Failed or offline checks
never report “up to date”; restarting first flushes pending pantry writes and
refuses to reload when saving fails or another tab changed storage.
The recovery screen must also expose update/check/restart without requiring a
new pantry, so a newer-format backup's "update first" instruction is actionable.

**Shopping extra removal (2026-10-11).** A typo or cancelled purchase can be
removed directly from either To buy or the pending cart. This is a soft delete
through the store, never a purchase or a pantry-stock change. Undo restores the
extra to its prior list/cart state without rewriting other trip state.

**Modal sheets (2026-10-11).** Opening a sheet moves focus inside it and makes
the background unavailable to keyboard and assistive-technology interaction.
Tab stays inside the top sheet; Escape closes only that sheet. Closing restores
focus to the initiating control when it still exists. Nested sheets preserve
the parent's state and release background isolation only when the last closes.

**Merge** (duplicate repair): survivor keeps its ID; loser gets `deleted_at` +
`merged_into`; loser's name and aliases append to survivor's aliases — so every repaired
duplicate permanently immunizes future searches against its recurrence. **Events are never
rewritten**: the survivor's history view is the union over the `merged_into` chain, and
since every event names its unit, mixed-unit merged history displays honestly. Combined
quantity is a prompt (default: sum when units match, else survivor's value with a
set-to-actual nudge), recorded as a `merge` event. Flags OR together.

**Unit / package-size change**: guarded flow per §1.5 — convert quantity AND threshold
atomically, or force re-entry of both; `unit_change` event either way; round converted
values at display time (0.432 bags must not render as 431.999… g).

**Inventory review (revised 2026-10-06).** Inventory counts never expire. Ambry must
never nag the user to update or recheck stock because time has passed: no 7/30-day
rules, stale-count banners, age captions, "Needs a check" queues, or review badges.
The user updates quantities as part of using the pantry. An old `verified_at` is not
evidence that the current quantity is wrong; routine stock changes and purchases can
be recent even when that separate observation timestamp is old.

An optional **More → Inventory tools → Walk the shelves** remains available only
when explicitly opened. It lists the chosen location (or all items) alphabetically,
with row order held steady during edits. **✓ Looks right** records an explicit
confirmation and quantity controls work as usual. **Done** leaves immediately, even
without touching any item; there is no unchecked-item follow-up or completion quota.
Opening, leaving, or ignoring this tool changes no stock, flags, timestamps or history.
Existing `verified_at` values are retained for data compatibility and first-count
semantics, with no migration that pretends a new count happened.

**Inventory file (revised 2026-09-28)**: the everyday action is **Save inventory file**
(first copy) / **Update inventory file** (subsequent copies). Always suggest
`ambry-inventory.json`, without a date, so the user can replace their regular file.
The More screen shows that name, the last copy and changes since it, and instructions
for saving in the same folder and confirming replacement. Saving a file is explicit;
ordinary edits continue to live on the device and do not silently update an external file.

**Keep a separate copy → Save a dated copy** is an optional secondary action. Only
that action uses `ambry-backup-2026-08-27-1930.json` (local time, sortable). It does not
change the next routine save's name. Restore from a file is visually separate and keeps
the preview, staleness guard and pre-import snapshot. Existing dated backups still restore.

Both choices contain the same full-fidelity, pretty-printed JSON envelope: `app`,
`schema_version`, `exported_at`, `device_label`, counts, and *everything* (items incl.
tombstones, events, extras, settings). The date remains inside the file even when it is
absent from the filename. Reminder banners use the same routine inventory-file save.

Prefer a native save picker where supported: the user chooses the file and confirms
replacement, and export bookkeeping runs only after the writable stream closes. No file
handle is retained and no background file writes occur. On iPhone, use
`navigator.share({files})` → Save to Files / iCloud Drive; the user still selects the
folder and confirms Replace. A completed share is described as a handoff, never proof
that an existing file was overwritten. Preserve the Android text/plain retry and the
non-iOS download fallback. A download suggests the same name but cannot overwrite an
existing file itself; the result tells the user to replace their old copy. Cancellation
or failure never resets the reminder or falls through from a failed native save to a
second file. Concurrent save taps are ignored while a picker/share is open.

On-device snapshot exports use the same platform-aware save/error behavior but
preserve the snapshot's original bytes, including a damaged snapshot. Saving a
snapshot never marks the current pantry as exported. Cancellation or failure
must not claim a successful save; iOS has no anchor-download fallback.

**Import**: parse → validate `schema_version` (refuse files newer than the app with
"update the app first", not a parse error) → migrate → preview ("Backup from Aug 12:
291 items. Replace current: 297 items, last edited today?") → staleness guard (§1.3) →
auto-snapshot current data → replace.

**Empty-storage boot**: from inside the sandbox, eviction is indistinguishable from first
run (everything script-writable dies together), so the app never silently starts fresh:
"No data found on this device. If you've used Ambry before, this browser may have cleared
its storage." **Restore backup** primary, *Start new pantry* secondary behind a confirm.
This converts the worst failure — silent loss plus weeks of unwitting re-entry — into a
noticed, recoverable event.

**Retention**: prune at app launch, one pass: events older than `retention_days` (keep
each item's single most recent event for context), checked-off extras older than 7 days.
Safe by construction under R2.

---

## 3. Stack

**Recommendation: TypeScript (strict) + Preact + Vite. Storage: localStorage, one
versioned JSON document behind a storage-adapter interface. Hand-written ~50-line service
worker. Static hosting at `ambry.sciomedes.com`. Runtime dependency count: one
(Preact).**

Two of the three planners converged on exactly this; the third made a serious case for a
zero-build alternative, which I present honestly below because it's your real fork.

**Language — TypeScript, strict.** The domain layer (flag transitions, merges, unit
conversion, migrations, import validation) is precisely the code where a type error
becomes silent data corruption, and typed schemas + compiler-audited migration functions
are worth a build step. Rejected: plain JS (gives up checking exactly where it pays).

**Framework — Preact (~4 KB).** React idioms, API stable for a decade, enough reactivity
that live search, the shopping view, and the reconcile screen are trivial. State is a
plain module over the in-memory doc — no state library, no router beyond a tab switch.
Rejected: **React** (10× the bytes and a tooling treadmill for zero benefit at 4 screens),
**Svelte** (compiler major-version churn is exactly the tax a finished personal app can't
pay), **SolidJS** (fine; thinner ecosystem to lean on in year three).

**The live alternative — zero build step**: vanilla ES modules + JSDoc types checked by
`tsc --noEmit --checkJs` as an optional dev-only tool, a ~15-line `h()` DOM helper,
`node --test`, deploy = `git push`. Its argument is real: when the deployed artifact *is*
the source, no toolchain has to resurrect in 2031 to ship a one-line fix, and toolchain
death is the most likely way a finished personal app actually dies. Costs: hand-rolled
list reconciliation (where solo projects stall), wordier types, no compiler on your
migrations. **Tiebreaker: if you expect Ambry to be *finished* and untouched for years at
a stretch, take zero-build; if you expect to keep tinkering, take Preact+TS.** I lean
Preact+TS because the integrity-critical code benefits most from strict types now, and
Vite is swappable in an afternoon later — but this is your call (§6.2), and the data
model, build order, and everything else in this plan survive either choice unchanged.

**Storage — localStorage, single JSON doc, behind an adapter.** The decisive facts:
(1) on iOS, localStorage and IndexedDB are **evicted together** — IDB buys zero
durability here; durability is the §1.1 behavior chain, not a storage choice. (2) One
key read synchronously at startup means **first paint already has data** — no spinner
between pocket and "yes, you have paprika"; parsing 500 KB is single-digit milliseconds.
(3) One `setItem` is atomic, so item+event+settings commit together without transaction
machinery — the whole reason IDB looked attractive. Writes debounce ~100 ms and flush on
`pagehide`/`visibilitychange` (iOS kills backgrounded pages without ceremony). Sizing:
items ≤ 250 KB; a heavy year of events ≈ 1–2 MB; comfortably inside the ~5 MB quota at
the default 1-year retention. The adapter (get/put doc) is the hedge: if quota ever
bites, IDB slots in behind the same interface — and the adapter is also where the future
sync change-queue hangs. Rejected: **IndexedDB now** (async boot, worse Safari bug
history, solves problems this volume doesn't have), **idb/Dexie** (dependencies for the
same), **SQLite-wasm/OPFS** (infrastructure your Scale section forbids).

**PWA — hand-written manifest + service worker, no Workbox.** Cache-first app shell
(instant launch on flaky supermarket LTE — network-first would hang the aisle test on
one bar), versioned cache name, update check on every launch; when a new worker is
waiting, a small "Update ready — restart" pill; app version visible in settings so
what's-running is never a mystery. Install nag per §1.1. **One iOS trap to plan around,
not discover: the home-screen app gets its own storage container, separate from the
Safari tab — install FIRST, seed data SECOND**, and the nag banner warns about the split.
Standalone-mode hygiene from day one: `dvh` not `100vh`, 16 px minimum inputs (else iOS
zooms), `viewport-fit=cover` + safe-area insets, all navigation in-app (standalone has no
reload button and no URL bar — a dead-end screen is a force-quit).

**Hosting — GitHub Pages, serving `ambry.sciomedes.com`. DECIDED (2026-08-27).** Not
vanity: storage and the install are keyed to the origin, so the URL is effectively part
of the database. A subdomain of a domain already owned beats a fresh registration on the
one axis that matters — it inherits a renewal commitment that already exists, so there is
no new way for the origin to lapse and orphan the data. `sciomedes.com` is registered and
DNS-managed at Squarespace; the `ns-cloud-*.googledomains.com` nameservers are legacy
Google Domains infrastructure Squarespace inherited, not a Cloud DNS zone we control.

Setup as built: `public/CNAME` in the repo (Vite copies `public/` into `dist/`; a
root-level CNAME would be dropped at build time and silently unset the domain), the
repo's custom domain claimed *before* any DNS pointed at GitHub to close the
subdomain-takeover window, then a CNAME at Squarespace pointing
`ambry.sciomedes.com` to `rduncangt.github.io`, then Enforce HTTPS. The initial
A/AAAA workaround was replaced on 2026-08-27 before the certificate issued.
GitHub Pages is the right host here specifically because it takes a plain CNAME from any
external DNS provider; Cloudflare Pages prefers the zone to live on Cloudflare, which
this one doesn't. DNS can later repoint to a different static host without changing the
origin — which is the whole point.

The apex currently sends no HSTS header and is not preloaded, so nothing is inherited
either way and the subdomain starts clean; set HSTS on Ambry's own responses once it is
live. Note that browser storage is origin-scoped, so Ambry's data is fully isolated from
anything else served under `sciomedes.com`. Revisit a dedicated `ambry.*` domain only if
this ever becomes something other than a personal tool — the migration cost then is a
full export, a re-point, and a re-import on the new origin.

**Testing — Vitest, inventory and storage rules**: flag transitions, ladder mapping, normalization/
duplicate matching, merge (incl. chained), unit-change conversion and forced re-entry,
migrations against old-shape fixtures, export/import round-trip. The UI gets none — it's
exercised by living on it. This is the only place tests pay for themselves in a solo app.

**Barcode (phase 2, per brief — and deferring is right on friction grounds too):** iOS
Safari has no `BarcodeDetector`, so scanning means shipping a WASM decoder (zxing-wasm) —
the app's first heavy dependency — plus an online lookup (OpenFoodFacts) with a local
cache. And for *repeat* items, three typed letters beat a scan; its value is new-item
creation only. The `barcodes: []` field is reserved now so old backups never need a
migration when it lands.

---

## 4. Build order

Ordering principle: **durability rails exist before the first real item; the anti-drift
toolkit exists before the full-pantry load-in.** Real data in an app that can't export
yet is data at risk; a 300-item load-in before duplicate matching exists is drift
pre-seeded.

### M0 — Rails on the real phone (~half a day)

Repo; scaffold; deploy to the **permanent origin** (`ambry.sciomedes.com`); manifest +
service worker; install on
the actual iPhone; persistence-layer skeleton (adapter, `schema_version` + migration
runner, mutation-command chokepoint); raw full-fidelity export/import; empty-storage boot
screen. Every iOS quirk must surface on day one on the device of record, not in week
three.

**Exit test — run it literally:** enter a fake item on the phone, export to iCloud Drive,
delete Safari website data, reload, restore from the file, get identical state. **If this
doesn't pass, nothing else gets built.**

### M1 — The aisle answer + backup (the genuinely minimal usable milestone; ~a weekend of evenings)

- Bottom-pinned live search (thumb zone), answer **in the result row** — name, ladder
  chip or qty+unit, location; never one tap deeper. Case/diacritic-folded substring over
  names + aliases, prefix-ranked. No fuzzy.
- **Search-first create** (§1.4): matches incl. tombstones-with-restore; "Create
  '⟨typed⟩'" as the fallback row. Quick-create asks name only — unit chip row, qty 1,
  last-used location preselected; everything else is edit-later.
- Quantity gestures writing in place: ±steppers, tap-number → `inputmode="decimal"`,
  ladder chips. Event logging via the chokepoint (free forever after). Soft delete with
  undo toast.
- Export via share sheet, gated import, staleness nag, install nag — §1.1 ships **here**.

**Exit:** answers "do I have paprika?" in < 3 s at the shelf. Seed ~30 staples — not the
full pantry yet.

### M2 — Resupply and the shop round-trip (~1–2 weeks of evenings)

Thresholds (rung-picked for ladder items); edge-triggered auto-raise; sticky
purchase-clear + manual clear; `never_prompt`; shopping view (To buy + extras + pending
cart); one-tap staging with editable amounts, then explicit checkout; extras with
promote-to-item after checkout.

**Exit:** one real supermarket trip round-trips — flag at home, buy, check off in the
aisle — in under 2 minutes of total app interaction.

### M3 — Inventory repair and dependable everyday use

Optional walk-the-shelf tool (✓ / edit / leave freely); no timed review reminders; merge tool;
unit-change guarded flow; retention pruning; settings (retention, export nag, version).
The 2026-10-11 release pass adds the recovery, error handling, shopping-extra removal
and accessibility fixes listed in §0. Pantry load-in is voluntary, at the user's pace.

**Exit = v1.** A two-bags-of-flour discrepancy is fixable in one gesture, whenever
the user notices it; shopping, inventory-file recovery, offline use and updates
have passed acceptance. No review schedule is imposed.

### Deliberately deferred after v1

Read-only desktop inventory-file viewing; expiry badges and filtering; an Out-only
filter; barcode scanning; history browsing beyond the item-detail list; fuzzy search;
seasonal archival; merge-on-import and sync. Existing bulk location/category editing
is shipped functionality. None of these deferrals changes stored data or backup
compatibility.

---

## 5. Defaults this plan sets (veto any; none is load-bearing)

| Decision | Default | Why |
|---|---|---|
| Required fields at create | Name only; qty 1, unit "count" | Mid-aisle creation must not cost 30 s of pickers |
| Category/location vocab | Pick from existing values + explicit "add new"; never a bare text field | "Fridge"/"fridge" is duplicate rot one level up |
| Unit vocab | Chip row of ~7 common + typeahead over units in use | No unit-management screen |
| Launch view | Inventory, search pinned, grouped by location, alpha within; no launch-state memory | The 3-second answer is decided at cold launch |
| Search focus | Big target, NOT auto-focused | Keyboard jumping up on every launch is friction |
| Inventory reviews | Entirely voluntary; never requested based on elapsed time | Saved counts remain valid until the user changes them |
| Quantity zero | Stays visible with "out" state; Out-only filtering deferred | Auto-hide makes absence indistinguishable from never-tracked |
| Threshold comparison | Raise when a write lands ≤ threshold moving down, or on the item's first count | Revised 2026-08-28 — see §2 Flags; purchases excepted |
| Purchase always clears flag | Yes, even if still ≤ threshold | Matches the brief's letter; next use re-crosses and re-flags |
| Ladder mapping | 1.0/0.5/0.2/0 write; 0.75/0.35/>0/0 read; code constant | Configurability here adds decisions, not accuracy |
| Quantity precision | Round 3 decimals on write, clamp ≥ 0 | Kills float noise before it persists |
| Export nag | Badge at 20 writes or 7 days; banner at 2×; post-shop prompt; never a blocking modal | Nagging must not add entry friction |
| Backup destination | iCloud Drive via share sheet (off-device) | Survives phone loss; §1.1 |
| Event grain | Debounced per settled change; before+after+unit+kind | §2 |
| Flag history | Item fields only, no flag events | Provenance survives pruning; no downstream use for more |
| Tombstone retention | Keep soft-deleted rows indefinitely | Hundreds of bytes; they're the restore path |
| Recovery drill | After M1 and after every migration: one deliberate export → import | A backup you've never restored is a hope |

---

## 6. Decisions only you can make

1. ~~**The URL**~~ — **DONE 2026-08-27: `ambry.sciomedes.com`**, live and serving from
   `rduncangt/ambry` via GitHub Pages (Actions build, `public/CNAME`). DNS is managed at
   Squarespace, not Google Cloud DNS as §3 first assumed — the `ns-cloud-*` nameservers
   are legacy Google Domains infrastructure Squarespace inherited. Their editor rejected
   a CNAME initially; the temporary A/AAAA records were replaced with a single
   CNAME on 2026-08-27. See §3 for the recorded deployment setup.
2. **Stack — implemented:** Preact + TypeScript + Vite.
3. **Retention default — implemented:** 365 days, configurable in More.
4. **An `archived` state for seasonal items** (eggnog in July): not in v1 as planned —
   `never_prompt` + the visible Out state covers most of it. Deferred until a
   concrete need appears in use.
5. **Expiry depth — resolved for v1 (2026-10-11):** keep the optional date field;
   defer expiry badges/filtering. Inventory quantities never acquire a recheck
   deadline from either that date or elapsed time.
