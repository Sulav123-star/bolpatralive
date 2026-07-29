/**
 * scrape-bolpatra.ts
 *
 * Fetches the public tender listing from bolpatra.gov.np, parses the results
 * table, and upserts new/updated notices into Supabase (`bolpatra_notices`).
 *
 * Run manually:   npx tsx scripts/scrape-bolpatra.ts
 * Run on schedule: see .github/workflows/bolpatra-sync.yml
 *
 * IMPORTANT: the table selector below is best-effort, matched against the
 * page's rendered column order (Sl.No / IFB-RFP-EOI-PQ No / Project Title /
 * Public Entity / Procurement Type / Status / Notice Published Date /
 * Bid Submission Date / Days Left). Government portals occasionally change
 * markup — if `parseNotices` starts returning 0 rows, re-inspect the live
 * HTML (view-source or curl the URL) and adjust the cell indices below.
 */

import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';
import { fetch, Agent } from 'undici';

const BOLPATRA_URL = 'https://www.bolpatra.gov.np/egp/searchOpportunity';

interface TenderNotice {
  tender_ref: string;
  title: string;
  public_entity: string;
  procurement_type: string;
  status: string;
  notice_published_date: string | null;
  bid_submission_date: string | null;
  days_left: number | null;
  source_url: string;
}

async function fetchPage(page = 1): Promise<string> {
  // NOTE: pagination behavior hasn't been confirmed. If the site uses a
  // query param (?page=2) this works as-is; if it requires a POST/form
  // submit instead, this will need to switch to a POST request with the
  // relevant form fields — inspect the "Next" button's network request
  // in DevTools to confirm.
  const url = page === 1 ? BOLPATRA_URL : `${BOLPATRA_URL}?page=${page}`;

  // bolpatra.gov.np uses a certificate chain not in Node's default trust store.
  // We scope the TLS relaxation to this dispatcher only rather than setting
  // the global NODE_TLS_REJECT_UNAUTHORIZED=0.
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });

  const res = await fetch(url, {
    dispatcher,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; PlanxerBolpatraSync/1.0; +https://yourdomain.com)',
      Accept: 'text/html',
    },
  });

  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }

  return res.text();
}

function parseNotices(html: string): TenderNotice[] {
  const $ = cheerio.load(html);
  const notices: TenderNotice[] = [];

  $('table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 9) return; // skip header / non-data rows

    const tender_ref = $(cells[1]).text().trim();
    const title = $(cells[2]).text().trim();
    if (!tender_ref || !title) return;

    const daysLeftRaw = $(cells[8]).text().trim();
    const daysLeftMatch = daysLeftRaw.match(/\d+/);

    notices.push({
      tender_ref,
      title,
      public_entity: $(cells[3]).text().trim(),
      procurement_type: $(cells[4]).text().trim(),
      status: $(cells[5]).text().trim(),
      notice_published_date: $(cells[6]).text().trim() || null,
      bid_submission_date: $(cells[7]).text().trim() || null,
      days_left: daysLeftMatch ? parseInt(daysLeftMatch[0], 10) : null,
      source_url: BOLPATRA_URL,
    });
  });

  return notices;
}

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.'
    );
  }
  return createClient(url, key);
}

async function syncToSupabase(notices: TenderNotice[]) {
  const supabase = getSupabaseClient();

  // Find which refs are genuinely new (for logging/notifications later)
  const refs = notices.map((n) => n.tender_ref);
  const { data: existing, error: existingErr } = await supabase
    .from('bolpatra_notices')
    .select('tender_ref')
    .in('tender_ref', refs);

  if (existingErr) throw existingErr;

  const existingRefs = new Set((existing ?? []).map((r) => r.tender_ref));
  const newCount = notices.filter((n) => !existingRefs.has(n.tender_ref)).length;

  const { error: upsertErr } = await supabase
    .from('bolpatra_notices')
    .upsert(notices, { onConflict: 'tender_ref' });

  if (upsertErr) throw upsertErr;

  await supabase.from('sync_log').insert({
    source: 'bolpatra',
    status: 'success',
    rows_synced: notices.length,
    new_rows: newCount,
  });

  return { total: notices.length, newCount };
}

async function logFailure(err: unknown) {
  try {
    const supabase = getSupabaseClient();
    await supabase.from('sync_log').insert({
      source: 'bolpatra',
      status: 'error',
      error_message: String(err instanceof Error ? err.message : err),
    });
  } catch {
    // If even the failure log fails, just let the process exit non-zero
    // and rely on the GitHub Actions run status as the signal.
  }
}

async function main() {
  try {
    const html = await fetchPage(1);
    const notices = parseNotices(html);

    if (notices.length === 0) {
      throw new Error(
        'Parsed 0 notices — the page structure likely changed. Re-check the table selector.'
      );
    }

    const result = await syncToSupabase(notices);
    console.log(
      `Synced ${result.total} notices (${result.newCount} new) from Bolpatra.`
    );
  } catch (err) {
    console.error('Bolpatra sync failed:', err);
    await logFailure(err);
    process.exit(1);
  }
}

main();