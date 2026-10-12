/**
 * App version, shown in Settings (PLAN.md §3: what's-running is never a
 * mystery). Kept in sync with package.json by hand — a two-line constant
 * beats build-time define plumbing for a value that changes per release.
 * Release-per-round versioning: bump the minor for a feature round, the
 * patch for a pure fix round. Nothing else reads this; keep it that way.
 */
export const APP_VERSION = "0.12.0";
