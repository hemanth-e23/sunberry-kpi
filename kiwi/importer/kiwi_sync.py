"""
kiwi_sync.py -- send the shift report workbooks from the SharePoint folder to KIWI.

The SharePoint folder is synced to this PC by the normal OneDrive app (your own
Microsoft sign-in, nothing new to approve). Every few minutes this script looks
at the .xlsx files there and, for any workbook that changed since the last
successful send, reads it (never changes it) and posts the rows over HTTPS to
the kiwi-ingest function with a shared token. KIWI then answers from the new
data within minutes of a supervisor saving the report.

    python kiwi_sync.py                    # one pass (Task Scheduler runs this every 5 min)
    python kiwi_sync.py --dry-run          # show what would be sent, send nothing
    python kiwi_sync.py --file X.xlsx      # send one workbook now (e.g. an older month)

Settings live in kiwi_sync.conf next to this script (keep it readable by your
account only -- it holds the token):

    url    = https://<project-ref>.supabase.co/functions/v1/kiwi-ingest
    token  = <the KIWI_SYNC_TOKEN value>
    folder = C:\\Users\\<you>\\<Company>\\Production - Shift Reports
    # optional: pattern = *Shift Report*.xlsx

Security: outbound HTTPS only, certificate verified, token sent in a header.
The token can only replace shift report rows -- it can't read anything.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import hashlib
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from shift_report import parse_workbook  # noqa: E402

CONF = os.path.join(HERE, "kiwi_sync.conf")
STATE = os.path.join(HERE, "kiwi_sync_state.json")
LOG = os.path.join(HERE, "kiwi_sync.log")
LOCK = os.path.join(HERE, "kiwi_sync.lock")


def log(msg: str) -> None:
    line = f"{dt.datetime.now():%Y-%m-%d %H:%M:%S}  {msg}"
    print(line)
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > 2_000_000:
            os.replace(LOG, LOG + ".old")
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def read_conf() -> dict:
    conf = {"pattern": "*.xlsx"}
    if not os.path.exists(CONF):
        sys.exit(f"Missing {CONF} (see the top of this file).")
    with open(CONF, encoding="utf-8") as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            conf[k.strip().lower()] = v.strip().strip('"')
    for k in ("url", "token", "folder"):
        if not conf.get(k):
            sys.exit(f"kiwi_sync.conf: '{k}' is missing")
    local = conf["url"].startswith(("http://localhost", "http://127.0.0.1"))   # testing only
    if not conf["url"].startswith("https://") and not local:
        sys.exit("kiwi_sync.conf: url must start with https://")
    return conf


def jsonable(v):
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    if isinstance(v, dt.time):
        return v.strftime("%H:%M:%S")
    if isinstance(v, float) and v.is_integer() and abs(v) < 1e15:
        return v
    return v


def build_upload(data: bytes, name: str):
    rep = parse_workbook(io.BytesIO(data), name)
    if rep.month_start is None:
        return None, rep
    rows = lambda items: [{k: jsonable(v) for k, v in r.items()} for r in items]
    return {
        "month_start": rep.month_start.isoformat(),
        "month_end": rep.month_end.isoformat(),
        "source_file": name,
        "warnings": "\n".join(rep.warnings),
        "production": rows(rep.production),
        "downtime": rows(rep.downtime),
        "people": rows(rep.people),
        "notes": rows(rep.notes),
    }, rep


def send(conf: dict, upload: dict) -> dict:
    body = json.dumps(upload).encode("utf-8")
    req = urllib.request.Request(conf["url"], data=body, method="POST", headers={
        "Content-Type": "application/json", "x-kiwi-token": conf["token"]})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:   # certificate is verified by default
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode(errors='replace')[:300]}") from None


def find_workbooks(folder: str, pattern: str):
    out = []
    for root, _dirs, files in os.walk(folder):
        for fn in files:
            if fn.startswith("~$") or not fn.lower().endswith(".xlsx"):
                continue      # ~$ = Excel's lock file while someone has it open
            if fnmatch.fnmatch(fn.lower(), pattern.lower()):
                out.append(os.path.join(root, fn))
    return out


def load_state() -> dict:
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=1)
    os.replace(tmp, STATE)


def sync(conf: dict, files: list[str], dry_run: bool, force: bool) -> int:
    state = load_state()
    # Several files can claim the same month (e.g. "Report (1).xlsx"): newest wins.
    by_month: dict[str, tuple[float, str, bytes, dict]] = {}
    for path in files:
        try:
            with open(path, "rb") as f:
                data = f.read()          # read once into memory; the file is never modified
        except OSError as e:
            log(f"skip {os.path.basename(path)}: can't read ({e}) - OneDrive may still be downloading it")
            continue
        sha = hashlib.sha256(data).hexdigest()
        name = os.path.basename(path)
        if not force and any(s.get("sha") == sha for s in state.values()):
            continue                     # unchanged since last successful send
        try:
            upload, rep = build_upload(data, name)
        except Exception as e:           # half-synced or damaged file: try again next pass
            log(f"skip {name}: can't read workbook yet ({type(e).__name__}: {e})")
            continue
        if upload is None:
            log(f"skip {name}: no dates found")
            continue
        month = upload["month_start"][:7]
        mtime = os.path.getmtime(path)
        if month in by_month and by_month[month][0] > mtime:
            log(f"note: {name} is an older copy of {month}; using {by_month[month][1]}")
            continue
        if month in by_month:
            log(f"note: {by_month[month][1]} is an older copy of {month}; using {name}")
        by_month[month] = (mtime, name, sha.encode(), upload)

    errors = 0
    for month, (_m, name, sha, upload) in sorted(by_month.items()):
        counts = {k: len(upload[k]) for k in ("production", "downtime", "people", "notes")}
        if dry_run:
            log(f"[dry run] would send {name} ({month}): {counts}")
            for w in upload["warnings"].splitlines():
                log(f"  warning: {w}")
            continue
        for attempt in (1, 2, 3):
            try:
                res = send(conf, upload)
                state[month] = {"file": name, "sha": sha.decode(), "sent_at": dt.datetime.now().isoformat(timespec="seconds")}
                save_state(state)
                log(f"sent {name} ({month}): {res.get('saved')}")
                for w in upload["warnings"].splitlines():
                    log(f"  warning: {w}")
                break
            except Exception as e:
                if attempt == 3:
                    errors += 1
                    log(f"FAILED {name} ({month}): {e} - will retry next pass")
                else:
                    time.sleep(5 * attempt)
    return 1 if errors else 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Send shift report workbooks to KIWI.")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--file", help="send this workbook now, even if unchanged")
    args = ap.parse_args()
    conf = read_conf()

    # One copy at a time (Task Scheduler could start a new pass while one is slow).
    try:
        fd = os.open(LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.write(fd, str(os.getpid()).encode()); os.close(fd)
    except FileExistsError:
        if time.time() - os.path.getmtime(LOCK) < 15 * 60:
            return 0
        os.remove(LOCK)                  # stale lock from a crashed run
        return main()
    try:
        if args.file:
            return sync(conf, [args.file], args.dry_run, force=True)
        if not os.path.isdir(conf["folder"]):
            log(f"folder not found: {conf['folder']} - is OneDrive running and the folder synced?")
            return 1
        return sync(conf, find_workbooks(conf["folder"], conf["pattern"]), args.dry_run, force=False)
    finally:
        try:
            os.remove(LOCK)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
