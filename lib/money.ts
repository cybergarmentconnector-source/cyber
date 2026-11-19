/**
 * Exact decimal formatting for numeric strings (no floating point).
 * formatIndian("1234567.891") → "12,34,567.89"
 */
export function roundDecimalString(s: string, places = 2): { neg: boolean; int: string; frac: string } {
  const m = /^\s*(-)?(\d*)(?:\.(\d*))?\s*$/.exec(s ?? '');
  if (!m) return { neg: false, int: '0', frac: '0'.repeat(places) };
  const neg = !!m[1];
  const intPart = (m[2] || '0').replace(/^0+(?=\d)/, '');
  const fracPart = (m[3] || '');
  const scale = 10n ** BigInt(places);
  let scaled = BigInt(intPart) * scale + BigInt((fracPart + '0'.repeat(places)).slice(0, places) || '0');
  const nextDigit = Number(fracPart[places] ?? '0');
  if (nextDigit >= 5) scaled += 1n;                       // round half away from zero
  const intOut = (scaled / scale).toString();
  const fracOut = (scaled % scale).toString().padStart(places, '0');
  const isZero = scaled === 0n;
  return { neg: neg && !isZero, int: intOut, frac: places ? fracOut : '' };
}

export function groupIndian(int: string): string {
  if (int.length <= 3) return int;
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
}

/** How many decimals amounts are shown with. Display only: stored and calculated values stay exact.
 *  Whole rupees everywhere, except on an invoice (the invoice page and the invoice PDF). */
export const AMOUNT_DECIMALS = 0;
export const INVOICE_DECIMALS = 2;

export function formatIndian(s: string | null | undefined, places = AMOUNT_DECIMALS): string {
  if (s === null || s === undefined || s === '') return '—';
  const r = roundDecimalString(String(s), places);
  return `${r.neg ? '-' : ''}${groupIndian(r.int)}${places ? '.' + r.frac : ''}`;
}

/** Absolute value with Dr/Cr suffix: "12,500 Dr" (or "12,500.00 Dr" when places = 2). Zero → "0". */
export function drCr(s: string | null | undefined, places = AMOUNT_DECIMALS): string {
  if (s === null || s === undefined || s === '') return '—';
  const r = roundDecimalString(String(s), places);
  const body = `${groupIndian(r.int)}${places ? '.' + r.frac : ''}`;
  if (r.int === '0' && /^0*$/.test(r.frac)) return body;
  return `${body} ${r.neg ? 'Cr' : 'Dr'}`;
}

export function formatQty(s: string | null | undefined): string {
  if (s === null || s === undefined || s === '') return '—';
  const r = roundDecimalString(String(s), 3);
  const frac = r.frac.replace(/0+$/, '');
  return `${r.neg ? '-' : ''}${groupIndian(r.int)}${frac ? '.' + frac : ''}`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1];
  return `${Number(d)} ${mon} ${y}`;
}
