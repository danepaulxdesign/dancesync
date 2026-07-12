/**
 * Soft daily export limit, stored in localStorage.
 *
 * Honest disclaimer: this is a static site with fully visible source, so this
 * is a goodwill nudge, not real enforcement — clearing localStorage or using
 * a private window resets it instantly. That's an accepted tradeoff here.
 */

const STORAGE_KEY = "dancesync_export_usage";
const DAILY_LIMIT = 3;

function todayString() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function readUsage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { date: todayString(), count: 0 };
    const parsed = JSON.parse(raw);
    if (parsed.date !== todayString()) return { date: todayString(), count: 0 };
    return parsed;
  } catch (_) {
    return { date: todayString(), count: 0 };
  }
}

function writeUsage(usage) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(usage));
  } catch (_) {
    // localStorage unavailable (private mode edge cases, quota, etc.) —
    // fail open rather than block exports over a storage error.
  }
}

/** True if the user still has exports left today. */
export function hasExportsRemaining() {
  return readUsage().count < DAILY_LIMIT;
}

/** How many exports are left today (0 if none). */
export function exportsRemaining() {
  return Math.max(0, DAILY_LIMIT - readUsage().count);
}

/** Call this once an export actually completes successfully. */
export function recordSuccessfulExport() {
  const usage = readUsage();
  usage.count += 1;
  writeUsage(usage);
}

export const DAILY_EXPORT_LIMIT = DAILY_LIMIT;
