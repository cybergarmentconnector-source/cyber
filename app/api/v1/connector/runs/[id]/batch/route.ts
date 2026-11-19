import { chunked, sql } from '@/lib/server/db';
import { body, bool, date, fail, json, num, numOrNull, route, str } from '@/lib/server/http';
import { openRun, requireDevice } from '@/lib/server/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_RECORDS = 500;
const ROLES = new Set(['party', 'revenue', 'tax', 'charge', 'bank', 'other']);
const KINDS = new Set(['debtor', 'creditor', 'other']);
const dedupe = <T,>(rows: T[], key: (r: T) => string) => [...new Map(rows.map(r => [key(r), r])).values()];

export const POST = route(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const dev = await requireDevice(req);
  const { id } = await ctx.params;
  const b = await body(req);
  const entity = String(b.entity ?? '');
  const records: any[] = Array.isArray(b.records) ? b.records : fail(400, 'bad_request', 'records must be a list.');
  if (records.length > MAX_RECORDS) fail(413, 'too_many', `Send at most ${MAX_RECORDS} records per call.`);
  const run = await openRun(dev, id);
  const cid = run.companyId;

  switch (entity) {
    case 'ledger': {
      const rows = dedupe(records.map((r, i) => {
        const lid = str(r.id, 200), name = str(r.name, 300);
        if (!lid || !name) fail(400, 'bad_record', `ledger #${i}: id and name are required.`);
        return { company_id: cid, id: lid, name, parent_group: str(r.parentGroup, 300), primary_group: str(r.primaryGroup, 300),
          is_party: bool(r.isParty), is_bill_wise: bool(r.isBillWise), kind: KINDS.has(r.kind) ? r.kind : 'other', opening: num(r.opening) };
      }), r => r.id);
      await chunked(rows, 1000, p => sql`insert into ledgers ${sql(p)} on conflict (company_id, id) do update set
        name = excluded.name, parent_group = excluded.parent_group, primary_group = excluded.primary_group, is_party = excluded.is_party,
        is_bill_wise = excluded.is_bill_wise, kind = excluded.kind, opening = excluded.opening`);
      break;
    }
    case 'voucher': {
      const vs: any[] = [], es: any[] = [], its: any[] = [];
      for (const [i, r] of records.entries()) {
        const vid = str(r.id, 200), d = date(r.date);
        if (!vid || !d) fail(400, 'bad_record', `voucher #${i}: id and date (YYYY-MM-DD) are required.`);
        vs.push({ company_id: cid, id: vid, date: d, voucher_type: str(r.voucherType, 100), base_type: str(r.baseType, 60),
          voucher_number: str(r.voucherNumber, 100), invoice_number: str(r.invoiceNumber, 100), party_ledger_id: str(r.partyLedgerId, 200),
          party_name: str(r.partyName, 300), party_gstin: str(r.partyGstin, 30), narration: str(r.narration, 1000), amount: num(r.amount),
          cancelled: bool(r.cancelled), optional: bool(r.optional), unbalanced: bool(r.unbalanced), deleted: false });
      }
      const rows = dedupe(vs, v => v.id);
      const keep = new Set(rows.map(v => v.id));
      for (const r of records) {
        const vid = String(r.id);
        if (!keep.has(vid)) continue;
        (Array.isArray(r.entries) ? r.entries : []).forEach((e: any, n: number) => es.push({
          company_id: cid, voucher_id: vid, line: Number.isInteger(e.line) ? e.line : n + 1, ledger_id: str(e.ledgerId, 200), ledger_name: str(e.ledgerName, 300),
          amount: num(e.amount), role: ROLES.has(e.role) ? e.role : 'other' }));
        (Array.isArray(r.items) ? r.items : []).forEach((e: any, n: number) => its.push({
          company_id: cid, voucher_id: vid, line: Number.isInteger(e.line) ? e.line : n + 1, item_id: str(e.itemId, 200), item_name: str(e.itemName, 300),
          qty: numOrNull(e.qty), billed_qty: numOrNull(e.billedQty), unit: str(e.unit, 30), rate: numOrNull(e.rate), discount: numOrNull(e.discount),
          amount: numOrNull(e.amount), godown: str(e.godown, 200), batch: str(e.batch, 200) }));
      }
      const ids = rows.map(v => v.id);
      await sql.begin(async tx => {
        await chunked(rows, 1000, p => tx`insert into vouchers ${tx(p)} on conflict (company_id, id) do update set
          date = excluded.date, voucher_type = excluded.voucher_type, base_type = excluded.base_type, voucher_number = excluded.voucher_number,
          invoice_number = excluded.invoice_number, party_ledger_id = excluded.party_ledger_id, party_name = excluded.party_name,
          party_gstin = excluded.party_gstin, narration = excluded.narration, amount = excluded.amount, cancelled = excluded.cancelled,
          optional = excluded.optional, unbalanced = excluded.unbalanced, deleted = false`);
        await tx`delete from voucher_entries where company_id = ${cid} and voucher_id = any(${ids}::text[])`;
        await tx`delete from voucher_items where company_id = ${cid} and voucher_id = any(${ids}::text[])`;
        // line numbers must be unique per voucher
        await chunked(dedupe(es, e => `${e.voucher_id}|${e.line}`), 3000, p => tx`insert into voucher_entries ${tx(p)}`);
        await chunked(dedupe(its, e => `${e.voucher_id}|${e.line}`), 2000, p => tx`insert into voucher_items ${tx(p)}`);
      });
      break;
    }
    case 'stockItem': {
      const items: any[] = [], gds: any[] = [];
      for (const [i, r] of records.entries()) {
        const sid = str(r.id, 200), name = str(r.name, 300);
        if (!sid || !name) fail(400, 'bad_record', `stockItem #${i}: id and name are required.`);
        items.push({ company_id: cid, id: sid, name, alias: str(r.alias, 300), stock_group: str(r.stockGroup, 300), category: str(r.category, 300), unit: str(r.unit, 30),
          standard_price: numOrNull(r.standardPrice), avg_purchase_rate: numOrNull(r.avgPurchaseRate), closing_qty: num(r.closingQty), closing_value: num(r.closingValue) });
        for (const g of Array.isArray(r.godowns) ? r.godowns : []) if (str(g.godown, 200)) gds.push({ company_id: cid, item_id: sid, godown: str(g.godown, 200), qty: num(g.qty) });
      }
      const rows = dedupe(items, r => r.id), ids = rows.map(r => r.id);
      await sql.begin(async tx => {
        await chunked(rows, 1000, p => tx`insert into stock_items ${tx(p)} on conflict (company_id, id) do update set
          name = excluded.name, alias = excluded.alias, stock_group = excluded.stock_group, category = excluded.category, unit = excluded.unit,
          standard_price = excluded.standard_price, avg_purchase_rate = excluded.avg_purchase_rate, closing_qty = excluded.closing_qty, closing_value = excluded.closing_value`);
        await tx`delete from stock_godowns where company_id = ${cid} and item_id = any(${ids}::text[])`;
        await chunked(dedupe(gds, g => `${g.item_id}|${g.godown}`), 3000, p => tx`insert into stock_godowns ${tx(p)}`);
      });
      break;
    }
    case 'bill': {
      const rows = dedupe(records.map((r, i) => {
        const lid = str(r.ledgerId, 200), bill = str(r.bill, 300), bd = date(r.billDate);
        if (!lid || !bill || !bd) fail(400, 'bad_record', `bill #${i}: ledgerId, bill and billDate (YYYY-MM-DD) are required.`);
        return { company_id: cid, ledger_id: lid, bill, bill_date: bd, due_date: date(r.dueDate), original: num(r.original), settled: num(r.settled),
          adjustments: num(r.adjustments), balance: num(r.balance), voucher_id: str(r.voucherId, 200), is_opening: bool(r.isOpening), is_advance: bool(r.isAdvance),
          movements: sql.json(Array.isArray(r.movements) ? r.movements : []), run_id: run.id };
      }), r => `${r.ledger_id}|${r.bill}|${r.bill_date}`);
      await chunked(rows, 1000, p => sql`insert into bills ${sql(p)} on conflict (company_id, ledger_id, bill, bill_date) do update set
        due_date = excluded.due_date, original = excluded.original, settled = excluded.settled, adjustments = excluded.adjustments, balance = excluded.balance,
        voucher_id = excluded.voucher_id, is_opening = excluded.is_opening, is_advance = excluded.is_advance, movements = excluded.movements, run_id = excluded.run_id`);
      break;
    }
    case 'stockValuation': {
      const rows = dedupe(records.map((r, i) => {
        const d = date(r.asOf);
        if (!d) fail(400, 'bad_record', `stockValuation #${i}: asOf (YYYY-MM-DD) is required.`);
        return { company_id: cid, as_of: d, total_value: num(r.totalValue) };
      }), r => r.as_of);
      await sql`insert into stock_valuation ${sql(rows)} on conflict (company_id, as_of) do update set total_value = excluded.total_value`;
      break;
    }
    default:
      return fail(400, 'bad_request', 'entity must be one of: ledger, voucher, stockItem, bill, stockValuation.');
  }

  await sql`update sync_runs set stats = jsonb_set(stats, '{applied}', coalesce(stats->'applied', '{}'::jsonb)
              || jsonb_build_object(${entity}::text, coalesce((stats->'applied'->>${entity}::text)::int, 0) + ${records.length}::int)) where id = ${run.id}`;
  return json({ ok: true, applied: records.length });
});
