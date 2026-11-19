/** Query string for API calls; empty values are left out. Key order is kept, so the same inputs give the same cache key. */
export function qs(params: object) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params) as [string, unknown][]) if (v !== null && v !== undefined && v !== '') u.set(k, String(v));
  return u.toString();
}
