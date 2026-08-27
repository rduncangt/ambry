# Ambry — Planning Brief

## Context

I'm building a pantry inventory app for my own home use, called **Ambry**. It's a personal
project, not a product. Single user, me. I want a concrete build plan for v1.

I've already done an initial brainstorm and made a number of decisions. They're listed
below. I don't want them silently re-litigated, but I do want you to tell me if you think
any of them are wrong — see "What I want from you" at the end.

## The core problem

Answer "do I already have paprika?" in under three seconds, and "what am I about to run
out of?" before I go to the store.

Two failure modes kill apps in this category, and every decision should be weighed
against them:

1. **Entry and removal friction.** If updating after a shop takes five minutes of typing,
   the habit dies within a month.
2. **Drift.** An inventory that's 70% accurate is worse than none, because I stop trusting
   it and go look at the shelf anyway.

## Decisions already made

**Platform and scope**

- Web app, running in a browser on both my phone and my laptop.
- **Single device, local storage only, for v1.** No accounts, no login, no server, no
  sharing, no sync. Sync may be retrofitted later.
- Manual export-to-file and import. In v1 this is the only backup, so it isn't optional.
- No photos in v1. Item names and descriptions should carry enough information.

**Retrofit insurance** (cheap now, expensive later — please preserve these)

- UUIDs as record IDs, not auto-incrementing integers.
- `created_at` and `updated_at` on every record.
- Soft deletes, not hard deletes.
- Every write goes through a single persistence layer rather than scattered calls from
  the UI, so a change queue can be hung there later.

**Quantity model**

- One numeric quantity field per item, plus a per-item unit. No parallel coarse/precise
  fields — I don't want two sources of truth.
- The unit itself carries the granularity. Flour's unit is "bag" (so half a bag is 0.5),
  butter's is "stick", rice could be "g" if I actually weigh it.
- Optional package size per item (flour: 1 bag = 1 kg) so a precise entry like 432 g can
  convert into the coarse unit, and either can be displayed.
- Optional qualitative ladder (full / half / low / out) as a *display mode* over the same
  number, mapping to roughly 1.0 / 0.5 / 0.2 / 0. For spices and condiments I'll never
  count. This is a view, not a second field.

**Resupply**

- Resupply state is **independent of quantity**, not derived from it.
- Per-item threshold, expressed in that item's unit ("flag butter at 1 stick").
- Crossing the threshold auto-raises the flag, but the flag is **sticky**: it stays up
  until I actually buy the thing, not when the number ticks back up because I recounted.
- I can raise the flag manually for reasons unrelated to the threshold (people coming
  over, want extra).
- I need the inverse too: mark an item as never-prompt, for one-off purchases and
  seasonal things. Otherwise the list fills with nags I learn to ignore.
- The shopping list is a *view* over flagged items plus ad-hoc typed entries. Not
  separately stored state.

**History**

- Keep an event history of quantity changes, with a user-configurable retention window.
  Default somewhere around a year. Older events age out.

**Barcode**

- Online lookup with a small local cache of products I've personally scanned. No bundled
  offline product database (those run to gigabytes).
- This can be phase two if it complicates v1 meaningfully.

**Explicitly out of scope for v1**

Recipes, meal planning, cook-from-pantry, nutrition, budget tracking, receipt scanning,
household sharing, multi-device sync, photos. I want the inventory to be genuinely
trustworthy before anything is layered on top of it.

## Scale

- Realistic inventory: ~300 distinct items. Upper bound ~1,000.
- At roughly 200–300 bytes per record, that's under 500 KB total.
- The entire dataset fits in memory and in browser local storage with room to spare.
- So: no pagination, no query optimization, no search index, no lazy loading. Sorting or
  substring-matching the full set on every keystroke is fine.
- **Please don't propose infrastructure this doesn't need.**

## v1 feature set

- Items: create, edit, delete, with name, category, location (pantry / fridge / freezer /
  wherever), quantity, unit, optional package size, optional expiry.
- Search and filter, fast enough to use standing in a supermarket aisle.
- Resupply thresholds and flags per the model above.
- A shopping view of flagged items.
- Export and import.

## Known hard parts

These are about data quality, not data volume, and I'd like the plan to address them:

- **Reconciliation.** At some point the cupboard will have two bags of flour when Ambry
  says half of one. Is the fix a quick "set to actual" gesture, a periodic walk-the-shelf
  mode, or both?
- **Duplicate and near-duplicate items.** "Canned tomatoes" vs "Tomatoes, canned" becoming
  two rows is how the inventory rots.
- **Unit coherence** as items are edited over time.

## What I want from you

1. A concrete data model.
2. A tech stack recommendation with the tradeoffs stated, given the constraints above.
3. A build order — what to get working first, and what a genuinely minimal first
   milestone looks like.
4. **Where you disagree with anything above.** I'd rather hear it now than discover it in
   month two. If one of my decisions is going to cause pain, say so and say why.
5. Decisions I still need to make that I haven't thought about yet.

If anything here is ambiguous or underspecified, ask before planning rather than
guessing.
