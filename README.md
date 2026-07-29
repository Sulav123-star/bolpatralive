# Bolpatra Sync

Scheduled job that scrapes new tender notices from bolpatra.gov.np and syncs
them into Supabase, for display on Planxer's Home page.

## How it works

1. `scripts/scrape-bolpatra.ts` fetches the public search-results page
   (server-rendered HTML — no headless browser needed) and parses the
   results table with `cheerio`.
2. Rows are upserted into `bolpatra_notices`, keyed by `tender_ref`
   (the IFB/RFP/EOI/PQ No.), so re-runs never duplicate rows.
3. Every run writes a row to `sync_log` (success or error) so you can
   monitor sync health.
4. `.github/workflows/bolpatra-sync.yml` runs the script every 30 minutes
   via GitHub Actions — no Zapier, no paid automation tool.

## Setup

1. **Create the tables** — run `schema.sql` in your Supabase SQL editor.

2. **Add repo secrets** (Settings → Secrets and variables → Actions):
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY` (service role, not anon key — this job
     needs write access and runs server-side only, never in a browser)

3. **Install dependencies locally to test first:**
   ```bash
   npm install
   npm run sync
   ```

4. **Verify the parser matches the live page.** The site's table markup
   isn't guaranteed to stay stable. If `npm run sync` logs
   "Parsed 0 notices," open bolpatra.gov.np/egp/searchOpportunity, view
   source (or curl the URL), and adjust the cell indices in
   `parseNotices()` inside `scripts/scrape-bolpatra.ts`.

5. **Push to GitHub.** The workflow will start running on its schedule
   automatically. You can also trigger it manually from the Actions tab
   ("Run workflow") to confirm it works end-to-end before waiting for
   the cron.

## Wiring into the Home page

Your Home page's Bolpatra module should just read from Supabase directly —
it has no dependency on how the data got there:

```ts
const { data: notices } = await supabase
  .from('bolpatra_notices')
  .select('*')
  .order('first_seen_at', { ascending: false })
  .limit(20);
```

## Known limitations / next steps

- **Pagination isn't confirmed.** The script only fetches page 1 right
  now. If you want full historical backfill, the `?page=N` param needs
  confirming against the live site (or a POST-based approach if the
  "Next" button submits a form instead).
- **No "new notice" notification yet.** `syncToSupabase()` already
  calculates `newCount` — a natural next step is emailing/Slacking a
  digest when `newCount > 0`, or pushing a toast in-app.
- **Field types are stored as text** for the date columns since the
  source format (`DD-MM-YYYY HH:MM`) isn't a native Postgres date/time
  format without a Nepali-calendar-aware conversion — normalize this
  later if you need real date filtering/sorting.
- **Respect the source.** This polls a public government page on a
  reasonable interval (30 min) with a descriptive User-Agent. If PPMO
  ever publishes an official API, prefer switching to it.
