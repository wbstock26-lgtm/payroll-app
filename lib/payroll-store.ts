// Shared localStorage store for payroll entries.
// P23 (starting 2026-10-25) and later require manual data entry via the payroll page.

export const LIVE_CUTOFF = "2026-10-25"; // P23 start

export interface SavedEmpRow {
  regular: number;        // regular hours worked
  holiday: number;        // holiday hours
  otherBenefit: number;   // other taxable benefit ($)
  taxOverride: string;    // "" = auto; numeric string = manual override
  rate: number;
  regularPay: number;
  holidayPay: number;
  vacationPay: number;
  totalGross: number;
  tax: number;
  cpp: number;
  ei: number;
  totalDeduction: number;
  netPay: number;
  employerCPP: number;
  employerEI: number;
}

export type SavedPeriod = Record<number, SavedEmpRow>; // keyed by employee id
export type SavedEntries = Record<string, SavedPeriod>; // keyed by period start date

const LS_KEY = "payroll-saved-entries";

export function loadSavedEntries(): SavedEntries {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as SavedEntries) : {};
  } catch { return {}; }
}

export function savePeriodEntries(periodStart: string, data: SavedPeriod): void {
  try {
    const all = loadSavedEntries();
    all[periodStart] = data;
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {}
}

// ── Server (SQLite) functions ──────────────────────────────────

/** POST one period to SQLite. Returns true only if the server confirmed the save. */
async function postPeriod(periodStart: string, data: SavedPeriod): Promise<boolean> {
  try {
    const res = await fetch("/api/payroll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ periodStart, data }),
    });
    if (!res.ok) return false;
    const j = await res.json().catch(() => ({}));
    return j.ok === true;
  } catch { return false; }
}

/**
 * Fetch all entries from SQLite and merge with this browser's copy.
 * The database wins for periods it has; a period that exists only in this browser
 * (e.g. an earlier save that failed to reach the server) is kept and uploaded again.
 */
export async function syncFromServer(): Promise<SavedEntries> {
  const local = loadSavedEntries();
  try {
    const res = await fetch("/api/payroll", { cache: "no-store" });
    if (!res.ok) return local;
    const server = (await res.json()) as SavedEntries;
    const merged: SavedEntries = { ...server };
    for (const [period, data] of Object.entries(local)) {
      if (!(period in server)) {
        merged[period] = data;
        postPeriod(period, data); // retry upload in the background
      }
    }
    try { localStorage.setItem(LS_KEY, JSON.stringify(merged)); } catch {}
    return merged;
  } catch {
    return local;
  }
}

/** Save to localStorage immediately, then persist to SQLite. Resolves to false if the database save failed. */
export async function savePeriodEntriesRemote(periodStart: string, data: SavedPeriod): Promise<boolean> {
  savePeriodEntries(periodStart, data); // instant local write
  return postPeriod(periodStart, data);
}
