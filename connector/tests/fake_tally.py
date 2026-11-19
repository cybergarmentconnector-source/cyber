#!/usr/bin/env python3
"""A tiny stand-in for TallyPrime's XML server, for testing the connector without Tally.
Answers the connector's requests from a small in-memory company. NOT a substitute for testing against real Tally.
  python fake_tally.py [port]            admin: GET /__delete?id=v-2   GET /__add   GET /__alter?id=v-1
"""
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

STATE = {"alter": 20, "mst": 1, "vouchers": {}}


def sales(vid, num, date, amount, alter):
    tax = round(amount * 0.18, 2)
    return {"id": vid, "alter": alter, "date": date, "type": "Sales", "num": num, "party": "Acme & Co", "amount": amount, "tax": tax, "kind": "sales"}


def receipt(vid, num, date, amount, ref, alter):
    return {"id": vid, "alter": alter, "date": date, "type": "Receipt", "num": num, "party": "Acme & Co", "amount": amount, "ref": ref, "kind": "receipt"}


STATE["vouchers"] = {
    "v-1": sales("v-1", "S/1", "20250405", 1000.0, 11),
    "v-2": receipt("v-2", "R/1", "20250420", 500.0, "S/1", 12),
    "v-3": sales("v-3", "S/2", "20250611", 2000.0, 13),
}

LEDGERS = [("Acme & Co", "Sundry Debtors", "-5000.00", "-5000.00", "Yes", "L-acme"), ("Sales", "Sales Accounts", "0", "0", "No", "L-sales"),
           ("Output GST", "Duties & Taxes", "0", "0", "No", "L-gst"), ("Cash", "Cash-in-Hand", "-1000.00", "-1000.00", "No", "L-cash")]


def voucher_xml(v):
    head = (f'<VOUCHER VCHTYPE="{v["type"]}" ACTION="Create"><DATE>{v["date"]}</DATE><GUID>{v["id"]}</GUID><VOUCHERTYPENAME>{v["type"]}</VOUCHERTYPENAME>'
            f'<VOUCHERNUMBER>{v["num"]}</VOUCHERNUMBER><PARTYLEDGERNAME>Acme &amp; Co</PARTYLEDGERNAME><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>No</ISOPTIONAL>'
            f'<ALTERID> {v["alter"]}</ALTERID>')
    if v["kind"] == "sales":
        gross = v["amount"] + v["tax"]
        return (head + f'<ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme &amp; Co</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-{gross:.2f}</AMOUNT>'
                f'<BILLALLOCATIONS.LIST><NAME>{v["num"]}</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-{gross:.2f}</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST>'
                f'<ALLLEDGERENTRIES.LIST><LEDGERNAME>Output GST</LEDGERNAME><AMOUNT>{v["tax"]:.2f}</AMOUNT></ALLLEDGERENTRIES.LIST>'
                f'<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Shirt</STOCKITEMNAME><RATE>100.00/Nos</RATE><AMOUNT>{v["amount"]:.2f}</AMOUNT>'
                f'<ACTUALQTY> {v["amount"] / 100:g} Nos</ACTUALQTY><BILLEDQTY> {v["amount"] / 100:g} Nos</BILLEDQTY>'
                f'<BATCHALLOCATIONS.LIST><GODOWNNAME>Main</GODOWNNAME><BATCHNAME>Primary Batch</BATCHNAME></BATCHALLOCATIONS.LIST>'
                f'<ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Sales</LEDGERNAME><AMOUNT>{v["amount"]:.2f}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST></VOUCHER>')
    return (head + f'<ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-{v["amount"]:.2f}</AMOUNT></ALLLEDGERENTRIES.LIST>'
            f'<ALLLEDGERENTRIES.LIST><LEDGERNAME>Acme &amp; Co</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>{v["amount"]:.2f}</AMOUNT>'
            f'<BILLALLOCATIONS.LIST><NAME>{v["ref"]}</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>{v["amount"]:.2f}</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST></VOUCHER>')


def wrap(inner):
    return f'<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION>{inner}</COLLECTION></DATA></BODY></ENVELOPE>'


def answer(req: str) -> str:
    rid = re.search(r"<ID>([^<]+)</ID>", req).group(1)
    frm = (re.search(r"<SVFROMDATE>(\d+)</SVFROMDATE>", req) or [None, "00000000"])[1]
    to = (re.search(r"<SVTODATE>(\d+)</SVTODATE>", req) or [None, "99999999"])[1]
    if rid == "TCCompanies":
        return wrap(f'<COMPANY NAME="Demo Co"><GUID>co-1</GUID><STARTINGFROM>20260401</STARTINGFROM><BOOKSFROM>20240401</BOOKSFROM>'
                    f'<ALTVCHID>{STATE["alter"]}</ALTVCHID><ALTMSTID>{STATE["mst"]}</ALTMSTID></COMPANY>')
    if rid == "TCGroups":
        return wrap("".join(f'<GROUP NAME="{n}"><PARENT>{p}</PARENT></GROUP>' for n, p in
                            [("Sundry Debtors", ""), ("Sales Accounts", ""), ("Duties &amp; Taxes", ""), ("Cash-in-Hand", "Current Assets"), ("Current Assets", "")]))
    if rid == "TCVoucherTypes":
        return wrap('<VOUCHERTYPE NAME="Sales"><PARENT></PARENT></VOUCHERTYPE><VOUCHERTYPE NAME="Receipt"><PARENT></PARENT></VOUCHERTYPE>')
    if rid == "TCLedgers":
        return wrap("".join(f'<LEDGER NAME="{n.replace("&", "&amp;")}"><PARENT>{p.replace("&", "&amp;")}</PARENT><OPENINGBALANCE>{o}</OPENINGBALANCE><CLOSINGBALANCE>{c}</CLOSINGBALANCE>'
                            f'<ISBILLWISEON>{b}</ISBILLWISEON><GUID>{g}</GUID></LEDGER>' for n, p, o, c, b, g in LEDGERS))
    if rid == "TCStock":
        return wrap('<STOCKITEM NAME="Shirt"><GUID>I-1</GUID><PARENT>Garments</PARENT><BASEUNITS>Nos</BASEUNITS><CLOSINGBALANCE> 25 Nos</CLOSINGBALANCE>'
                    '<CLOSINGVALUE>-2500.00</CLOSINGVALUE><CLOSINGRATE>100.00/Nos</CLOSINGRATE></STOCKITEM>')
    if rid in ("TCVouchers", "TCVoucherIds"):
        floor = int((re.search(r"\$AlterID > (\d+)", req) or [None, 0])[1])
        vs = [v for v in STATE["vouchers"].values() if frm <= v["date"] <= to and v["alter"] > floor]
        if rid == "TCVoucherIds":
            return wrap("".join(f'<VOUCHER><GUID>{v["id"]}</GUID></VOUCHER>' for v in vs))
        return wrap("".join(voucher_xml(v) for v in vs))
    if rid in ("Bills Receivable", "Bills Payable"):
        if rid == "Bills Payable":
            return '<ENVELOPE></ENVELOPE>'
        paid = sum(v["amount"] for v in STATE["vouchers"].values() if v["kind"] == "receipt" and v["ref"] == "S/1")
        has = "v-1" in STATE["vouchers"]
        out = ""
        for num, d, gross in (("S/1", "5-Apr-25", 1180.0 - paid if has else 0), ("S/2", "11-Jun-25", 2360.0)):
            if "v-3" not in STATE["vouchers"] and num == "S/2" or gross == 0:
                continue
            out += (f'<BILLFIXED><BILLDATE>{d}</BILLDATE><BILLREF>{num}</BILLREF><BILLPARTY>Acme &amp; Co</BILLPARTY></BILLFIXED>'
                    f'<BILLCL>-{gross:.2f}</BILLCL><BILLDUE>{d}</BILLDUE><BILLOVERDUE>100</BILLOVERDUE>')
        return f"<ENVELOPE><BODY><DATA>{out}</DATA></BODY></ENVELOPE>"
    return "<RESPONSE>Unknown Request, cannot be processed</RESPONSE>"


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, body: bytes, ctype="text/xml"):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/__delete":
            STATE["vouchers"].pop(q["id"][0], None)
            STATE["alter"] += 1
            return self.send(b"deleted", "text/plain")
        if u.path == "/__add":
            STATE["alter"] += 1
            STATE["vouchers"]["v-9"] = sales("v-9", "S/9", "20250815", 3000.0, STATE["alter"])
            return self.send(b"added", "text/plain")
        if u.path == "/__alter":
            STATE["alter"] += 1
            STATE["vouchers"][q["id"][0]]["amount"] += 100.0
            STATE["vouchers"][q["id"][0]]["alter"] = STATE["alter"]
            return self.send(b"altered", "text/plain")
        self.send(b"<RESPONSE>TallyPrime Server is Running</RESPONSE>")

    def do_POST(self):
        from xml.sax.saxutils import unescape
        req = unescape(self.rfile.read(int(self.headers["Content-Length"])).decode("utf-8"))
        self.send(answer(req).encode("utf-8"))


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 9099), H).serve_forever()
