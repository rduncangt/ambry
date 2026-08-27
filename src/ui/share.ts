/**
 * Export via the share sheet + file-picking helpers (PLAN.md §1.1: the share
 * sheet's default destinations are off-device — iCloud Drive, AirDrop — which
 * is the whole point; a bare <a download> is the desktop-only fallback).
 */
import { exportFilename } from "../domain/exportImport";
import type { Store } from "../store/store";
import type { ShowToast } from "./hooks";
import { isIOS } from "./sw-client";

export type ExportResult = "shared" | "downloaded" | "cancelled" | "failed";

/**
 * Build the envelope and hand it to navigator.share when file-sharing is
 * supported; the anchor download is the fallback ONLY off iOS. recordExport()
 * runs ONLY on a completed share/download — an abandoned share sheet
 * (AbortError) must not silently reset the staleness nag, and a share
 * FAILURE must never claim success: on standalone iOS the <a download>
 * fallback can fail silently, so stamping last_export_at there would disarm
 * the staleness nag while no backup exists (the durability lie PLAN.md §1.1
 * forbids). "failed" means nothing left the device.
 */
export async function exportFlow(store: Store): Promise<ExportResult> {
  const envelope = store.buildExport();
  // Pretty-printed (PLAN.md §2 Export): the backup doubles as a
  // human-inspectable archive.
  const json = JSON.stringify(envelope, null, 2);
  const file = new File([json], exportFilename(new Date()), { type: "application/json" });

  if (typeof navigator.share === "function" && navigator.canShare?.({ files: [file] }) === true) {
    try {
      await navigator.share({ files: [file] });
      store.recordExport();
      return "shared";
    } catch (e) {
      // AbortError = the user closed the sheet: nothing left the device.
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled";
      // Any other share failure: report it honestly. No anchor fallback here
      // — when share IS supported but broke, silently rerouting to a
      // download the user never asked for (and which may itself fail
      // silently on iOS) hides the failure.
      return "failed";
    }
  }

  // File-sharing unsupported. On iOS the anchor path is not trustworthy
  // (standalone Safari can drop the download without any signal), so refuse
  // rather than record an export that may not exist.
  if (isIOS()) return "failed";

  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
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
export async function doExportWithToast(store: Store, toast: ShowToast): Promise<void> {
  const result = await exportFlow(store);
  if (result === "shared") toast("Backup exported");
  else if (result === "downloaded") toast("Backup downloaded");
  else if (result === "cancelled") toast("Export cancelled — no backup was made");
  else toast("Export failed — try again");
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
