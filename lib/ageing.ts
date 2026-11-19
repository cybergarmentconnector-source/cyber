/**
 * Receivables / Payables invoice-age filters.
 *
 * Age = as-of date − invoice (voucher) date from Tally, in calendar days. The due date is never used for the filters.
 * Filters are cumulative and strict: "More than 60 days" = every outstanding invoice whose age is > 60 (61, 90, 400 … days).
 * Only invoices with a positive remaining balance on the as-of date, dated on or before it, are counted.
 */

export type AgeKey = 'all' | '60' | '120' | 'custom';
export const AGE_FILTERS: { key: AgeKey; label: string; min: number | null }[] = [
  { key: 'all', label: 'All outstanding', min: null },
  { key: '60', label: 'More than 60 days', min: 60 },
  { key: '120', label: 'More than 120 days', min: 120 },
  { key: 'custom', label: 'Custom', min: null },
];

/** Whole calendar days since 1970-01-01 for a 'YYYY-MM-DD…' date (time and time zone ignored). */
export function dayNumber(d: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? '');
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86_400_000 : null;
}

export interface AgedBill {
  bill: string; billDate: string | null; age: number | null;
  original: number; settled: number; adjustments: number; balance: number;
  dueDate: string | null; dueMissing: boolean; overdueDays: number;
  voucherId?: string; voucherType?: string | null; isOpening?: boolean; movements?: any[];
}

/** A party's open invoices on the as-of date: positive balance, not dated after it, each bill once, oldest first. */
export function openInvoices(bills: any[] | undefined, asOf: string): AgedBill[] {
  const asOfDay = dayNumber(asOf);
  const seen = new Set<string>();
  const out: AgedBill[] = [];
  for (const b of bills ?? []) {
    const balance = Number(b.balance);
    if (!(balance > 0) || b.isAdvance) continue;                       // settled, credit or advance: not an open invoice
    const day = b.billDate ? dayNumber(b.billDate) : null;
    if (day !== null && asOfDay !== null && day > asOfDay) continue;    // dated after the as-of date
    const id = `${b.bill}|${b.billDate ?? ''}`;
    if (seen.has(id)) continue;                                         // never count the same bill twice
    seen.add(id);
    out.push({
      bill: b.bill, billDate: b.billDate ?? null, age: day !== null && asOfDay !== null ? asOfDay - day : null,
      original: Number(b.original) || 0, settled: Number(b.settled) || 0, adjustments: Number(b.adjustments) || 0, balance,
      dueDate: b.dueMissing ? null : b.dueDate ?? null, dueMissing: !!b.dueMissing, overdueDays: Number(b.overdueDays) || 0,
      voucherId: b.voucherId, isOpening: b.isOpening, movements: b.movements,
      // The invoice's own voucher type (Sales, Purchase…): the movement that created the bill, else the first one.
      voucherType: (b.movements?.find((m: any) => m.voucherId && m.voucherId === b.voucherId) ?? b.movements?.[0])?.voucherType ?? null,
    });
  }
  return out.sort((a, b) => (a.age === null ? 1 : b.age === null ? -1 : b.age - a.age));
}

/** Does an invoice pass "more than `min` days"? `min` null = all outstanding. Strictly greater; undated bills only in "all". */
export const matchesAge = (b: AgedBill, min: number | null) => min === null || (b.age !== null && b.age > min);

/** Sum of balances, in paise to avoid floating-point drift, back to rupees. */
export const sumBalance = (bills: AgedBill[]) => bills.reduce((s, b) => s + Math.round(b.balance * 100), 0) / 100;

/** Custom days from the address: a whole number ≥ 0, or null when empty / invalid. */
export function parseDays(v: string | null | undefined): number | null {
  if (v === null || v === undefined || !/^\d{1,5}$/.test(v.trim())) return null;
  return Number(v.trim());
}
