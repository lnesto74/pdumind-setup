"""Customer hall report — same method and visual language as Hyperspace executive PDFs.

Hyperspace (`EsselungaExecutivePdf.js`) draws a light A4 with PDFKit:
Helvetica, navy header, paper ink/muted/faint, KPI cards, verdict strip,
bar chart, two-column table + insights, definitions, centred footer.

This module does the same with ReportLab (PDFKit's Python equivalent: vector
PDF, built-in Helvetica, streamed as application/pdf — not HTML-print).
"""
from __future__ import annotations

from datetime import datetime
from io import BytesIO
from typing import Any, Dict, List, Optional

from reportlab.lib.colors import HexColor
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas as pdfcanvas

A4_W, A4_H = 595.28, 841.89
MARGIN = 40
CONTENT_W = A4_W - MARGIN * 2

INK = HexColor("#111827")
MUTED = HexColor("#6b7280")
FAINT = HexColor("#9ca3af")
RULE = HexColor("#e5e7eb")
PANEL = HexColor("#f9fafb")
GOOD = HexColor("#047857")
BAD = HexColor("#b91c1c")
WARN = HexColor("#b45309")
ACCENT = HexColor("#0e7490")
NAVY = HexColor("#0f172a")
SLATE = HexColor("#94a3b8")
SLATE2 = HexColor("#e2e8f0")
SLATE3 = HexColor("#64748b")
SLATE4 = HexColor("#475569")
WHITE = HexColor("#ffffff")
BODY = HexColor("#374151")
GRID = HexColor("#f3f4f6")
BAR = HexColor("#0891b2")
BAR_WARN = HexColor("#f59e0b")

TONE = {
    "good": {"fill": HexColor("#ecfdf5"), "stroke": HexColor("#a7f3d0"), "text": GOOD, "label": "On track"},
    "warn": {"fill": HexColor("#fffbeb"), "stroke": HexColor("#fde68a"), "text": WARN, "label": "Watch"},
    "bad": {"fill": HexColor("#fef2f2"), "stroke": HexColor("#fecaca"), "text": BAD, "label": "Action needed"},
    "info": {"fill": HexColor("#eff6ff"), "stroke": HexColor("#bfdbfe"), "text": ACCENT, "label": "No comparison"},
}


def _fmt(v, d=1) -> str:
    try:
        if v is None or (isinstance(v, float) and v != v):
            return "—"
        n = float(v)
        if d == 0:
            return f"{int(round(n)):,}"
        return f"{n:,.{d}f}"
    except (TypeError, ValueError):
        return "—"


def _slug(name: str) -> str:
    keep = "".join(c if c.isalnum() else "-" for c in (name or "hall").lower())
    return keep.strip("-") or "hall"


def hall_report_filename(hall_name: str, when: Optional[datetime] = None) -> str:
    day = (when or datetime.now()).strftime("%Y-%m-%d")
    return f"pdumind-hall-{_slug(hall_name)}-{day}.pdf"


def _wrap(text: str, font: str, size: float, width: float) -> List[str]:
    words = str(text or "").split()
    if not words:
        return [""]
    lines: List[str] = []
    cur = ""
    for w in words:
        trial = (cur + " " + w).strip()
        if stringWidth(trial, font, size) <= width:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


class Doc:
    """Thin PDFKit-like adapter: y grows downward from the top of the page."""

    def __init__(self):
        self.buf = BytesIO()
        self.c = pdfcanvas.Canvas(self.buf, pagesize=(A4_W, A4_H))
        self._font = "Helvetica"
        self._size = 10
        self.page_no = 0
        self._add_page()

    def _add_page(self):
        if self.page_no:
            self.c.showPage()
        self.page_no += 1

    def add_page(self):
        self._add_page()

    def _baseline(self, y_top: float) -> float:
        return A4_H - y_top - self._size

    def set_font(self, name: str, size: float):
        self._font = name
        self._size = size
        self.c.setFont(name, size)

    def text(self, s: str, x: float, y: float, width: Optional[float] = None, align: str = "left"):
        s = str(s or "")
        self.c.setFont(self._font, self._size)
        w = stringWidth(s, self._font, self._size)
        b = self._baseline(y)
        if align == "right" and width is not None:
            self.c.drawString(x + width - w, b, s)
        elif align == "center" and width is not None:
            self.c.drawCentredString(x + width / 2, b, s)
        else:
            self.c.drawString(x, b, s)

    def text_block(self, s: str, x: float, y: float, width: float, leading: Optional[float] = None) -> float:
        leading = leading or (self._size + 3)
        lines = _wrap(s, self._font, self._size, width)
        for i, line in enumerate(lines):
            self.text(line, x, y + i * leading)
        return y + len(lines) * leading

    def height_of_string(self, s: str, width: float) -> float:
        lines = _wrap(s, self._font, self._size, width)
        return max(1, len(lines)) * (self._size + 3)

    def fill_rect(self, x, y, w, h, color):
        self.c.setFillColor(color)
        self.c.rect(x, A4_H - y - h, w, h, stroke=0, fill=1)

    def round_rect(self, x, y, w, h, r, fill=None, stroke=None, lw=0.75):
        if fill is not None:
            self.c.setFillColor(fill)
        if stroke is not None:
            self.c.setStrokeColor(stroke)
            self.c.setLineWidth(lw)
        self.c.roundRect(x, A4_H - y - h, w, h, r, stroke=1 if stroke is not None else 0, fill=1 if fill is not None else 0)

    def line(self, x1, y1, x2, y2, color=RULE, lw=0.5):
        self.c.setStrokeColor(color)
        self.c.setLineWidth(lw)
        self.c.line(x1, A4_H - y1, x2, A4_H - y2)


def _stamp_footer(doc: Doc, page_no: int):
    doc.set_font("Helvetica", 6.5)
    doc.c.setFillColor(FAINT)
    doc.text(
        f"PDUMind · customer hall analytics · page {page_no}",
        MARGIN, A4_H - 36, width=CONTENT_W, align="center",
    )


def _draw_header(doc: Doc, venue: str, range_label: str, generated: str) -> float:
    doc.fill_rect(0, 0, A4_W, 68, NAVY)
    doc.c.setFillColor(WHITE)
    doc.set_font("Helvetica-Bold", 15)
    doc.text(venue, MARGIN, 20, width=CONTENT_W - 150)
    doc.c.setFillColor(SLATE)
    doc.set_font("Helvetica", 9)
    doc.text(range_label, MARGIN, 40, width=CONTENT_W - 150)
    doc.c.setFillColor(SLATE2)
    doc.set_font("Helvetica-Bold", 8)
    doc.text("PDUMIND", A4_W - MARGIN - 150, 22, width=150, align="right")
    doc.c.setFillColor(SLATE3)
    doc.set_font("Helvetica", 7)
    doc.text("Executive report · Power", A4_W - MARGIN - 150, 34, width=150, align="right")
    doc.c.setFillColor(SLATE4)
    doc.set_font("Helvetica", 6.5)
    doc.text(f"Generated {generated}", A4_W - MARGIN - 150, 45, width=150, align="right")
    return 88


def _draw_verdict(doc: Doc, tone_key: str, text: str, y: float) -> float:
    tone = TONE.get(tone_key) or TONE["info"]
    doc.set_font("Helvetica", 10)
    text_h = doc.height_of_string(text, CONTENT_W - 28)
    box_h = text_h + 30
    doc.round_rect(MARGIN, y, CONTENT_W, box_h, 4, fill=tone["fill"], stroke=tone["stroke"], lw=0.75)
    doc.fill_rect(MARGIN, y + 1, 3, box_h - 2, tone["text"])
    doc.c.setFillColor(tone["text"])
    doc.set_font("Helvetica-Bold", 7)
    doc.text(tone["label"].upper(), MARGIN + 14, y + 9)
    doc.c.setFillColor(INK)
    doc.set_font("Helvetica", 10)
    doc.text_block(text, MARGIN + 14, y + 21, CONTENT_W - 28)
    return y + box_h + 14


def _draw_kpi_cards(doc: Doc, items: List[Dict[str, Any]], y: float) -> float:
    if not items:
        return y
    per_row = len(items) if len(items) <= 4 else 3
    gap = 10
    card_w = (CONTENT_W - gap * (per_row - 1)) / per_row
    card_h = 62
    row = 0
    for i, kpi in enumerate(items):
        if i > 0 and i % per_row == 0:
            row += 1
        col = i % per_row
        x = MARGIN + col * (card_w + gap)
        cy = y + row * (card_h + gap)
        doc.round_rect(x, cy, card_w, card_h, 4, fill=WHITE, stroke=RULE, lw=0.75)
        doc.c.setFillColor(MUTED)
        doc.set_font("Helvetica", 7)
        doc.text(str(kpi.get("label") or "").upper(), x + 9, cy + 8, width=card_w - 18)
        doc.c.setFillColor(INK)
        doc.set_font("Helvetica-Bold", 19)
        doc.text(str(kpi.get("display") or "—"), x + 9, cy + 19, width=card_w - 18)
        hint = kpi.get("hint") or ""
        extra = kpi.get("compare")
        if extra:
            colour = GOOD if kpi.get("good") is True else (BAD if kpi.get("good") is False else FAINT)
            doc.c.setFillColor(colour)
            doc.set_font("Helvetica", 7)
            doc.text(extra, x + 9, cy + 43, width=card_w - 18)
            doc.c.setFillColor(FAINT)
            doc.set_font("Helvetica", 6)
            doc.text(hint, x + 9, cy + 53, width=card_w - 18)
        else:
            doc.c.setFillColor(FAINT)
            doc.set_font("Helvetica", 7)
            doc.text(hint, x + 9, cy + 43, width=card_w - 18)
    return y + (row + 1) * (card_h + gap) + 6


def _section_title(doc: Doc, text: str, y: float, note: Optional[str] = None) -> float:
    doc.c.setFillColor(INK)
    doc.set_font("Helvetica-Bold", 11)
    doc.text(text, MARGIN, y)
    next_y = y + 14
    if note:
        doc.c.setFillColor(FAINT)
        doc.set_font("Helvetica", 7.5)
        next_y = doc.text_block(note, MARGIN, next_y + 1, CONTENT_W) + 2
    doc.line(MARGIN, next_y + 4, MARGIN + CONTENT_W, next_y + 4, RULE, 0.5)
    return next_y + 12


def _bar_chart(doc: Doc, x, y, width, height, labels, series) -> float:
    values = [v for s in series for v in s["data"]]
    max_v = max(values) if values else 1
    max_v = max(1.0, float(max_v))
    n = len(labels)
    if not n:
        return y
    plot_h = height - 16
    slot = width / n
    group_w = slot * 0.66
    bar_w = group_w / max(1, len(series))
    for frac in (0, 0.5, 1):
        gy = y + plot_h - plot_h * frac
        doc.line(x, gy, x + width, gy, RULE if frac == 0 else GRID, 0.5)
    for i, label in enumerate(labels):
        gx = x + slot * i + (slot - group_w) / 2
        for si, s in enumerate(series):
            v = float(s["data"][i] or 0)
            h = (v / max_v) * plot_h
            if h > 0.4:
                color = s["color"]
                if s.get("warn_at") and i < len(s["warn_at"]) and s["warn_at"][i]:
                    color = BAR_WARN
                doc.fill_rect(gx + bar_w * si, y + plot_h - h, max(bar_w - 1, 1), h, color)
        doc.c.setFillColor(FAINT)
        doc.set_font("Helvetica", 6)
        doc.text(str(label), x + slot * i, y + plot_h + 4, width=slot, align="center")
    lx = x
    ly = y + plot_h + 14
    for s in series:
        doc.fill_rect(lx, ly + 1, 6, 6, s["color"])
        doc.c.setFillColor(MUTED)
        doc.set_font("Helvetica", 7)
        doc.text(s["name"], lx + 9, ly)
        lx += stringWidth(s["name"], "Helvetica", 7) + 26
    return ly + 14


def _table(doc: Doc, headers, rows, widths, align, y, x=MARGIN, content_w=CONTENT_W, zebra=True) -> float:
    col_x = []
    cx = x
    for w in widths:
        col_x.append(cx)
        cx += w * content_w

    def cell(text, i, cy, font="Helvetica", size=8.5, color=INK):
        doc.set_font(font, size)
        doc.c.setFillColor(color)
        w = widths[i] * content_w - 6
        a = align[i] if i < len(align) else "left"
        doc.text(str(text if text is not None else "—"), col_x[i] + 3, cy, width=w, align=a)

    cy = y
    for i, h in enumerate(headers):
        cell(h, i, cy, "Helvetica-Bold", 7.5, MUTED)
    cy += 12
    doc.line(x, cy - 3, x + content_w, cy - 3, RULE, 0.5)
    for r, row in enumerate(rows):
        if zebra and r % 2 == 1:
            doc.fill_rect(x, cy - 3, content_w, 14, PANEL)
        for i, v in enumerate(row):
            cell(v, i, cy, "Helvetica", 8.5, INK)
        cy += 14
        if cy > A4_H - 50:
            _stamp_footer(doc, doc.page_no)
            doc.add_page()
            cy = MARGIN
            for i, h in enumerate(headers):
                cell(h, i, cy, "Helvetica-Bold", 7.5, MUTED)
            cy += 12
            doc.line(x, cy - 3, x + content_w, cy - 3, RULE, 0.5)
    return cy + 4


def _insight_box(doc: Doc, x, y, col_w, title, message, action, tone_key) -> float:
    tone = TONE.get(tone_key) or TONE["info"]
    doc.set_font("Helvetica", 8)
    body_h = doc.height_of_string(message, col_w - 16)
    action_h = doc.height_of_string(f"Action: {action}", col_w - 16) if action else 0
    box_h = min(78, body_h + action_h + 26)
    doc.round_rect(x, y, col_w, box_h, 3, fill=tone["fill"], stroke=None)
    doc.fill_rect(x, y + 1, 2.5, box_h - 2, tone["text"])
    doc.c.setFillColor(INK)
    doc.set_font("Helvetica-Bold", 8.5)
    doc.text(title, x + 10, y + 6, width=col_w - 16)
    doc.c.setFillColor(BODY)
    doc.set_font("Helvetica", 8)
    next_y = doc.text_block(message, x + 10, y + 18, col_w - 16)
    if action:
        doc.c.setFillColor(tone["text"])
        doc.set_font("Helvetica-Oblique", 7.5)
        doc.text(f"Action: {action}", x + 10, min(next_y + 1, y + box_h - 14), width=col_w - 16)
    return y + box_h + 6


def _draw_journey_strip(doc: Doc, stats, y: float) -> float:
    if not stats:
        return y
    next_y = _section_title(doc, "Hall at a glance", y)
    gap = 8
    w = (CONTENT_W - gap * (len(stats) - 1)) / len(stats)
    for i, (label, value, hint) in enumerate(stats):
        x = MARGIN + i * (w + gap)
        doc.round_rect(x, next_y, w, 42, 3, fill=PANEL, stroke=None)
        doc.c.setFillColor(MUTED)
        doc.set_font("Helvetica", 6.5)
        doc.text(label.upper(), x + 7, next_y + 6, width=w - 14)
        doc.c.setFillColor(INK)
        doc.set_font("Helvetica-Bold", 14)
        doc.text(value, x + 7, next_y + 16, width=w - 14)
        doc.c.setFillColor(FAINT)
        doc.set_font("Helvetica", 6)
        doc.text(hint, x + 7, next_y + 32, width=w - 14)
    return next_y + 50


def _draw_definitions(doc: Doc, y: float) -> float:
    next_y = _section_title(doc, "How these numbers are defined", y)
    defs = [
        ("Availability", "Share of commissioned PDUs with live telemetry this window (voltage > 50 V or current > 0.05 A). Not a calendar-month SLA until a stored time series is used."),
        ("Total load", "Sum of active power across PDUs that Cage Pulse marks online. Capacity is rated amps times average voltage."),
        ("Headroom / deployable", "Unused share of rated kW. Deployable is 85% of remaining headroom (15% planning reserve)."),
        ("Metered energy", "Sum of PDU kWh registers. Cage Pulse may label this Energy (Today); firmware counters are cumulative."),
        ("Daisy-chain live units", "Slaves are read through the master. Inventory IPs on the daisy bus do not answer ICMP or SNMP. SNMP for the chain is written on the master."),
    ]
    cy = next_y
    for term, body in defs:
        doc.c.setFillColor(INK)
        doc.set_font("Helvetica-Bold", 7.5)
        term_w = stringWidth(term + "  ", "Helvetica-Bold", 7.5)
        doc.text(term + "  ", MARGIN, cy)
        doc.c.setFillColor(MUTED)
        doc.set_font("Helvetica", 7.5)
        cy = doc.text_block(body, MARGIN + term_w, cy, CONTENT_W - term_w) + 2
        if cy > A4_H - 50:
            _stamp_footer(doc, doc.page_no)
            doc.add_page()
            cy = MARGIN
    return cy


def render_hall_report_pdf(payload: Dict[str, Any]) -> bytes:
    hall = payload.get("hallName") or "Data hall"
    m = payload.get("metrics") or {}
    warnings = payload.get("cableWarnings") or []
    generated = payload.get("generatedAt") or datetime.now().strftime("%d %b %Y, %H:%M")

    load = float(m.get("totalLoadKw") or 0)
    rated = float(m.get("ratedKw") or 0)
    load_pct = (load / rated * 100) if rated else 0
    live = int(m.get("liveCount") if m.get("liveCount") is not None else (m.get("onlineCount") or 0))
    total = int(m.get("totalCount") or 0)
    avail = f"{live}/{total}" if total else "—"
    avail_pct = float(m.get("availabilityPct") or (100.0 * live / total if total else 0))
    chains = m.get("chains") or []
    degraded = [c for c in chains if c.get("live", 0) < c.get("units", 0) and c.get("units", 0) > 1]
    all_pdus = m.get("allPdus") or m.get("topPdus") or []
    top = all_pdus[:8]

    tone = "warn" if degraded or warnings else ("good" if total and live == total else "info")
    watch = (
        f"{avail} PDUs electrically live. The hall is drawing {_fmt(load, 1)} kW — "
        f"{_fmt(load_pct, 0)}% of the {_fmt(rated, 0)} kW contracted envelope. "
        + (
            f"{', '.join(str(c.get('id')) for c in degraded)} report fewer live units than the daisy chain inventory."
            if degraded else
            "Every commissioned chain that answers is complete."
        )
    )

    doc = Doc()
    y = _draw_header(doc, hall, "Live Switchboard · Cage Pulse telemetry", generated)
    y = _draw_verdict(doc, tone, watch, y)

    kpis = [
        {"label": "Total load", "display": f"{_fmt(load, 1)} kW", "hint": f"{_fmt(load_pct, 0)}% of {_fmt(rated, 0)} kW capacity"},
        {"label": "Availability", "display": f"{_fmt(avail_pct, 0)}%", "hint": f"{avail} PDUs live", "good": bool(total and live == total)},
        {"label": "Headroom", "display": f"{_fmt(m.get('headroomPct'), 0)}%", "hint": f"{_fmt(m.get('deployableKw'), 0)} kW still deployable"},
        {"label": "Metered energy", "display": f"{_fmt(m.get('totalEnergyKwh'), 0)} kWh", "hint": "Sum of PDU registers"},
    ]
    y = _draw_kpi_cards(doc, kpis, y)

    pf_word = "leading" if m.get("pfLeading") else "lagging"
    y = _draw_journey_strip(doc, [
        ["Current", f"{_fmt(m.get('totalCurrentA'), 1)} A", f"{_fmt((m.get('totalCurrentA') or 0) / (m.get('totalRatedA') or 1) * 100, 0)}% of rated"],
        ["Apparent", f"{_fmt(m.get('apparentKva'), 1)} kVA", "this window"],
        ["Power factor", _fmt(m.get("avgPf"), 2), pf_word],
        ["Voltage (avg)", f"{_fmt(m.get('avgVoltage'), 1)} V", "L-L"],
    ], y)

    y = _section_title(
        doc, "Load by daisy chain", y,
        "Active power from Cage Pulse, grouped by hostname stem. Amber bars have fewer live units than inventory.",
    )
    if chains:
        y = _bar_chart(doc, MARGIN, y, CONTENT_W, 90,
                       [str(c.get("id") or "") for c in chains],
                       [{
                           "name": "Chain load (kW)",
                           "color": BAR,
                           "data": [float(c.get("kw") or 0) for c in chains],
                           "warn_at": [c.get("live", 0) < c.get("units", 0) and c.get("units", 0) > 1 for c in chains],
                       }]) + 6

    col_gap = 14
    col_w = (CONTENT_W - col_gap) / 2
    left_x = MARGIN
    right_x = MARGIN + col_w + col_gap
    if y > A4_H - 220:
        _stamp_footer(doc, doc.page_no)
        doc.add_page()
        y = MARGIN

    doc.c.setFillColor(INK)
    doc.set_font("Helvetica-Bold", 11)
    doc.text("Chain status", left_x, y, width=col_w)
    doc.text("What to act on", right_x, y, width=col_w)
    rule_y = y + 14
    doc.line(MARGIN, rule_y, MARGIN + CONTENT_W, rule_y, RULE, 0.5)
    left_y = rule_y + 10
    right_y = rule_y + 10

    chain_rows = [
        [str(c.get("stem") or c.get("id") or ""), str(c.get("master") or "—"),
         f"{c.get('live', 0)} / {c.get('units', 0)}", _fmt(c.get("amps"), 2), _fmt(c.get("kw"), 2)]
        for c in chains
    ]
    left_y = _table(
        doc,
        headers=["Chain", "Master", "Live", "A", "kW"],
        rows=chain_rows[:12],
        widths=[0.34, 0.28, 0.14, 0.12, 0.12],
        align=["left", "left", "right", "right", "right"],
        y=left_y, x=left_x, content_w=col_w,
    )

    if degraded:
        for c in degraded[:3]:
            right_y = _insight_box(
                doc, right_x, right_y, col_w,
                f"Daisy bus — {c.get('id')}",
                f"{c.get('live')} of {c.get('units')} units electrically live on {c.get('master') or 'the master'}. Slave inventory IPs do not answer on the LAN.",
                "Check daisy cables — this is not an ICMP miss.",
                "warn",
            )
    else:
        right_y = _insight_box(
            doc, right_x, right_y, col_w,
            "Chains complete",
            "Every daisy chain that is commissioned has live voltage on all units this window.",
            None,
            "good",
        )
    right_y = _insight_box(
        doc, right_x, right_y, col_w,
        "Alarms",
        f"{int(m.get('criticalCount') or 0)} critical · {int(m.get('warningCount') or 0)} warning · environment {_fmt(m.get('avgTemp'), 1)} °C / {_fmt(m.get('avgHum'), 1)}% RH.",
        None,
        "info" if not (m.get("criticalCount") or m.get("warningCount")) else "warn",
    )
    for w in warnings[:2]:
        right_y = _insight_box(
            doc, right_x, right_y, col_w,
            "Cable unplugged",
            f"{w.get('locationLabel') or w.get('pduLabel') or w.get('pduIp')} — {w.get('detail') or 'Outlet load lost'}",
            "Restore the outlet connection.",
            "bad",
        )

    y = max(left_y, right_y, y) + 8
    _stamp_footer(doc, doc.page_no)

    doc.add_page()
    y = MARGIN
    y = _section_title(doc, "Top loaded PDUs", y, "Current at the PDU this window, not a ping.")
    y = _table(
        doc,
        headers=["PDU ID", "IP", "Chain", "Current", "Path"],
        rows=[
            [p.get("hostname") or p.get("label") or p.get("ip"), p.get("ip"), p.get("chain"),
             f"{_fmt(p.get('current'), 2)} A",
             "Live" if p.get("live") else ("Online, no load" if p.get("online") else "Offline")]
            for p in top
        ],
        widths=[0.36, 0.22, 0.12, 0.14, 0.16],
        align=["left", "left", "left", "right", "left"],
        y=y,
    )

    y = _section_title(doc, "Fleet this window", y + 6)
    fleet_rows = [
        [p.get("hostname") or p.get("label") or p.get("ip"), p.get("ip"), p.get("chain"),
         _fmt(p.get("voltage"), 1), _fmt(p.get("current"), 2), _fmt(p.get("power"), 2),
         _fmt(p.get("pf"), 2) if p.get("pf") is not None else "—",
         "Live" if p.get("live") else ("No load" if p.get("online") else "Offline")]
        for p in all_pdus
    ]
    y = _table(
        doc,
        headers=["PDU ID", "IP", "Chain", "V", "A", "kW", "PF", "Status"],
        rows=fleet_rows,
        widths=[0.28, 0.16, 0.10, 0.08, 0.08, 0.08, 0.08, 0.14],
        align=["left", "left", "left", "right", "right", "right", "right", "left"],
        y=y,
    )
    y = _draw_definitions(doc, y + 8)
    _stamp_footer(doc, doc.page_no)

    doc.c.save()
    return doc.buf.getvalue()
