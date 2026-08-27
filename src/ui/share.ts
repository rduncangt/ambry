/**
 * Export via the share sheet + file-picking helpers (PLAN.md §1.1: the share
 * sheet's default destinations are off-device — iCloud Drive, AirDrop — which
 * is the whole point; a bare <a download> is the desktop-only fallback).
 */
import { exportFilename } from "../domain/exportImport";
import type { Store } from "../store/store";

export type ExportResult = "shared" | "downloaded" | "cancelled";

/**
 * Build the envelope and hand it to navigator.share when file-sharing is
 * supported, else fall back to an anchor download. recordExport() runs ONLY
 * on a completed share/download — an abandoned share sheet (AbortError) must
 * not silently reset the staleness nag.
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
      // Any other share failure: fall through to the download path below.
    }
  }

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
