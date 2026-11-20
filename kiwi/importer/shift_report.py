"""
KIWI - read the monthly shift report workbook exactly as the supervisors fill it in.

The workbook is never changed. Each tab is one day of the month ("1".."31").
Each tab has two blocks, "1st Shift" and "2nd Shift", and each block has:
  - Production Summary  (one row per line run)
  - Downtime Tracking   (Line 1 on the left, Line 2 on the right)
  - Employee Information (Absences, Part Day)
  - Shift Communication (Important Information, Supervisor notes)

Sections are found by their labels, not by fixed row numbers, so small layout
shifts (an extra row added to a block) don't break the import.
"""
from __future__ import annotations

import datetime as dt
import re
from collections import Counter
from dataclasses import dataclass, field

import openpyxl

NBSP = "\xa0"

# Production header text -> column name in the database
PRODUCTION_COLUMNS = {
    "date": "report_date",
    "shift": "shift",
    "supervisor/lead": "supervisor",
    "line": "line",
    "sku": "sku",
    "name": "product",
    "lot": "lot",
    "planned batches": "planned_batches",
    "filler start": "filler_start",
    "first bottle": "first_bottle",
    "last bottle": "last_bottle",
    "batches made": "batches_made",
    "total gallons": "total_gallons",
    "cases produced": "cases_produced",
    "percentage loss": "pct_loss",
    "cases reworked": "cases_reworked",
    "bottles loaded": "bottles_loaded",
    "caps loaded": "caps_loaded",
    "bottle loss": "bottle_loss",
}
NUMERIC = {"planned_batches", "batches_made", "total_gallons", "cases_produced",
           "pct_loss", "cases_reworked", "bottles_loaded", "caps_loaded", "bottle_loss"}
TIMES = {"filler_start", "first_bottle", "last_bottle"}


def clean(v):
    """Turn blank-looking cells (None, '', non-breaking spaces) into None."""
    if v is None:
        return None
    if isinstance(v, str):
        v = v.replace(NBSP, " ").strip()
        return v or None
    return v


def label(v) -> str:
    v = clean(v)
    return v.lower() if isinstance(v, str) else ""


def to_number(v):
    v = clean(v)
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    m = re.search(r"-?\d[\d,]*\.?\d*", str(v))
    if not m:
        return None
    n = float(m.group().replace(",", ""))
    return n / 100 if "%" in str(v) and n > 1 else n


def to_time(v):
    v = clean(v)
    if v is None:
        return None
    if isinstance(v, dt.datetime):
        return v.time().replace(microsecond=0)
    if isinstance(v, dt.time):
        return v.replace(microsecond=0)
    m = re.match(r"^(\d{1,2}):(\d{2})", str(v))
    if m and int(m.group(1)) < 24:
        return dt.time(int(m.group(1)), int(m.group(2)))
    return None


def to_minutes(v):
    """'295 min', '11min', '1 hr 5 min', '1:05' -> minutes. 'N/A' -> None."""
    v = clean(v)
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).lower()
    m = re.match(r"^\s*(\d+):(\d{2})\s*$", s)
    if m:
        return int(m.group(1)) * 60 + int(m.group(2))
    hrs = re.search(r"(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b", s)
    mins = re.search(r"(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b", s)
    if hrs or mins:
        return (float(hrs.group(1)) * 60 if hrs else 0) + (float(mins.group(1)) if mins else 0)
    n = to_number(s)
    return n


@dataclass
class Report:
    production: list[dict] = field(default_factory=list)
    downtime: list[dict] = field(default_factory=list)
    people: list[dict] = field(default_factory=list)
    notes: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    month_start: dt.date | None = None
    month_end: dt.date | None = None


def _rows(ws):
    return [list(r) for r in ws.iter_rows(values_only=True)]


def _find(rows, text, start=0, end=None, col=None):
    """First row index at/after `start` whose cell (any, or `col`) starts with `text`."""
    end = len(rows) if end is None else end
    for i in range(start, end):
        cells = enumerate(rows[i]) if col is None else [(col, rows[i][col] if col < len(rows[i]) else None)]
        for _, v in cells:
            if label(v).startswith(text):
                return i
    return None


def _col(header_row, text, start=0, end=None):
    end = len(header_row) if end is None else end
    for j in range(start, end):
        if label(header_row[j]).startswith(text):
            return j
    return None


def _sheet_day(title: str):
    m = re.match(r"^\s*(\d{1,2})\s*$", title)
    return int(m.group(1)) if m else None


def parse_workbook(path: str, source_name: str | None = None) -> Report:
    wb = openpyxl.load_workbook(path, data_only=True, read_only=False)
    source = source_name or path.rsplit("/", 1)[-1]
    rep = Report()

    # Month comes from the Date column inside the file (the file name can be wrong:
    # "November" file containing October dates).
    all_dates = []
    for ws in wb.worksheets:
        for r in ws.iter_rows(values_only=True):
            if isinstance(r[0], (dt.datetime, dt.date)):
                d = r[0].date() if isinstance(r[0], dt.datetime) else r[0]
                all_dates.append((d.year, d.month))
    if not all_dates:
        rep.warnings.append("No dates found in the Date column; nothing imported.")
        return rep
    (year, month), _ = Counter(all_dates).most_common(1)[0]
    rep.month_start = dt.date(year, month, 1)
    rep.month_end = (dt.date(year + month // 12, month % 12 + 1, 1) - dt.timedelta(days=1))

    for ws in wb.worksheets:
        day = _sheet_day(ws.title)
        if day is None:
            rep.warnings.append(f"Tab '{ws.title}' is not a day number; skipped.")
            continue
        try:
            tab_date = dt.date(year, month, day)
        except ValueError:
            continue  # e.g. tab 31 in a 30-day month
        rows = _rows(ws)
        starts = [(1, _find(rows, "1st shift", col=0)), (2, _find(rows, "2nd shift", col=0))]
        for k, (shift, s) in enumerate(starts):
            if s is None:
                continue
            e = starts[k + 1][1] if k + 1 < len(starts) and starts[k + 1][1] else len(rows)
            _parse_block(rows, s, e, shift, tab_date, ws.title, source, rep)
    return rep


def _parse_block(rows, s, e, shift, tab_date, sheet, source, rep: Report):
    ctx = dict(source_file=source, sheet=sheet)
    hdr = _find(rows, "date", s, e, col=0)
    dt_row = _find(rows, "downtime tracking", s, e, col=0)
    emp_row = _find(rows, "employee information", s, e, col=0)

    # ---------- production ----------
    if hdr is not None:
        header = rows[hdr]
        cols = {}
        for j, v in enumerate(header):
            key = PRODUCTION_COLUMNS.get(label(v))
            if key and key not in cols:
                cols[key] = j
        stop = dt_row if dt_row is not None else e
        for i in range(hdr + 1, stop):
            r = rows[i]
            rec = {k: clean(r[j]) if j < len(r) else None for k, j in cols.items()}
            if not any(rec.get(k) for k in ("line", "sku", "product", "lot", "cases_produced", "total_gallons")):
                continue
            d = rec.get("report_date")
            if isinstance(d, dt.datetime):
                d = d.date()
            if isinstance(d, dt.date) and d != tab_date:
                # Typed date disagrees with the tab (e.g. tab "1" of November dated 10/1
                # because the template was copied). The tab is the reliable one.
                rep.warnings.append(f"Tab {sheet} row {i+1}: Date cell says {d}, tab is {tab_date}; using {tab_date}.")
            rec["report_date"] = tab_date
            typed = to_number(rec.get("shift"))
            if typed is not None and int(typed) != shift:
                # e.g. tab 18: a Line 2 row in the 1st Shift block typed as shift "2".
                # The block the row sits in is the reliable one.
                rep.warnings.append(f"Tab {sheet} row {i+1}: Shift cell says {int(typed)}, row is in the "
                                    f"{'1st' if shift == 1 else '2nd'} Shift block; using {shift}.")
            rec["shift"] = shift
            ln = to_number(rec.get("line"))
            rec["line"] = int(ln) if ln is not None else None
            for k in NUMERIC:
                rec[k] = to_number(rec.get(k))
            for k in TIMES:
                rec[k] = to_time(rec.get(k))
            for k in ("supervisor", "sku", "product", "lot"):
                rec[k] = str(rec[k]).strip() if rec.get(k) is not None else None
            rec.update(ctx, row_no=i + 1)
            rep.production.append(rec)

    # ---------- downtime (Line 1 left, Line 2 right) ----------
    if dt_row is not None:
        top = rows[dt_row]
        l2 = next((j for j, v in enumerate(top) if label(v).startswith("downtime tracking - line 2")), None)
        sub = rows[dt_row + 1] if dt_row + 1 < e else []
        sides = [(1, 0, l2 if l2 is not None else len(sub))]
        if l2 is not None:
            sides.append((2, l2, len(sub)))
        stop = emp_row if emp_row is not None else e
        for line, a, b in sides:
            c_dur = _col(sub, "time duration", a, b)
            c_eq = _col(sub, "equipment", a, b)
            c_rs = _col(sub, "reason", a, b)
            for i in range(dt_row + 2, stop):
                r = rows[i]
                get = lambda c: clean(r[c]) if c is not None and c < len(r) else None
                dur, eq, rs = get(c_dur), get(c_eq), get(c_rs)
                if not any((dur, eq, rs)):
                    continue
                rep.downtime.append(dict(
                    report_date=tab_date, shift=shift, line=line,
                    minutes=to_minutes(dur), duration_raw=str(dur) if dur is not None else None,
                    equipment=str(eq).strip() if eq else None,
                    reason=str(rs).strip() if rs else None,
                    row_no=i + 1, **ctx))

    # ---------- employees and notes ----------
    if emp_row is not None and emp_row + 1 < e:
        sub = rows[emp_row + 1]
        c_abs = _col(sub, "absences")
        c_part = _col(sub, "part day")
        c_imp = _col(sub, "important information")
        c_sup = _col(sub, "supervi")  # "Supervison notes" (sic)
        imp, sup = [], []
        for i in range(emp_row + 2, e):
            r = rows[i]
            get = lambda c: clean(r[c]) if c is not None and c < len(r) else None
            for kind, c in (("absence", c_abs), ("part_day", c_part)):
                v = get(c)
                if v:
                    rep.people.append(dict(report_date=tab_date, shift=shift, kind=kind,
                                           name=str(v).strip(), row_no=i + 1, **ctx))
            if get(c_imp):
                imp.append(str(get(c_imp)))
            if get(c_sup):
                sup.append(str(get(c_sup)))
        if imp or sup:
            norm = lambda parts: re.sub(r"[ \t]{3,}", "\n\n", "\n".join(parts)).strip() or None
            rep.notes.append(dict(report_date=tab_date, shift=shift,
                                  important_info=norm(imp), supervisor_notes=norm(sup), **ctx))


if __name__ == "__main__":
    import sys
    r = parse_workbook(sys.argv[1])
    print(f"Month {r.month_start} .. {r.month_end}")
    print(f"production rows: {len(r.production)}, downtime rows: {len(r.downtime)}, "
          f"people rows: {len(r.people)}, notes: {len(r.notes)}")
    for w in r.warnings:
        print("WARNING:", w)
