import { now } from "../types";
/**
 * Restore-first boot screen (PLAN.md §2 boot rule): from inside the sandbox,
 * eviction is indistinguishable from first run, so the app never silently
 * starts fresh. Restore is the primary action; starting over hides behind an
 * explicit confirm.
 *
 * The EMPTY boot (only) also offers the bundled starter pantry: a genuinely
 * new user should not face a blank app or assume an empty kitchen. The seed
 * ships inside the bundle (JSON import — precached with the app shell) and
 * runs through parseImport -> importReplace, the SAME gated pipeline as any
 * restore, so migrations apply and the bundled file keeps importing
 * correctly forever (R3). Corrupt boots keep their recovery focus: no
 * starter door there.
 */
import { useMemo, useState } from "preact/hooks";
import { parseImport, restampDoc } from "../domain/exportImport";
import type { AmbryDoc } from "../types";
import { useStore } from "./hooks";
import { pickFile, readText } from "./share";
import seedData from "../../seed/starter-pantry.json";

interface RestorePreview {
  doc: AmbryDoc;
  exportedAt: string | null;
  counts: { items: number; events: number; extras: number };
}

export function BootScreen(props: { status: "empty" | "corrupt"; onDone: () => void }) {
  const store = useStore();
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<RestorePreview | null>(null);

  // The starter seed, parsed once through the real import gate. stringify →
  // parseImport is deliberate: the pipeline gets its own deep copy (the
  // bundled module object must never be aliased into the live doc) and the
  // item count shown below comes from the parse result, never hardcoded.
  const seed = useMemo(
    () => (props.status === "empty" ? parseImport(JSON.stringify(seedData)) : null),
    [props.status],
  );
  const starter = seed !== null && seed.ok ? seed : null;

  async function chooseBackup(): Promise<void> {
    setError(null);
    const file = await pickFile("application/json,.json,text/plain");
    if (file === null) return;
    // Everything after the pick can throw (file.text() rejects when the
    // picked file vanished or the permission lapsed) — a thrown read must
    // surface as an error, never leave this screen silently unresponsive.
    try {
      const text = await readText(file);
      const parsed = parseImport(text);
      if (!parsed.ok) {
        setError(
          parsed.error === "newer_schema"
            ? "This backup was made by a newer version of Ambry — update the app first, then restore."
            : `That file could not be read as an Ambry backup. (${parsed.detail})`,
        );
        return;
      }
      // Preview before replacing — counts recomputed from the migrated doc, so
      // they describe what will actually land.
      setPreview({
        doc: parsed.doc,
        exportedAt: parsed.envelope.exported_at,
        counts: parsed.envelope.counts,
      });
    } catch {
      setError("Could not read that file — try picking it again.");
    }
  }

  function restore(): void {
    if (preview === null) return;
    const outcome = store.importReplace(preview.doc);
    if (!outcome.ok) {
      setError("Restore failed — the backup could not be saved on this device.");
      return;
    }
    props.onDone();
  }

  function startNew(): void {
    // Explicit confirm: starting fresh over an unnoticed eviction is the
    // exact failure mode this screen exists to prevent.
    const ok = window.confirm(
      "Start a new, empty pantry? If you have a backup file, restore it instead — data entered now cannot be merged with an old backup later.",
    );
    if (ok) props.onDone();
  }

  function startStarter(): void {
    if (starter === null) return;
    // One tap + one confirm. Same warning shape as startNew: this too is a
    // choice to proceed without a backup, and the count comes from the
    // parse result — what will actually land.
    const ok = window.confirm(
      `Start with the starter pantry? ${starter.envelope.counts.items} common items, all uncounted — count what you have as you go. If you have a backup file, restore it instead.`,
    );
    if (!ok) return;
    // The bundled seed's timestamps are frozen at build time; stamp the copy
    // "now" so a fresh start has no day-one "N days at risk" backup banner.
    // The parse result is already a
    // deep copy, so mutating it is safe.
    restampDoc(starter.doc, now());
    const outcome = store.importReplace(starter.doc);
    if (!outcome.ok) {
      setError("The starter pantry could not be saved on this device.");
      return;
    }
    props.onDone();
  }

  const exportedAtText =
    preview !== null && preview.exportedAt !== null
      ? new Date(preview.exportedAt).toLocaleString()
      : null;

  return (
    <div class="boot">
      <h1 class="boot-title">Ambry</h1>

      {props.status === "corrupt" ? (
        <p class="boot-msg">
          The data on this device could not be read. Nothing was destroyed — a copy of the
          damaged data was preserved in a snapshot. Restoring from your most recent backup is
          the way forward.
        </p>
      ) : (
        <p class="boot-msg">
          No data found on this device. If you've used Ambry before, this browser may have
          cleared its storage — restore your most recent backup to pick up where you left off.
        </p>
      )}

      {error !== null && <p class="boot-error">{error}</p>}

      {preview === null ? (
        <div class="boot-actions">
          <button class="btn btn-primary btn-big" type="button" onClick={() => void chooseBackup()}>
            Restore backup
          </button>
          {/* Empty boot only: the starter door. A corrupt boot keeps its
              recovery focus — offering 128 fresh items beside a damaged
              pantry would read as a way out of restoring. */}
          {props.status === "empty" && starter !== null && (
            <button class="btn btn-secondary btn-big" type="button" onClick={startStarter}>
              Start with the starter pantry
              <span class="btn-sub">
                {starter.envelope.counts.items} common items, all uncounted — count what you
                have as you go
              </span>
            </button>
          )}
          <button class="btn" type="button" onClick={startNew}>
            {props.status === "empty" ? "Start empty" : "Start new pantry"}
          </button>
        </div>
      ) : (
        <div class="boot-preview">
          <p class="boot-msg">
            {exportedAtText !== null ? `Backup from ${exportedAtText}: ` : "Backup: "}
            {preview.counts.items} items, {preview.counts.events} history events,{" "}
            {preview.counts.extras} shopping extras.
          </p>
          <div class="boot-actions">
            <button class="btn btn-primary btn-big" type="button" onClick={restore}>
              Restore this backup
            </button>
            <button class="btn" type="button" onClick={() => setPreview(null)}>
              Choose a different file
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
