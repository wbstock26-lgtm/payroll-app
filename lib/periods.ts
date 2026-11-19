// Generates 26 bi-weekly pay periods for a given payroll year.
// 2026 anchor: Period 1 starts 2025-12-21.
// Each subsequent year's P1 = previous year's P1 + 26 × 14 days (364 days).

export interface PayPeriod {
  n: number;
  start: string;  // "YYYY-MM-DD"
  end: string;
  label: string;  // "YY/MM/DD~YY/MM/DD"
  month: number;  // 1-12, based on period end date
}

function toISO(d: Date): string {
  return d.toISOString().split("T")[0];
}

function toShort(iso: string): string {
  // "2025-12-21" → "25/12/21"
  return `${iso.slice(2, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
}

export function generatePeriods(year: number): PayPeriod[] {
  // 2026 P1 anchor
  const anchor = new Date("2025-12-21T00:00:00Z");
  const yearOffset = year - 2026;
  const p1 = new Date(anchor);
  p1.setUTCDate(p1.getUTCDate() + yearOffset * 26 * 14);

  return Array.from({ length: 26 }, (_, i) => {
    const start = new Date(p1);
    start.setUTCDate(start.getUTCDate() + i * 14);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 13);

    const startISO = toISO(start);
    const endISO = toISO(end);
    // Group period by end date's month (so P1 that straddles Dec/Jan falls in Jan)
    const month = parseInt(endISO.slice(5, 7));

    return {
      n: i + 1,
      start: startISO,
      end: endISO,
      label: `${toShort(startISO)}~${toShort(endISO)}`,
      month,
    };
  });
}

export const SUPPORTED_YEARS = [2026, 2027, 2028, 2029, 2030];
