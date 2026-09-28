/**
 * Save an inventory file or an optional dated copy. Prefer a native save
 * picker where available, then the phone's share sheet. iOS never falls
 * back to an unobservable anchor download (PLAN.md §1.1).
 */
import { exportFilename, type ExportKind } from "../domain/exportImport";
import type { Store } from "../store/store";
import type { ShowToast } from "./hooks";
import { isIOS } from "./sw-client";

export type ExportResult = "saved" | "shared" | "downloaded" | "cancelled" | "failed" | "busy";

// The picker is not in TypeScript's Window interface. Keep the surface
// narrow: no retained handles, second database, or background file writes.
type SaveFilePicker = (options: {
  id: string;
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<{ createWritable(): Promise<FileSystemWritableFileStream> }>;
const fileWindow = window as Window & { showSaveFilePicker?: SaveFilePicker };

export function supportsSaveFilePicker(): boolean {
  return typeof fileWindow.showSaveFilePicker === "function";
}

let exporting = false;

/** One export at a time, including taps from another view or a banner. */
export async function exportFlow(store: Store, kind: ExportKind = "inventory"): Promise<ExportResult> {
  if (exporting) return "busy";
  exporting = true;
  try {
    return await writeExport(store, kind);
  } catch {
    return "failed";
  } finally {
    exporting = false;
  }
}

/**
 * Build the full envelope for every path. Record a native save only after
 * the file closes successfully. Otherwise record the completed handoff or
 * download. An abandoned picker/share sheet (AbortError) must not reset
 * the reminder, and a share failure must never claim success: on
 * standalone iOS the <a download>
 * fallback can fail silently, so stamping last_export_at there would disarm
 * the staleness nag while no backup exists (the durability lie PLAN.md §1.1
 * forbids). A failure never claims the inventory file was updated.
 */
async function writeExport(store: Store, kind: ExportKind): Promise<ExportResult> {
  const envelope = store.buildExport();
  // Pretty-printed (PLAN.md §2 Export): the backup doubles as a
  // human-inspectable archive.
  const json = JSON.stringify(envelope, null, 2);
  const name = exportFilename(new Date(envelope.exported_at), kind);

  if (supportsSaveFilePicker()) {
    let handle: Awaited<ReturnType<SaveFilePicker>>;
    try {
      // Called before the first await, preserving the initiating tap. The
      // browser remembers this picker's folder and confirms replacements.
      handle = await fileWindow.showSaveFilePicker!({
        id: "ambry-inventory",
        suggestedName: name,
        types: [{ description: "Ambry inventory", accept: { "application/json": [".json"] } }],
      });
    } catch (error) {
      return error instanceof DOMException && error.name === "AbortError" ? "cancelled" : "failed";
    }
    let writable: FileSystemWritableFileStream | undefined;
    try {
      writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
    } catch {
      // Abort the uncommitted stream if still open. A write/close failure
      // must not become a second download or clear the backup reminder.
      try { await writable?.abort(); } catch { /* already closed or errored */ }
      return "failed";
    }
    store.recordExport();
    return "saved";
  }

  /** One share attempt; "cancelled" only for the user closing the sheet. */
  const tryShare = async (file: File): Promise<ExportResult> => {
    try {
      await navigator.share({ files: [file] });
      store.recordExport();
      return "shared";
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
      return "failed";
    }
  };

  const jsonFile = new File([json], name, { type: "application/json" });
  const canShareFiles = typeof navigator.share === "function" && typeof navigator.canShare === "function";

  if (canShareFiles && navigator.canShare({ files: [jsonFile] })) {
    const first = await tryShare(jsonFile);
    if (first !== "failed") return first;
    // iOS: a supported-but-broken share must stay an honest failure — the
    // anchor path there can drop the download without any signal, and
    // recording an export that may not exist disarms the staleness nag
    // (PLAN.md §1.1). Android has no such treachery: fall through.
    if (isIOS()) return "failed";
    // Android share sheets widely reject application/json (NotAllowedError
    // or an empty target list). Same bytes, same .json filename, text/plain
    // MIME: most sheets accept it. One retry, then the download below.
    const plainFile = new File([json], name, { type: "text/plain" });
    if (navigator.canShare({ files: [plainFile] })) {
      const second = await tryShare(plainFile);
      if (second !== "failed") return second;
    }
  } else if (isIOS()) {
    // File-sharing unsupported on iOS: the anchor path is not trustworthy
    // (standalone Safari can drop the download silently) — refuse rather
    // than record an export that may not exist.
    return "failed";
  }

  // A download cannot replace an existing file on our behalf. Keep the
  // suggested name stable and make that last step explicit in the result.
  const url = URL.createObjectURL(jsonFile);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke later, not synchronously — some engines abort the save if the URL
  // dies before the download pipeline picks it up.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  store.recordExport();
  return "downloaded";
}

/**
 * THE export UX: run exportFlow and toast the outcome. Every export button
 * goes through here so no caller can invent its own (possibly dishonest)
 * wording for a cancelled or failed export.
 */
export function exportMessage(result: ExportResult, kind: ExportKind = "inventory"): string {
  const file = kind === "inventory" ? "Inventory file" : "Dated copy";
  if (result === "saved") return `${file} saved`;
  if (result === "shared") return `${file} sent to your chosen app`;
  if (result === "downloaded") return kind === "inventory"
    ? "File downloaded — replace the old copy in your usual folder."
    : "Dated copy downloaded";
  if (result === "cancelled") return "Cancelled — no file was saved";
  if (result === "busy") return "A file save is already open";
  return "Could not save the file — try again";
}

export async function doExportWithToast(
  store: Store, toast: ShowToast, kind: ExportKind = "inventory",
): Promise<ExportResult> {
  const result = await exportFlow(store, kind);
  toast(exportMessage(result, kind));
  return result;
}

/**
 * Open the file picker via a hidden input. Resolves null on cancel (the
 * "cancel" event; engines without it simply leave the promise pending, which
 * is harmless — the input is re-created per call).
 */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";
    const done = (file: File | null): void => {
      input.remove();
      resolve(file);
    };
    input.addEventListener("change", () => done(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

/** Read a picked file as text. */
export function readText(file: File): Promise<string> {
  return file.text();
}
