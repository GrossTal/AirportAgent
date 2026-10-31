/** Month helpers. Months are represented as "YYYY-MM-01" strings (Postgres `date`). */

export function toMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

export function parseMonth(m: string): { year: number; month: number } {
  return { year: Number(m.slice(0, 4)), month: Number(m.slice(5, 7)) };
}

export function addMonths(m: string, delta: number): string {
  const { year, month } = parseMonth(m);
  const idx = year * 12 + (month - 1) + delta;
  return toMonth(Math.floor(idx / 12), (idx % 12) + 1);
}

/** The `count` months ending at (and including) `end`, oldest first. */
export function monthsEndingAt(end: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => addMonths(end, i - count + 1));
}

export function daysInMonth(m: string): number {
  const { year, month } = parseMonth(m);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
