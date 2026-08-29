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
 * supported; the anchor download is the fallback only off iOS (Android's share sheet also gets a text/plain retry first — application/json is widely rejected there). recordExport()
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
  const name = exportFilename(new Date());

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

  // Everywhere else the download is dependable (Android: lands in
  // Downloads; desktop: normal save).
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
