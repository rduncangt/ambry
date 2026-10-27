# Ambry — releases and acceptance

This record preserves concise project evidence without personal inventory data,
browser profiles or machine-specific temporary paths. A desktop check is not a
claim of physical iPhone acceptance. Release tags identify the exact app revisions.

| Version | Published commit | Change and acceptance |
|---|---|---|
| 1.0.2 | `edd97a2` | Group Search/Clear/Create directly above results; remove the bottom dock and its blank gap. 682 inventory/storage tests, app-file preparation and 91 scoped native browser checks passed. User subsequently accepted the corrected layout on their installed iPhone. Live files and independent live smoke passed. |
| 1.0.1 | `36a4305` | Keep Create beside the bottom search field. Desktop placement checks passed, but the user's iPhone retest still found a large gap and unreachable controls. This did **not** resolve the workflow; superseded by 1.0.2. |
| 1.0.0 | `4e91d78` | First stable personal-use release. Version-only app change after the acceptance below. No inventory schema migration. |
| 0.12.5 | `6725a62` | Remove the temporary text-editing page, entry and special cache route. Update, old-page Return and offline checks passed with saved data preserved. |
| 0.12.4 | `6135859` | Temporary three-case text-editing comparison. All three worked on the user's iPhone; it did not establish a cause or fix. Removed in 0.12.5. |
| 0.12.3 | `f2c96e9` | Full existing/custom unit and optional package selection before saving a new item. First-save values, validation, cancellation and narrow layouts independently checked. 682 tests passed. |
| 0.12.2 | `59bd9d2` | Isolate item details from hidden checkout controls, reject invalid numeric drafts and clarify Count as individual items. Native keyboard/pointer, Undo and child-dialog checks passed; 677 tests passed. |
| 0.12.1 | `a8bcb87` | Accessible search clear control with retained input focus and a 44-pixel target. Native pointer/keyboard and narrow-layout checks passed. |
| 0.12.0 | `fbb7523` | Recovery update access, safe snapshot saving, restore-read retry, shopping extras removal/Undo and accessible dialogs. 656 tests plus independent update/offline/recovery checks passed. |

All listed versions have annotated tags on the remote. Publishing runs verify
inventory/storage tests and prepare app files before deployment. Final published
HTML, JavaScript, CSS and offline worker files were compared with accepted files;
independent live checks used an empty disposable browser without personal data.

## V1 acceptance and limits

The user confirmed these workflows on the installed iPhone:

- Normal app updates preserve inventory.
- Same-name saving replaces the existing file rather than creating duplicates.
- Restore preview opens that saved file with matching totals, followed by Cancel.
- After fully closing Ambry with Wi-Fi and cellular disconnected, reopening from
  the Home Screen retains the inventory and shopping list.
- Normal New item text editing works; Close remains reachable with the keyboard
  open, and closing Change unit returns to item details with Back reachable.

Independent browser verification covered shopping staging and checkout exactly
once, quantity Undo, duplicate safeguards, creation-unit/package correctness,
restore and recovery, keyboard focus/isolation, and narrow layouts.

The pending-save update test deliberately held a scheduled save, then used the
real app Restart action and an actual waiting offline worker. Quantity and its
history event were saved before activation and survived reload exactly once.
Injected write refusal blocked restart, retry succeeded, and injected conflicting
saved data blocked restart without overwriting it. All 38 focused assertions
passed. Timing/error conditions were controlled; worker activation was real.

Restore acceptance combines the completed iPhone export/delete/reinstall/restore
drill recorded on 2026-08-27, a recent completed native desktop roundtrip, unchanged
restore/storage code since that check, and current iPhone replacement/readable
preview. A full restore was not repeated on the current iPhone release. Preview
and Cancel alone do not prove completed restoration.

VoiceOver remains untested. No screen-reader certification or physical VoiceOver
pass is claimed. PM accepted this as a follow-up for the personal-use v1 release.

The earlier iPhone text-caret issue stopped reproducing in normal use. Its cause
remains unknown; neither an app fix nor a phone fault was established.

## Acceptance discipline

Measure the user's actual workflow. Stable control coordinates alone missed the
1.0.1 field-to-result gap. For 1.0.2, acceptance explicitly measured proximity of
the controls to the first result and continued native typing after scrolling,
then obtained the user's actual-phone confirmation.

Record confirmed findings, executed checks, limits and user acceptance here or
in the task list. Do not rely on temporary evidence files as the sole durable
record, and never commit real pantry exports or raw personal browser data.
