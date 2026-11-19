#!/usr/bin/env python3
"""Tally Cloud Connector.

Reads TallyPrime (XML over HTTP, default http://localhost:9000) and uploads to the Tally Cloud Reporting API.
Read-only: it never writes to Tally. It only holds a per-device token, never a database password.

Commands
  connector.exe run                     keep syncing (what the scheduled task runs)
  connector.exe pair <server> <code>    pair this PC by typing the code from the website
  connector.exe "tallycloud://connect?server=..&code=.."   (the website's "Connect Tally" button)
  connector.exe sync                    one sync pass now, then exit
  connector.exe diagnose                checks Tally, the server and the token
  connector.exe                         (double-click) installs on this PC; afterwards just runs
  connector.exe install                 install: start at logon, tallycloud:// link
  connector.exe selftest                parses built-in sample Tally XML (no Tally or network needed)
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import logging
import logging.handlers
import os
import re
import socket
import sqlite3
import subprocess
import sys
import time
import uuid
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from urllib.parse import parse_qs, urlparse
from xml.sax.saxutils import escape

import requests

VERSION = "1.0.0"
MAX_RECORDS = 500                 # server limit per batch call
MAX_BATCH_BYTES = 2_500_000       # stays under the hosting limit for one request body (4.5 MB)
DEFAULT_TALLY = "http://localhost:9000"

log = logging.getLogger("tallycloud")


class ConnectorError(Exception):
    """An error whose message is safe to show to the user as is."""


class AuthError(ConnectorError):
    pass


class Unavailable(ConnectorError):     # network down / server busy: retry later
    pass


class Rejected(ConnectorError):        # the server refused this request for good
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code = status, code


# ------------------------------------------------------------------ paths, config, logging
def data_dir() -> str:
    base = os.environ.get("TALLYCLOUD_HOME")
    if not base:
        root = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), ".local", "share")
        base = os.path.join(root, "TallyCloudConnector")
    os.makedirs(base, exist_ok=True)
    return base


def setup_logging(console: bool = True) -> None:
    log.setLevel(logging.INFO)
    if log.handlers:
        return
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = logging.handlers.RotatingFileHandler(os.path.join(data_dir(), "connector.log"), maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    fh.setFormatter(fmt)
    log.addHandler(fh)
    if console and sys.stdout:
        ch = logging.StreamHandler(sys.stdout)
        ch.setFormatter(fmt)
        log.addHandler(ch)


def config_path() -> str:
    return os.path.join(data_dir(), "config.json")


def load_config() -> dict:
    try:
        with open(config_path(), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_config(cfg: dict) -> None:
    tmp = config_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, config_path())


# ------------------------------------------------------------------ Tally value parsing
_NUM = re.compile(r"\d[\d,]*\.?\d*|\.\d+")


def parse_amount(text: str | None) -> Decimal:
    """Tally amount -> Decimal, DEBIT POSITIVE / credit negative.
    Plain numbers follow Tally's XML convention (debit is negative); 'Dr' / 'Cr' suffixes are explicit."""
    if text is None:
        return Decimal(0)
    s = text.strip()
    if not s:
        return Decimal(0)
    if "=" in s:                                   # foreign currency: "$ 10 @ Rs 80/$ = Rs 800"
        s = s.split("=")[-1]
    m = _NUM.search(s)
    if not m:
        return Decimal(0)
    try:
        v = Decimal(m.group(0).replace(",", ""))
    except InvalidOperation:
        return Decimal(0)
    sfx = re.search(r"\b(Dr|Cr)\b", s, re.I)
    if sfx:
        return v if sfx.group(1).lower() == "dr" else -v
    neg = "-" in s[: m.start()] or s.lstrip().startswith("(")
    return v if neg else -v                        # Tally: negative = debit  ->  internal: debit positive


def parse_qty(text: str | None) -> tuple[Decimal | None, str | None]:
    """'12 Nos' -> (12, 'Nos'); ' 3.500 Kgs = 3500 Gms' -> (3.5, 'Kgs'). Sign dropped (direction comes from the voucher)."""
    if not text or not text.strip():
        return None, None
    m = re.match(r"\s*-?\s*([\d,]*\.?\d+)\s*([^\d=/\s][^=/]*)?", text)
    if not m:
        return None, None
    try:
        q = Decimal(m.group(1).replace(",", ""))
    except InvalidOperation:
        return None, None
    return q, (m.group(2) or "").strip() or None


def parse_rate(text: str | None) -> tuple[Decimal | None, str | None]:
    """'100.00/Nos' -> (100.00, 'Nos')."""
    if not text or not text.strip():
        return None, None
    m = re.match(r"\s*-?\s*([\d,]*\.?\d+)\s*(?:/\s*(.+))?", text)
    if not m:
        return None, None
    return Decimal(m.group(1).replace(",", "")), (m.group(2) or "").strip() or None


def money(d: Decimal | None) -> str | None:
    return None if d is None else str(d.quantize(Decimal("0.01")))


_DATE_FORMATS = ("%Y%m%d", "%d-%b-%Y", "%d-%b-%y", "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y")


def parse_date(text: str | None) -> date | None:
    if not text:
        return None
    s = text.strip()
    for f in _DATE_FORMATS:
        try:
            return datetime.strptime(s, f).date()
        except ValueError:
            continue
    return None


def iso(d: date | None) -> str | None:
    return d.isoformat() if d else None


def yn(text: str | None) -> bool:
    return (text or "").strip().lower() in ("yes", "true", "1")


# ------------------------------------------------------------------ XML plumbing
_BAD_REF = re.compile(r"&#(?:x([0-9a-fA-F]+)|(\d+));")
_BAD_RAW = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]")
_XML_DECL = re.compile(r"^\s*<\?xml[^>]*\?>")


def decode_response(raw: bytes) -> str:
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16", errors="replace")
    if raw[:3] == b"\xef\xbb\xbf":
        return raw[3:].decode("utf-8", errors="replace")
    if len(raw) > 3 and raw[1:2] == b"\x00" and raw[3:4] == b"\x00":
        return raw.decode("utf-16-le", errors="replace")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


def clean_xml(text: str) -> str:
    """Drops characters XML cannot hold (Tally writes things like &#4;) and the encoding declaration."""
    def ref(m: re.Match) -> str:
        code = int(m.group(1), 16) if m.group(1) else int(m.group(2))
        return "" if code < 32 and code not in (9, 10, 13) else m.group(0)
    text = _BAD_REF.sub(ref, text)
    text = _BAD_RAW.sub("", text)
    return _XML_DECL.sub("", text, count=1)


def parse_xml(raw: bytes) -> ET.Element:
    text = clean_xml(decode_response(raw))
    try:
        return ET.fromstring(text)
    except ET.ParseError as e:
        raise ConnectorError(f"Tally sent a reply the connector could not read ({e}).") from e


def tag(el: ET.Element) -> str:
    return el.tag.upper()


def ctext(el: ET.Element, name: str) -> str:
    """Text of the first direct child called `name` (case-insensitive), stripped."""
    name = name.upper()
    for c in el:
        if tag(c) == name:
            return (c.text or "").strip()
    return ""


def children(el: ET.Element, *names: str) -> list[ET.Element]:
    up = {n.upper() for n in names}
    return [c for c in el if tag(c) in up]


def attr(el: ET.Element, name: str) -> str:
    for k, v in el.attrib.items():
        if k.upper() == name.upper():
            return v.strip()
    return ""


# ------------------------------------------------------------------ Tally client
class Tally:
    def __init__(self, url: str = DEFAULT_TALLY, timeout: int = 600):
        self.url, self.timeout = url.rstrip("/"), timeout
        self.s = requests.Session()

    def status(self) -> tuple[bool, str]:
        """(reachable, human message). Never raises."""
        try:
            r = self.s.get(self.url, timeout=5)
            if "tally" in r.text.lower():
                return True, "TallyPrime is running"
            return False, f"Something is listening at {self.url} but it does not look like TallyPrime."
        except requests.ConnectionError:
            return False, ("TallyPrime is not running, or its connection port is off. Open TallyPrime, press F1 > Settings > Connectivity > "
                           "Client/Server configuration and set TallyPrime acts as: Both, port 9000.")
        except requests.Timeout:
            return False, "TallyPrime did not answer in time. It may be busy; the connector will retry."
        except requests.RequestException as e:
            return False, f"Could not reach TallyPrime: {e}"

    def post(self, xml: str) -> ET.Element:
        try:
            r = self.s.post(self.url, data=xml.encode("utf-8"), headers={"Content-Type": "text/xml; charset=utf-8"}, timeout=self.timeout)
        except requests.RequestException as e:
            raise Unavailable(f"Could not reach TallyPrime: {e}") from e
        root = parse_xml(r.content)
        if tag(root) == "RESPONSE":
            raise ConnectorError(f"TallyPrime refused the request: {(root.text or '').strip()}")
        for e in root.iter("LINEERROR"):
            raise ConnectorError(f"TallyPrime reported: {(e.text or '').strip()}")
        return root


def sv_date(d: date) -> str:
    return d.strftime("%Y%m%d")


def collection_request(coll_id: str, obj_type: str, methods: list[str], company: str | None = None, frm: date | None = None,
                       to: date | None = None, filter_formula: str | None = None, native_all: bool = False) -> str:
    sv = "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>"
    if company:
        sv += f"<SVCURRENTCOMPANY>{escape(company)}</SVCURRENTCOMPANY>"
    if frm:
        sv += f"<SVFROMDATE>{sv_date(frm)}</SVFROMDATE>"
    if to:
        sv += f"<SVTODATE>{sv_date(to)}</SVTODATE>"
    nm = "<NATIVEMETHOD>*.*</NATIVEMETHOD>" if native_all else "".join(f"<NATIVEMETHOD>{m}</NATIVEMETHOD>" for m in methods)
    flt = f"<FILTERS>TCFilter</FILTERS>" if filter_formula else ""
    sysf = f'<SYSTEM TYPE="Formulae" NAME="TCFilter">{escape(filter_formula)}</SYSTEM>' if filter_formula else ""
    return (f"<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>{coll_id}</ID></HEADER>"
            f"<BODY><DESC><STATICVARIABLES>{sv}</STATICVARIABLES><TDL><TDLMESSAGE>"
            f'<COLLECTION NAME="{coll_id}" ISMODIFY="No"><TYPE>{obj_type}</TYPE>{nm}{flt}</COLLECTION>{sysf}'
            f"</TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>")


def report_request(report: str, company: str, frm: date, to: date) -> str:
    return (f"<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>{report}</ID></HEADER>"
            f"<BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>{escape(company)}</SVCURRENTCOMPANY>"
            f"<SVFROMDATE>{sv_date(frm)}</SVFROMDATE><SVTODATE>{sv_date(to)}</SVTODATE><EXPLODEFLAG>Yes</EXPLODEFLAG></STATICVARIABLES></DESC></BODY></ENVELOPE>")


def objects(root: ET.Element, *types: str) -> list[ET.Element]:
    up = {t.upper() for t in types}
    return [e for e in root.iter() if tag(e) in up]


def name_of(el: ET.Element) -> str:
    return attr(el, "NAME") or ctext(el, "NAME")


# ------------------------------------------------------------------ Tally readers
class Company:
    def __init__(self, el: ET.Element):
        self.name = name_of(el)
        self.guid = ctext(el, "GUID")
        self.id = self.guid or self.name
        self.starting_from = parse_date(ctext(el, "STARTINGFROM"))
        self.books_from = parse_date(ctext(el, "BOOKSFROM"))
        self.alt_vch = ctext(el, "ALTVCHID")
        self.alt_mst = ctext(el, "ALTMSTID")
        self.fy_start_month = (self.starting_from or self.books_from or date(2000, 4, 1)).month

    @property
    def change_token(self) -> str | None:
        return f"{self.alt_vch}|{self.alt_mst}" if (self.alt_vch or self.alt_mst) else None


def read_companies(t: Tally) -> list[Company]:
    root = t.post(collection_request("TCCompanies", "Company", ["Name", "GUID", "StartingFrom", "BooksFrom", "AltVchId", "AltMstId"]))
    return [Company(e) for e in objects(root, "COMPANY") if name_of(e)]


def financial_window(fy_start_month: int, years: int, today: date | None = None) -> tuple[date, date]:
    """(first day of the oldest synced FY, last day of the current FY)."""
    today = today or date.today()
    y = today.year if today.month >= fy_start_month else today.year - 1
    start = date(y - (years - 1), fy_start_month, 1)
    end = date(y + 1, fy_start_month, 1) - timedelta(days=1)
    return start, end


def months_between(a: date, b: date) -> list[tuple[date, date]]:
    out, cur = [], date(a.year, a.month, 1)
    while cur <= b:
        nxt = date(cur.year + (cur.month == 12), cur.month % 12 + 1, 1)
        out.append((cur, nxt - timedelta(days=1)))
        cur = nxt
    return out


PRIMARY_KIND = {"sundry debtors": "debtor", "sundry creditors": "creditor"}
REVENUE_GROUPS = {"sales accounts", "purchase accounts"}
TAX_GROUPS = {"duties & taxes"}
BANK_GROUPS = {"bank accounts", "cash-in-hand", "bank od a/c", "bank occ a/c"}
CHARGE_GROUPS = {"direct expenses", "indirect expenses", "direct incomes", "indirect incomes", "expenses (direct)", "expenses (indirect)",
                 "income (direct)", "income (indirect)"}


class Masters:
    """Ledgers, groups and voucher types of one company, with the lookups the voucher parser needs."""

    def __init__(self):
        self.groups: dict[str, str] = {}          # group -> parent
        self.vtypes: dict[str, str] = {}          # voucher type -> parent
        self.ledgers: dict[str, dict] = {}        # name -> record
        self.items: dict[str, str] = {}           # stock item name -> id

    def chain(self, group: str) -> list[str]:
        out, seen = [], set()
        while group and group not in seen:
            out.append(group)
            seen.add(group)
            group = self.groups.get(group, "")
            if group.lower() == "primary":
                break
        return out

    def primary_group(self, group: str) -> str:
        ch = self.chain(group)
        return ch[-1] if ch else ""

    def kind_of(self, group: str) -> str:
        for g in self.chain(group):
            k = PRIMARY_KIND.get(g.lower())
            if k:
                return k
        return "other"

    def base_type(self, vtype: str) -> str:
        seen, cur = set(), vtype
        while cur and cur not in seen:
            seen.add(cur)
            parent = self.vtypes.get(cur, "")
            if not parent or parent.lower() == "primary":
                return cur
            cur = parent
        return vtype

    def ledger_id(self, name: str) -> str | None:
        if not name:
            return None
        rec = self.ledgers.get(name)
        return rec["id"] if rec else f"name:{name}"

    def role_of(self, ledger_name: str, party: str) -> str:
        if party and ledger_name == party:
            return "party"
        rec = self.ledgers.get(ledger_name)
        chain = {g.lower() for g in self.chain(rec["parentGroup"])} if rec else set()   # Cash-in-Hand sits under Current Assets, so check the whole chain
        for names, role in ((REVENUE_GROUPS, "revenue"), (TAX_GROUPS, "tax"), (BANK_GROUPS, "bank"), (CHARGE_GROUPS, "charge")):
            if chain & names:
                return role
        return "other"


def read_masters(t: Tally, co: Company, window_start: date, today: date) -> Masters:
    m = Masters()
    for e in objects(t.post(collection_request("TCGroups", "Group", ["Name", "Parent"], co.name)), "GROUP"):
        m.groups[name_of(e)] = ctext(e, "PARENT")
    for e in objects(t.post(collection_request("TCVoucherTypes", "VoucherType", ["Name", "Parent"], co.name)), "VOUCHERTYPE"):
        m.vtypes[name_of(e)] = ctext(e, "PARENT")

    books = co.books_from or co.starting_from or window_start
    carry = window_start > books          # history before the window is folded into the opening balance
    frm = books
    to = window_start - timedelta(days=1) if carry else today
    root = t.post(collection_request("TCLedgers", "Ledger", ["Name", "Parent", "OpeningBalance", "ClosingBalance", "IsBillWiseOn", "GUID"], co.name, frm, to))
    for e in objects(root, "LEDGER"):
        name = name_of(e)
        if not name:
            continue
        parent = ctext(e, "PARENT")
        kind = m.kind_of(parent)
        opening = parse_amount(ctext(e, "CLOSINGBALANCE") if carry else ctext(e, "OPENINGBALANCE"))
        m.ledgers[name] = {"id": ctext(e, "GUID") or f"name:{name}", "name": name, "parentGroup": parent, "primaryGroup": m.primary_group(parent),
                           "isParty": kind in ("debtor", "creditor"), "isBillWise": yn(ctext(e, "ISBILLWISEON")), "kind": kind, "opening": money(opening)}
    return m


def read_stock(t: Tally, co: Company, today: date, fy_start: date, m: Masters) -> tuple[list[dict], dict]:
    methods = ["Name", "GUID", "Parent", "Category", "BaseUnits", "ClosingBalance", "ClosingValue", "ClosingRate", "StandardPrice"]
    root = t.post(collection_request("TCStock", "StockItem", methods, co.name, fy_start, today))
    items, total = [], Decimal(0)
    for e in objects(root, "STOCKITEM"):
        name = name_of(e)
        if not name:
            continue
        qty, unit = parse_qty(ctext(e, "CLOSINGBALANCE"))
        raw_qty = ctext(e, "CLOSINGBALANCE").strip()
        if qty is not None and raw_qty.startswith("-"):
            qty = -qty
        value = abs(parse_amount(ctext(e, "CLOSINGVALUE"))) if ctext(e, "CLOSINGVALUE") else Decimal(0)
        rate, _ = parse_rate(ctext(e, "CLOSINGRATE"))
        std, _ = parse_rate(ctext(e, "STANDARDPRICE"))
        sid = ctext(e, "GUID") or f"name:{name}"
        m.items[name] = sid
        total += value
        items.append({"id": sid, "name": name, "alias": None, "stockGroup": ctext(e, "PARENT") or None, "category": ctext(e, "CATEGORY") or None,
                      "unit": ctext(e, "BASEUNITS") or unit, "standardPrice": money(std), "avgPurchaseRate": money(rate),
                      "closingQty": str(qty if qty is not None else 0), "closingValue": money(value), "godowns": []})
    return items, {"asOf": iso(today), "totalValue": money(total)}


def parse_voucher(v: ET.Element, m: Masters) -> tuple[dict | None, int, list[dict]]:
    """One <VOUCHER> -> (upload record, alter id, bill allocations)."""
    vid = ctext(v, "GUID") or attr(v, "REMOTEID")
    d = parse_date(ctext(v, "DATE"))
    if not vid or not d:
        return None, 0, []
    alter = int(re.sub(r"\D", "", ctext(v, "ALTERID")) or 0)
    vtype = ctext(v, "VOUCHERTYPENAME") or attr(v, "VCHTYPE")
    party = ctext(v, "PARTYLEDGERNAME")
    cancelled, optional = yn(ctext(v, "ISCANCELLED")), yn(ctext(v, "ISOPTIONAL"))
    base = m.base_type(vtype)

    led = children(v, "ALLLEDGERENTRIES.LIST") or children(v, "LEDGERENTRIES.LIST")
    entries: list[dict] = []
    bills: list[dict] = []
    for le in led:
        name = ctext(le, "LEDGERNAME")
        amt = parse_amount(ctext(le, "AMOUNT"))
        entries.append({"ledgerName": name, "amount": amt})
        if name and name in m.ledgers and m.ledgers[name]["isParty"]:
            for b in children(le, "BILLALLOCATIONS.LIST"):
                bn = ctext(b, "NAME")
                if bn:
                    bills.append({"voucherId": vid, "ledgerId": m.ledger_id(name), "bill": bn, "btype": ctext(b, "BILLTYPE") or "New Ref",
                                  "amount": str(parse_amount(ctext(b, "AMOUNT"))), "baseType": base, "voucherType": vtype, "date": iso(d)})

    items: list[dict] = []
    alloc_total: dict[str, Decimal] = {}
    for ie in children(v, "ALLINVENTORYENTRIES.LIST", "INVENTORYENTRIES.LIST"):
        iname = ctext(ie, "STOCKITEMNAME")
        qty, unit = parse_qty(ctext(ie, "ACTUALQTY") or ctext(ie, "BILLEDQTY"))
        bqty, bunit = parse_qty(ctext(ie, "BILLEDQTY"))
        rate, runit = parse_rate(ctext(ie, "RATE"))
        disc = ctext(ie, "DISCOUNT")
        amount = abs(parse_amount(ctext(ie, "AMOUNT")))
        batches = children(ie, "BATCHALLOCATIONS.LIST")
        common = {"itemId": m.items.get(iname) or (f"name:{iname}" if iname else None), "itemName": iname, "unit": unit or bunit or runit,
                  "rate": money(rate), "discount": money(Decimal(disc)) if re.fullmatch(r"-?\d+(\.\d+)?", disc or "") else None}
        if len(batches) > 1:
            for b in batches:
                bq, _ = parse_qty(ctext(b, "ACTUALQTY") or ctext(b, "BILLEDQTY"))
                bb, _ = parse_qty(ctext(b, "BILLEDQTY"))
                items.append({**common, "qty": str(bq) if bq is not None else None, "billedQty": str(bb) if bb is not None else None,
                              "amount": money(abs(parse_amount(ctext(b, "AMOUNT")))), "godown": ctext(b, "GODOWNNAME") or None, "batch": ctext(b, "BATCHNAME") or None})
        else:
            b = batches[0] if batches else None
            items.append({**common, "qty": str(qty) if qty is not None else None, "billedQty": str(bqty) if bqty is not None else None, "amount": money(amount),
                          "godown": (ctext(b, "GODOWNNAME") if b is not None else "") or None, "batch": (ctext(b, "BATCHNAME") if b is not None else "") or None})
        for aa in children(ie, "ACCOUNTINGALLOCATIONS.LIST"):
            n = ctext(aa, "LEDGERNAME")
            if n:
                alloc_total[n] = alloc_total.get(n, Decimal(0)) + parse_amount(ctext(aa, "AMOUNT"))
    for n, tot in alloc_total.items():          # sales/purchase lines of item invoices live inside the inventory entries
        if not any(e["ledgerName"] == n and abs(e["amount"] - tot) < Decimal("0.01") for e in entries):
            entries.append({"ledgerName": n, "amount": tot})

    out_entries = [{"line": i + 1, "ledgerId": m.ledger_id(e["ledgerName"]), "ledgerName": e["ledgerName"], "amount": money(e["amount"]),
                    "role": m.role_of(e["ledgerName"], party)} for i, e in enumerate(entries)]
    for i, it in enumerate(items):
        it["line"] = i + 1
    balance = sum((e["amount"] for e in entries), Decimal(0))
    party_amt = next((abs(e["amount"]) for e in entries if party and e["ledgerName"] == party), None)
    total = party_amt if party_amt is not None else (max((abs(e["amount"]) for e in entries), default=Decimal(0)))
    rec = {"id": vid, "date": iso(d), "voucherType": vtype, "baseType": base, "voucherNumber": ctext(v, "VOUCHERNUMBER") or None,
           "invoiceNumber": ctext(v, "REFERENCE") or ctext(v, "VOUCHERNUMBER") or None, "partyLedgerId": m.ledger_id(party), "partyName": party or None,
           "partyGstin": ctext(v, "PARTYGSTIN") or ctext(v, "BUYERGSTIN") or None, "narration": ctext(v, "NARRATION") or None, "amount": money(total),
           "cancelled": cancelled, "optional": optional, "unbalanced": (not cancelled) and abs(balance) > Decimal("0.01"),
           "entries": out_entries, "items": items}
    return rec, alter, bills


def read_vouchers(t: Tally, co: Company, m: Masters, frm: date, to: date, after_alter: int | None = None) -> tuple[list[dict], int, list[dict]]:
    flt = f"$AlterID > {int(after_alter)}" if after_alter else None
    root = t.post(collection_request("TCVouchers", "Voucher", [], co.name, frm, to, flt, native_all=True))
    recs, bills, top = [], [], 0
    for v in objects(root, "VOUCHER"):
        rec, alter, b = parse_voucher(v, m)
        if rec:
            recs.append(rec)
            bills.extend(b)
            top = max(top, alter)
    return recs, top, bills


def read_voucher_ids(t: Tally, co: Company, frm: date, to: date) -> set[str]:
    root = t.post(collection_request("TCVoucherIds", "Voucher", ["GUID"], co.name, frm, to))
    return {ctext(v, "GUID") or attr(v, "REMOTEID") for v in objects(root, "VOUCHER")} - {""}


def read_pending_bills(t: Tally, co: Company, m: Masters, today: date, fy_start: date) -> list[dict]:
    """Tally's own pending bills (Bills Receivable / Bills Payable): balance and due date come from Tally."""
    out: list[dict] = []
    for report, direction in (("Bills Receivable", 1), ("Bills Payable", -1)):
        root = t.post(report_request(report, co.name, fy_start, today))
        cur: dict = {}
        for el in root.iter():
            tg = tag(el)
            if tg == "BILLFIXED":
                cur = {"billDate": parse_date(ctext(el, "BILLDATE")), "bill": ctext(el, "BILLREF"), "party": ctext(el, "BILLPARTY")}
            elif tg == "BILLCL" and cur:
                cur["closing"] = parse_amount(el.text)
            elif tg == "BILLDUE" and cur:
                cur["due"] = parse_date(el.text)
            elif tg == "BILLOVERDUE" and cur:
                if cur.get("bill") and cur.get("party"):
                    cur["direction"] = direction
                    out.append(cur)
                cur = {}
    return out


def build_bills(pending: list[dict], allocs: list[sqlite3.Row], m: Masters, today: date) -> list[dict]:
    """Combines Tally's pending list with the bill allocations of synced vouchers (original, settled, adjustments, movements)."""
    by_bill: dict[tuple[str, str], list] = {}
    for a in allocs:
        by_bill.setdefault((a["ledger_id"], a["bill"]), []).append(a)
    out = []
    for p in pending:
        lid = m.ledger_id(p["party"])
        d = p["direction"]
        rows = by_bill.get((lid, p["bill"]), [])
        new = sum((Decimal(r["amount"]) for r in rows if r["btype"].lower() == "new ref"), Decimal(0))
        settled = adj = Decimal(0)
        moves = []
        for r in rows:
            if r["btype"].lower() == "agst ref":
                amt = -d * Decimal(r["amount"])
                if r["base_type"] in ("Receipt", "Payment"):
                    settled += amt
                else:
                    adj += amt
                moves.append({"voucherId": r["voucher_id"], "voucherType": r["voucher_type"]})
        balance = d * p.get("closing", Decimal(0))            # positive = normal direction, negative = advance
        original = d * new if new else balance + settled + adj
        first = min((r["date"] for r in rows if r["date"]), default=None)
        out.append({"ledgerId": lid, "bill": p["bill"], "billDate": iso(p.get("billDate")) or first or iso(today), "dueDate": iso(p.get("due")),
                    "original": money(original), "settled": money(settled), "adjustments": money(adj), "balance": money(balance),
                    "voucherId": next((r["voucher_id"] for r in rows if r["btype"].lower() == "new ref"), None),
                    "isOpening": not new, "isAdvance": balance < 0, "movements": moves})
    return out


# ------------------------------------------------------------------ local state (sqlite) and upload queue
class State:
    def __init__(self, path: str | None = None):
        self.db = sqlite3.connect(path or os.path.join(data_dir(), "state.db"))
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            create table if not exists kv (k text primary key, v text);
            create table if not exists known (company text, id text, month text, primary key (company, id));
            create index if not exists known_month on known (company, month);
            create table if not exists billalloc (company text, voucher_id text, ledger_id text, bill text, btype text, amount text,
                                                   base_type text, voucher_type text, date text);
            create index if not exists billalloc_voucher on billalloc (company, voucher_id);
            create index if not exists billalloc_bill on billalloc (company, ledger_id, bill);""")

    def get(self, k: str, default: str | None = None) -> str | None:
        r = self.db.execute("select v from kv where k = ?", (k,)).fetchone()
        return r["v"] if r else default

    def set(self, k: str, v: str) -> None:
        self.db.execute("insert into kv (k, v) values (?, ?) on conflict (k) do update set v = excluded.v", (k, v))
        self.db.commit()

    def delete_prefix(self, prefix: str) -> None:
        self.db.execute("delete from kv where k like ?", (prefix + "%",))
        self.db.commit()

    def note_vouchers(self, company: str, recs: list[dict]) -> None:
        self.db.executemany("insert into known (company, id, month) values (?, ?, ?) on conflict (company, id) do update set month = excluded.month",
                            [(company, r["id"], r["date"][:7]) for r in recs])
        self.db.commit()

    def known_ids(self, company: str, month: str) -> set[str]:
        return {r["id"] for r in self.db.execute("select id from known where company = ? and month = ?", (company, month))}

    def forget_vouchers(self, company: str, ids: list[str]) -> None:
        for i in range(0, len(ids), 500):
            part = ids[i:i + 500]
            q = ",".join("?" * len(part))
            self.db.execute(f"delete from known where company = ? and id in ({q})", [company, *part])
            self.db.execute(f"delete from billalloc where company = ? and voucher_id in ({q})", [company, *part])
        self.db.commit()

    def drop_allocs(self, company: str, ids: list[str]) -> None:
        for i in range(0, len(ids), 500):
            part = ids[i:i + 500]
            self.db.execute(f"delete from billalloc where company = ? and voucher_id in ({','.join('?' * len(part))})", [company, *part])
        self.db.commit()

    def replace_allocs(self, company: str, voucher_ids: list[str], allocs: list[dict]) -> None:
        for i in range(0, len(voucher_ids), 500):
            part = voucher_ids[i:i + 500]
            self.db.execute(f"delete from billalloc where company = ? and voucher_id in ({','.join('?' * len(part))})", [company, *part])
        self.db.executemany("insert into billalloc values (?,?,?,?,?,?,?,?,?)",
                            [(company, a["voucherId"], a["ledgerId"], a["bill"], a["btype"], a["amount"], a["baseType"], a["voucherType"], a["date"]) for a in allocs])
        self.db.commit()

    def allocs(self, company: str) -> list[sqlite3.Row]:
        return self.db.execute("select * from billalloc where company = ?", (company,)).fetchall()


class Queue:
    """On-disk queue of uploads, delivered strictly in order. Survives restarts and outages."""

    def __init__(self, path: str | None = None):
        self.dir = path or os.path.join(data_dir(), "queue")
        os.makedirs(os.path.join(self.dir, "bad"), exist_ok=True)

    def put(self, op: dict, n: int = 0) -> None:
        name = f"{time.time_ns():020d}-{n}.json.gz"
        tmp = os.path.join(self.dir, name + ".tmp")
        with gzip.open(tmp, "wt", encoding="utf-8") as f:
            json.dump(op, f)
        os.replace(tmp, os.path.join(self.dir, name))

    def files(self) -> list[str]:
        return sorted(f for f in os.listdir(self.dir) if f.endswith(".json.gz"))

    def pending_records(self) -> int:
        total = 0
        for f in self.files():
            try:
                total += int(f.split("-")[1].split(".")[0])
            except (IndexError, ValueError):
                pass
        return total

    def load(self, f: str) -> dict:
        with gzip.open(os.path.join(self.dir, f), "rt", encoding="utf-8") as fh:
            return json.load(fh)

    def remove(self, f: str) -> None:
        os.remove(os.path.join(self.dir, f))

    def quarantine(self, f: str) -> None:
        os.replace(os.path.join(self.dir, f), os.path.join(self.dir, "bad", f))


# ------------------------------------------------------------------ server API
class Api:
    def __init__(self, server: str, token: str | None = None):
        self.base = server.rstrip("/") + "/v1"
        self.token = token
        self.s = requests.Session()

    def call(self, method: str, path: str, payload: dict | None = None, timeout: int = 120, tries: int = 4) -> dict:
        headers = {"User-Agent": f"TallyCloudConnector/{VERSION}"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        delay, last = 1.0, ""
        for attempt in range(tries):
            try:
                r = self.s.request(method, self.base + path, json=payload, headers=headers, timeout=timeout)
            except requests.RequestException as e:
                last = f"could not reach the server ({type(e).__name__})"
            else:
                body = {}
                try:
                    body = r.json()
                except ValueError:
                    pass
                if r.ok:
                    return body
                msg = body.get("message") or f"the server answered {r.status_code}"
                if r.status_code == 401 and self.token:
                    raise AuthError("This PC is no longer paired (the token was removed or is wrong). Pair it again from the website's Sync Status page.")
                if r.status_code in (408, 425, 429) or r.status_code >= 500:
                    last = msg
                else:
                    raise Rejected(r.status_code, body.get("error", "error"), msg)
            if attempt < tries - 1:
                time.sleep(min(delay, 300))
                delay *= 2
        raise Unavailable(f"The server is not reachable right now: {last}")


def split_batches(records: list[dict]) -> list[list[dict]]:
    out, cur, size = [], [], 0
    for r in records:
        n = len(json.dumps(r))
        if cur and (len(cur) >= MAX_RECORDS or size + n > MAX_BATCH_BYTES):
            out.append(cur)
            cur, size = [], 0
        cur.append(r)
        size += n
    if cur:
        out.append(cur)
    return out


# ------------------------------------------------------------------ the engine
class Engine:
    def __init__(self, cfg: dict, state: State | None = None, queue: Queue | None = None):
        self.cfg = cfg
        self.state = state or State()
        self.queue = queue or Queue()
        self.api = Api(cfg["server"], cfg.get("token"))
        self.tally = Tally(cfg.get("tallyUrl") or DEFAULT_TALLY)
        self.years = 3
        self.interval = 300
        self.tally_status: tuple[bool, str] = (False, "Not checked yet")
        self.offline = False          # set when an upload failed; uploads are not retried again until the next cycle

    # ---- uploads
    def heartbeat(self) -> None:
        self.tally_status = self.tally.status()
        out = self.api.call("POST", "/connector/heartbeat", {"tally": {"ok": self.tally_status[0], "message": self.tally_status[1]},
                                                            "pendingRecords": self.queue.pending_records(), "connectorVersion": VERSION}, tries=2)
        self.years = int(out.get("yearsToSync") or 3)
        self.interval = int(out.get("syncIntervalSec") or 300)
        self.offline = False

    def flush(self) -> bool:
        """Delivers queued uploads in order. True when the queue is empty."""
        for f in self.queue.files():
            op = self.queue.load(f)
            key = op.get("run")
            try:
                if self.state.get(f"dead:{key}") and op["op"] != "fail":
                    log.warning("Dropping an upload that belongs to a sync run the server closed (it will be redone next time).")
                    self.queue.remove(f)
                    continue
                self.deliver(op)
            except Rejected as e:
                log.error("The server rejected an upload (%s): %s", e.code, e)
                self.state.set(f"dead:{key}", "1")
                self.queue.quarantine(f) if e.status == 400 and op["op"] == "batch" else self.queue.remove(f)
                if op["op"] != "fail" and self.state.get(f"run:{key}"):
                    try:
                        self.api.call("POST", f"/connector/runs/{self.state.get(f'run:{key}')}/fail", {"error": f"Upload rejected: {e}"}, tries=2)
                    except ConnectorError:
                        pass
                continue
            self.queue.remove(f)
        return not self.queue.files()

    def deliver(self, op: dict) -> None:
        key, kind = op.get("run"), op["op"]
        if kind == "start":
            out = self.api.call("POST", "/connector/runs", op["payload"])
            self.state.set(f"run:{key}", out["runId"])
            return
        run_id = self.state.get(f"run:{key}")
        if not run_id:
            log.warning("Dropping an upload without a sync run.")
            return
        if kind == "batch":
            self.api.call("POST", f"/connector/runs/{run_id}/batch", {"entity": op["entity"], "records": op["records"]})
            if op["entity"] == "voucher":
                self.state.note_vouchers(op["company"], op["records"])
                self.state.replace_allocs(op["company"], [r["id"] for r in op["records"]], op.get("allocs", []))
        elif kind == "commit":
            self.api.call("POST", f"/connector/runs/{run_id}/commit", op["payload"])
            for k, v in (op.get("meta") or {}).items():
                self.state.set(k, v)
            if op.get("forget"):
                self.state.forget_vouchers(op["company"], op["forget"])
            log.info("Published %s for %s.", op.get("what", "a sync"), op.get("name", ""))
        elif kind == "fail":
            self.api.call("POST", f"/connector/runs/{run_id}/fail", op["payload"])

    # ---- sync one company
    def _start(self, run: str, co: Company, kind: str) -> None:
        self.queue.put({"op": "start", "run": run, "payload": {
            "companyId": co.id, "companyName": co.name, "kind": kind, "booksFrom": iso(co.books_from or co.starting_from),
            "fyStartMonth": co.fy_start_month, "baseCurrency": "INR"}})

    def _batches(self, run: str, co: Company, entity: str, records: list[dict], allocs: list[dict] | None = None) -> None:
        for part in split_batches(records):
            op = {"op": "batch", "run": run, "company": co.id, "entity": entity, "records": part}
            if entity == "voucher":
                ids = {r["id"] for r in part}
                op["allocs"] = [a for a in (allocs or []) if a["voucherId"] in ids]
            self.queue.put(op, len(part))

    def sync_company(self, co: Company, force_full: bool = False) -> None:
        win_start, win_end = financial_window(co.fy_start_month, self.years)
        today = date.today()
        fy_start = financial_window(co.fy_start_month, 1)[0]
        last_full = self.state.get(f"full:{co.id}:{self.years}")
        token = co.change_token
        if not force_full and last_full and token and self.state.get(f"chg:{co.id}") == token:
            log.info("%s: nothing changed in Tally.", co.name)
            return
        kind = "full" if (force_full or not last_full) else "incremental"
        after = None if kind == "full" else int(self.state.get(f"alter:{co.id}", "0") or 0)
        run = uuid.uuid4().hex
        log.info("%s: starting a %s sync (%s to %s).", co.name, kind, win_start, win_end)
        self._start(run, co, kind)
        try:
            masters = read_masters(self.tally, co, win_start, today)
            ledgers = list(masters.ledgers.values())
            stock, valuation = read_stock(self.tally, co, today, fy_start, masters)
            lh = hashlib.sha1(json.dumps([ledgers, stock], sort_keys=True).encode()).hexdigest()
            if kind == "full" or self.state.get(f"mh:{co.id}") != lh:
                self._batches(run, co, "ledger", ledgers)
                self._batches(run, co, "stockItem", stock)
            self._batches(run, co, "stockValuation", [valuation])

            top, allocs_all = after or 0, []
            if kind == "full":
                for a, b in months_between(win_start, win_end):
                    recs, mx, allocs = read_vouchers(self.tally, co, masters, a, b)
                    top = max(top, mx)
                    self._batches(run, co, "voucher", recs, allocs)
                    if recs:
                        log.info("%s: read %d vouchers for %s", co.name, len(recs), a.strftime("%b %Y"))
                    self._try_flush()
            else:
                recs, mx, allocs = read_vouchers(self.tally, co, masters, win_start, win_end, after)
                top = max(top, mx)
                self._batches(run, co, "voucher", recs, allocs)
                log.info("%s: %d changed vouchers", co.name, len(recs))

            replace = False
            try:
                self._try_flush()     # bill allocations of this run's vouchers must be stored before bills are built
                pending = read_pending_bills(self.tally, co, masters, today, fy_start)
                self._batches(run, co, "bill", build_bills(pending, self.state.allocs(co.id), masters, today))
                replace = True
            except ConnectorError as e:
                log.warning("%s: pending bills could not be read (%s). The previous bill list stays.", co.name, e)

            meta = {f"alter:{co.id}": str(top), f"mh:{co.id}": lh, f"full:{co.id}:{self.years}": "1"}
            if token:
                meta[f"chg:{co.id}"] = token
            self.queue.put({"op": "commit", "run": run, "company": co.id, "name": co.name, "what": f"{kind} sync",
                            "payload": {"deleted": {"voucher": []}, "replaceBills": replace, "stats": {}}, "meta": meta})
        except Unavailable as e:
            self.queue.put({"op": "fail", "run": run, "payload": {"error": f"TallyPrime stopped answering: {e}"}})
            raise
        except ConnectorError as e:
            self.queue.put({"op": "fail", "run": run, "payload": {"error": str(e)[:900]}})
            raise

    def reconcile_company(self, co: Company) -> None:
        """Compares Tally's voucher ids with what was uploaded; ids missing in Tally are sent as deleted, missing ones are re-read."""
        win_start, win_end = financial_window(co.fy_start_month, self.years)
        today = date.today()
        run = uuid.uuid4().hex
        self._start(run, co, "reconcile")
        try:
            masters = None
            gone: list[str] = []
            for a, b in months_between(win_start, min(win_end, today + timedelta(days=366))):
                month = a.strftime("%Y-%m")
                now_ids, had = read_voucher_ids(self.tally, co, a, b), self.state.known_ids(co.id, month)
                gone += sorted(had - now_ids)
                if now_ids - had:
                    masters = masters or read_masters(self.tally, co, win_start, today)
                    recs, _, allocs = read_vouchers(self.tally, co, masters, a, b)
                    self._batches(run, co, "voucher", [r for r in recs if r["id"] not in had], allocs)
            replace = False
            if gone:                    # deleted vouchers change settled amounts: rebuild the pending-bill snapshot too
                self.state.drop_allocs(co.id, gone)
                masters = masters or read_masters(self.tally, co, win_start, today)
                fy_start = financial_window(co.fy_start_month, 1)[0]
                try:
                    pending = read_pending_bills(self.tally, co, masters, today, fy_start)
                    self._batches(run, co, "bill", build_bills(pending, self.state.allocs(co.id), masters, today))
                    replace = True
                except ConnectorError as e:
                    log.warning("%s: pending bills could not be refreshed (%s).", co.name, e)
            self.queue.put({"op": "commit", "run": run, "company": co.id, "name": co.name, "what": "reconcile",
                            "payload": {"deleted": {"voucher": gone}, "replaceBills": replace, "stats": {}}, "forget": gone, "meta": {f"recon:{co.id}": str(int(time.time()))}})
            if gone:
                log.info("%s: %d voucher(s) were deleted in Tally.", co.name, len(gone))
        except ConnectorError as e:
            self.queue.put({"op": "fail", "run": run, "payload": {"error": str(e)[:900]}})
            raise

    def _try_flush(self) -> None:
        if self.offline:
            return
        try:
            self.flush()
        except Unavailable as e:
            self.offline = True
            log.warning("%s Uploads are kept on this PC and will be sent automatically.", e)

    # ---- one pass over all companies
    def sync_once(self, force_full: bool = False) -> None:
        ok, msg = self.tally.status()
        self.tally_status = (ok, msg)
        if not ok:
            log.info("Skipping this round: %s", msg)
            return
        try:
            companies = read_companies(self.tally)
        except ConnectorError as e:
            log.error("Could not list the open companies: %s", e)
            return
        want = {w.lower() for w in (self.cfg.get("companies") or [])}
        if not companies:
            log.info("No company is open in TallyPrime. Open a company and the connector will pick it up.")
        for co in companies:
            if want and co.name.lower() not in want and co.id.lower() not in want:
                continue
            try:
                self.sync_company(co, force_full)
                last = int(self.state.get(f"recon:{co.id}", "0") or 0)
                if self.state.get(f"full:{co.id}:{self.years}") and time.time() - last > 86_400:
                    self.reconcile_company(co)
            except Unavailable as e:
                log.warning("%s: %s", co.name, e)
            except ConnectorError as e:
                log.error("%s: %s", co.name, e)
            except Exception:                                   # never let one company stop the others
                log.exception("%s: unexpected problem while syncing", co.name)
        self._try_flush()


# ------------------------------------------------------------------ commands
def single_instance():
    path = os.path.join(data_dir(), "connector.lock")
    fh = open(path, "a+")
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return None
    return fh


def cmd_run(args) -> int:
    lock = single_instance()
    if lock is None:
        log.info("The connector is already running.")
        return 0
    log.info("Tally Cloud Connector %s started. Data folder: %s", VERSION, data_dir())
    engine, mtime, next_sync, stop_after = None, 0.0, 0.0, args.cycles
    while True:
        try:
            cfg_m = os.path.getmtime(config_path()) if os.path.exists(config_path()) else 0.0
            if cfg_m != mtime:
                mtime, cfg = cfg_m, load_config()
                engine = Engine(cfg) if cfg.get("token") and cfg.get("server") else None
                next_sync = 0.0
            if engine is None:
                log.info("Not paired yet. Use the website's Connect Tally button, or: connector.exe pair <server> <code>")
            else:
                engine.offline = False
                try:
                    engine.heartbeat()
                except Unavailable as e:       # internet or server down: keep reading Tally into the on-disk queue
                    engine.offline = True
                    log.warning("%s", e)
                engine._try_flush()
                if time.time() >= next_sync:
                    engine.sync_once()
                    next_sync = time.time() + engine.interval
                if not engine.offline:
                    try:
                        engine.heartbeat()
                    except Unavailable:
                        pass
        except AuthError as e:
            log.error("%s", e)
            engine, mtime = None, os.path.getmtime(config_path()) if os.path.exists(config_path()) else 0.0
        except Unavailable as e:
            log.warning("%s", e)
        except Exception:
            log.exception("Unexpected problem; the connector keeps running.")
        if stop_after:
            stop_after -= 1
            if stop_after <= 0:
                return 0
        time.sleep(60)


def pair(server: str, code: str, site: str | None = None) -> int:
    server = server.rstrip("/")
    log.info("Pairing this PC with %s ...", server)
    try:
        out = Api(server).call("POST", "/connector/pair", {"code": code, "deviceName": socket.gethostname(), "connectorVersion": VERSION}, tries=3)
    except Rejected as e:
        log.error("%s", e)
        return 2
    except ConnectorError as e:
        log.error("%s", e)
        return 4
    cfg = load_config()
    cfg.update({"server": server, "token": out["token"], "deviceId": out["deviceId"]})
    if site:
        cfg["site"] = site
    save_config(cfg)
    log.info("Paired. This PC will now sync Tally in the background.")
    return 0


def start_background_task() -> None:
    if os.name == "nt":
        try:
            subprocess.run(["schtasks", "/Run", "/TN", "Tally Cloud Connector"], capture_output=True, timeout=20)
        except (OSError, subprocess.SubprocessError):
            pass


def cmd_pair(args) -> int:
    rc = pair(args.server, args.code)
    if rc == 0:
        start_background_task()
    return rc


def cmd_url(url: str) -> int:
    u = urlparse(url)
    q = parse_qs(u.query)
    server, code, site = (q.get(k, [""])[0] for k in ("server", "code", "site"))
    if u.scheme != "tallycloud" or not server or not code:
        log.error("That link is not a valid Tally Cloud setup link.")
        return 2
    if not server.lower().startswith(("https://", "http://localhost", "http://127.0.0.1")):
        log.error("For safety the connector only pairs with https servers.")
        return 2
    rc = pair(server, code, site)
    if rc == 0:
        start_background_task()
        if os.name == "nt":
            time.sleep(4)          # let the person read the window
    return rc


TASK_NAME = "Tally Cloud Connector"


def launcher_vbs(exe: str) -> str:
    return f'CreateObject("WScript.Shell").Run """{exe}"" run", 0, False\r\n'      # runs hidden: no black window at logon


def task_xml(vbs: str) -> str:
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
    <TimeTrigger><Repetition><Interval>PT15M</Interval></Repetition><StartBoundary>2024-01-01T00:00:00</StartBoundary><Enabled>true</Enabled></TimeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>"{escape(vbs)}"</Arguments></Exec></Actions>
</Task>
"""


def install_dir() -> str:
    return os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "TallyCloudConnector")


def cmd_install(args=None) -> int:
    """Windows: copies this exe to %LOCALAPPDATA%, registers tallycloud://, and creates the start-at-logon task. No admin rights needed."""
    if os.name != "nt":
        log.error("Install is for Windows PCs.")
        return 1
    import shutil
    import winreg
    d = install_dir()
    os.makedirs(d, exist_ok=True)
    target = os.path.join(d, "connector.exe")
    subprocess.run(["schtasks", "/End", "/TN", TASK_NAME], capture_output=True)
    subprocess.run(["taskkill", "/F", "/FI", f"IMAGENAME eq connector.exe", "/FI", f"PID ne {os.getpid()}"], capture_output=True)
    time.sleep(1)
    if os.path.abspath(sys.executable) != os.path.abspath(target):
        shutil.copy2(sys.executable, target)
    base = r"Software\Classes\tallycloud"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base) as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, "URL:Tally Cloud Connector")
        winreg.SetValueEx(k, "URL Protocol", 0, winreg.REG_SZ, "")
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, base + r"\shell\open\command") as k:
        winreg.SetValueEx(k, "", 0, winreg.REG_SZ, f'"{target}" "%1"')
    vbs = os.path.join(d, "run-hidden.vbs")
    with open(vbs, "w", encoding="ascii", errors="replace") as f:
        f.write(launcher_vbs(target))
    xml = os.path.join(d, "task.xml")
    with open(xml, "w", encoding="utf-16") as f:
        f.write(task_xml(vbs))
    r = subprocess.run(["schtasks", "/Create", "/TN", TASK_NAME, "/XML", xml, "/F"], capture_output=True, text=True)
    if r.returncode != 0:
        log.error("Could not create the start-up task: %s", (r.stderr or r.stdout).strip())
        return 1
    subprocess.run(["schtasks", "/Run", "/TN", TASK_NAME], capture_output=True)
    print("\nTally Cloud Connector is installed and running in the background.")
    print("Go back to the website and press 'Connect Tally' (Sync Status page).")
    print(f"Log file: {os.path.join(d, 'connector.log')}\n")
    time.sleep(6)
    return 0


def cmd_sync(args) -> int:
    cfg = load_config()
    if not cfg.get("token"):
        log.error("This PC is not paired yet.")
        return 2
    eng = Engine(cfg)
    try:
        try:
            eng.heartbeat()
        except Unavailable as e:
            eng.offline = True
            log.warning("%s", e)
        eng._try_flush()                       # deliver anything left over from an earlier outage first
        eng.sync_once(force_full=args.full)
        eng._try_flush()
    except ConnectorError as e:
        log.error("%s", e)
        return 4
    return 0


def cmd_diagnose(args) -> int:
    cfg = load_config()
    t = Tally(cfg.get("tallyUrl") or DEFAULT_TALLY, timeout=120)
    bad = 0
    print(f"Tally Cloud Connector {VERSION}   data folder: {data_dir()}")
    ok, msg = t.status()
    print(f"[{'OK' if ok else 'FAIL'}] Tally reachable at {t.url}: {msg}")
    bad += not ok
    if ok:
        try:
            cos = read_companies(t)
            print(f"[{'OK' if cos else 'FAIL'}] Companies open in Tally: {', '.join(c.name for c in cos) or 'none. Open a company in TallyPrime.'}")
            bad += not cos
            for co in cos[:3]:
                try:
                    start, _ = financial_window(co.fy_start_month, 1)
                    m = read_masters(t, co, start, date.today())
                    stock, _ = read_stock(t, co, date.today(), start, m)
                    vids = len(read_voucher_ids(t, co, date.today().replace(day=1), date.today()))
                    print(f"      {co.name}: {len(m.ledgers)} ledgers, {len(stock)} stock items, {vids} vouchers this month")
                except ConnectorError as e:
                    print(f"[FAIL] {co.name}: {e}")
                    bad += 1
        except ConnectorError as e:
            print(f"[FAIL] Reading companies: {e}")
            bad += 1
    if not cfg.get("server"):
        print("[FAIL] This PC is not paired yet (no server in config.json).")
        return 2
    api = Api(cfg["server"], cfg.get("token"))
    try:
        requests.get(cfg["server"].rstrip("/") + "/v1/health", timeout=15).raise_for_status()
        print(f"[OK] Server reachable: {cfg['server']}")
    except requests.RequestException as e:
        print(f"[FAIL] Server not reachable: {e}")
        return 4
    try:
        who = api.call("GET", "/connector/whoami", tries=1)
        print(f"[OK] Token is valid (device: {who.get('name')})")
    except ConnectorError as e:
        print(f"[FAIL] Token: {e}")
        bad += 1
    print(f"Waiting to upload: {Queue().pending_records()} record(s)")
    return 1 if bad else 0


SAMPLE_VOUCHERS = """<ENVELOPE><BODY><DATA><COLLECTION>
<VOUCHER VCHTYPE="Sales" ACTION="Create"><DATE>20250405</DATE><GUID>v-1</GUID><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><VOUCHERNUMBER>S/1</VOUCHERNUMBER>
<PARTYLEDGERNAME>Acme &amp; Co</PARTYLEDGERNAME><NARRATION>Test&#4; sale</NARRATION><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL><ALTERID> 42</ALTERID>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme &amp; Co</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1180.00</AMOUNT>
<BILLALLOCATIONS.LIST><NAME>S/1</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-1180.00</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>
<ALLLEDGERENTRIES.LIST><LEDGERNAME>Output GST</LEDGERNAME><AMOUNT>180.00</AMOUNT></ALLLEDGERENTRIES.LIST>
<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Shirt</STOCKITEMNAME><RATE>100.00/Nos</RATE><AMOUNT>1000.00</AMOUNT><ACTUALQTY> 10 Nos</ACTUALQTY><BILLEDQTY> 10 Nos</BILLEDQTY>
<BATCHALLOCATIONS.LIST><GODOWNNAME>Main</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME></BATCHALLOCATIONS.LIST>
<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>1000.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST></VOUCHER>
</COLLECTION></DATA></BODY></ENVELOPE>"""


def cmd_selftest(args) -> int:
    assert parse_amount("-1234.50") == Decimal("1234.50"), "plain negative = debit"
    assert parse_amount("1,234.50 Dr") == Decimal("1234.50") and parse_amount("1,234.50 Cr") == Decimal("-1234.50")
    assert parse_amount("500") == Decimal("-500")
    assert parse_qty("12 Nos") == (Decimal(12), "Nos") and parse_rate("100.00/Nos") == (Decimal("100.00"), "Nos")
    assert months_between(date(2024, 4, 1), date(2024, 6, 30))[1] == (date(2024, 5, 1), date(2024, 5, 31))
    assert financial_window(4, 3, date(2025, 2, 10)) == (date(2022, 4, 1), date(2025, 3, 31))
    m = Masters()
    m.groups.update({"Sundry Debtors": "", "Sales Accounts": "", "Duties & Taxes": ""})
    m.vtypes["Sales"] = ""
    for n, g in (("Acme & Co", "Sundry Debtors"), ("Sales", "Sales Accounts"), ("Output GST", "Duties & Taxes")):
        m.ledgers[n] = {"id": f"L-{n}", "name": n, "parentGroup": g, "primaryGroup": g, "isParty": g == "Sundry Debtors", "isBillWise": True, "kind": m.kind_of(g), "opening": "0.00"}
    m.items["Shirt"] = "I-1"
    root = parse_xml(SAMPLE_VOUCHERS.encode("utf-16"))
    rec, alter, bills = parse_voucher(objects(root, "VOUCHER")[0], m)
    assert rec and alter == 42 and rec["baseType"] == "Sales" and rec["amount"] == "1180.00" and not rec["unbalanced"], rec
    assert [e["role"] for e in rec["entries"]] == ["party", "tax", "revenue"], rec["entries"]
    assert rec["entries"][0]["amount"] == "1180.00" and rec["entries"][2]["amount"] == "-1000.00"
    assert rec["items"][0]["qty"] == "10" and rec["items"][0]["godown"] == "Main" and rec["items"][0]["itemId"] == "I-1"
    assert bills and bills[0]["btype"] == "New Ref"
    ET.fromstring(task_xml(r"C:\\Users\\A & B\\run-hidden.vbs").split("?>", 1)[1])      # the task definition must be well-formed XML
    assert launcher_vbs(r"C:\x\connector.exe").startswith('CreateObject("WScript.Shell").Run """C:')
    print("Self-test passed: amounts, quantities, dates, bad characters, UTF-16 and voucher parsing all work.")
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    setup_logging()
    if argv and argv[0].lower().startswith("tallycloud:"):
        return cmd_url(argv[0])
    p = argparse.ArgumentParser(prog="connector", description="Tally Cloud Connector")
    sub = p.add_subparsers(dest="cmd")
    r = sub.add_parser("run", help="keep syncing")
    r.add_argument("--cycles", type=int, default=0, help=argparse.SUPPRESS)
    pr = sub.add_parser("pair", help="pair with a code from the website")
    pr.add_argument("server")
    pr.add_argument("code")
    s = sub.add_parser("sync", help="sync once and exit")
    s.add_argument("--full", action="store_true", help="re-read everything")
    sub.add_parser("diagnose")
    sub.add_parser("selftest")
    sub.add_parser("install", help="install on this Windows PC (start at logon, tallycloud:// link)")
    if not argv and getattr(sys, "frozen", False) and os.name == "nt" and \
            os.path.dirname(os.path.abspath(sys.executable)).lower() != install_dir().lower():
        argv = ["install"]                     # double-clicked from Downloads: install instead of running from there
    a = p.parse_args(argv or ["run"])
    cmd = a.cmd or "run"
    if cmd == "run" and not hasattr(a, "cycles"):
        a.cycles = 0
    try:
        return {"run": cmd_run, "pair": cmd_pair, "sync": cmd_sync, "diagnose": cmd_diagnose, "selftest": cmd_selftest, "install": cmd_install}[cmd](a)
    except KeyboardInterrupt:
        return 0
    except ConnectorError as e:
        log.error("%s", e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
