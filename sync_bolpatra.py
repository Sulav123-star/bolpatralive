#!/usr/bin/env python3
"""Fetch tenders from the Bolpatra (Nepal e-GP) API and upsert into Supabase.

Env vars:
  BOLPATRA_API_URL   full URL of the 'tenders' endpoint, no query string
                     (copy from DevTools > Network > tenders?ordering=...)
  SUPABASE_URL       https://<project>.supabase.co
  SUPABASE_SERVICE_KEY  service_role key (GitHub secret, never in the web app)
  SUPABASE_TABLE     optional, default 'bolpatra_notices'
"""
import os
import sys
import time
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

import requests

NPT = ZoneInfo("Asia/Kathmandu")  # UTC+05:45
_raw = urlsplit(os.environ["BOLPATRA_API_URL"].strip())
# Accept the secret with or without a query string; keep any extra params
API_URL = urlunsplit((_raw.scheme, _raw.netloc, _raw.path, "", ""))
BASE_PARAMS = dict(parse_qsl(_raw.query))
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
TABLE = os.environ.get("SUPABASE_TABLE", "bolpatra_notices")
SITE = "https://bolpatra.gov.np"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; tender-sync/1.0)",
    "Accept": "application/json",
    "Referer": f"{SITE}/projects",
}


def get_json(url, params=None, retries=4):
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=30)
            r.raise_for_status()
            return r.json()
        except requests.RequestException as e:
            if attempt == retries - 1:
                body = getattr(getattr(e, "response", None), "text", "")[:300]
                print(f"  last response body: {body}", file=sys.stderr)
                raise
            wait = 2 ** attempt
            print(f"  retry in {wait}s after error: {e}", file=sys.stderr)
            time.sleep(wait)


def fetch_all():
    items, page = [], 1
    while page:
        params = {**BASE_PARAMS, "ordering": "newest", "page": page, "status": "ALL"}
        data = get_json(API_URL, params)
        items.extend(data.get("results", []))
        print(f"page {page}: {len(data.get('results', []))} rows "
              f"(total reported: {data.get('count')})")
        page = data.get("next")  # API returns next page number or null
        time.sleep(0.5)  # be polite
    return items


def parse_ts(s):
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(NPT)


def days_left(deadline, now):
    if not deadline:
        return None, None
    secs = int((deadline - now).total_seconds())
    if secs <= 0:
        return 0, "Closed"
    d, rem = divmod(secs, 86400)
    h, rem = divmod(rem, 3600)
    return d, f"{d}d {h}h {rem // 60}m"


def to_row(t, now):
    deadline = parse_ts(t.get("deadline"))
    published = parse_ts(t.get("publish_at"))
    dl, actual = days_left(deadline, now)
    return {
        "tender_ref": t["reference"],
        "title": (t.get("title") or "").strip(),
        "public_entity": t.get("office_name"),
        "procurement_type": t.get("category_name"),  # Works / Goods / ...
        "status": t.get("status"),
        "notice_published_date": published.isoformat() if published else None,
        "bid_submission_date": deadline.isoformat() if deadline else None,
        "days_left": dl,
        "actual_days_left": actual,
        "source_url": f"{SITE}/projects/{t['id']}",  # TODO confirm detail URL
        "updated_at": now.isoformat(),
        # id and first_seen_at are NOT sent: DB defaults fill them on insert
        # and the upsert leaves them untouched on update.
    }


def upsert(rows):
    url = f"{SUPABASE_URL}/rest/v1/{TABLE}?on_conflict=tender_ref"
    h = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    for i in range(0, len(rows), 100):
        chunk = rows[i:i + 100]
        r = requests.post(url, json=chunk, headers=h, timeout=60)
        if not r.ok:
            sys.exit(f"Supabase error {r.status_code}: {r.text}")
        print(f"upserted {len(chunk)} rows")


def main():
    now = datetime.now(timezone.utc).astimezone(NPT)
    tenders = fetch_all()
    if not tenders:
        sys.exit("API returned 0 tenders; refusing to continue (site changed?)")
    rows = {}
    for t in tenders:
        if t.get("reference"):
            rows[t["reference"]] = to_row(t, now)  # dedupe by tender_ref
    upsert(list(rows.values()))
    print(f"done: {len(rows)} tenders synced")


if __name__ == "__main__":
    main()
