const chromium = require('@sparticuz/chromium-min');
const puppeteer = require('puppeteer-core');
const { createClient } = require('@supabase/supabase-js');

// ─── Config ───────────────────────────────────────────────────
const CASH_BIDS_URL = 'https://www.midiowacoop.com/grains/cash-bids/cash-bids-and-hours/';
const ELEVATOR_NAME = 'Mid-Iowa Cooperative';

// ─── Handler ──────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const log = [];
  let browser = null;

  try {
    // ── Launch headless browser ──────────────────────────────
    log.push('Launching browser...');
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(
        'https://github.com/Sparticuz/chromium/releases/download/v131.0.0/chromium-v131.0.0-pack.tar'
      ),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // Look like a real browser so we don't get blocked
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // ── Load the page ────────────────────────────────────────
    log.push('Loading page: ' + CASH_BIDS_URL);
    await page.goto(CASH_BIDS_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for JavaScript widgets to finish rendering
    await new Promise(r => setTimeout(r, 5000));
    log.push('Page loaded. Waiting for widget...');

    // Try to wait for a table to appear
    try {
      await page.waitForSelector('table', { timeout: 10000 });
      log.push('Table found.');
    } catch {
      log.push('No table found — will try other selectors.');
    }

    // ── Extract data from page ───────────────────────────────
    const extracted = await page.evaluate(() => {
      // Grab all table data
      const tables = Array.from(document.querySelectorAll('table'));
      const tableData = tables.map(table => {
        const rows = Array.from(table.querySelectorAll('tr'));
        return rows.map(row => {
          const cells = Array.from(row.querySelectorAll('td, th'));
          return cells.map(c => c.innerText.trim()).filter(t => t.length > 0);
        }).filter(row => row.length > 0);
      });

      // Also check iframes (Barchart sometimes embeds one)
      const iframes = Array.from(document.querySelectorAll('iframe'));
      const iframeSrcs = iframes.map(f => f.src);

      // Grab a snippet of the visible page text for debugging
      const bodySnippet = document.body.innerText.substring(0, 4000);

      return { tableData, iframeSrcs, bodySnippet };
    });

    log.push(`Tables found: ${extracted.tableData.length}`);
    log.push(`Iframes found: ${extracted.iframeSrcs.length}`);

    // ── Parse grain entries from tables ──────────────────────
    const today = new Date().toISOString().split('T')[0];
    const saved = [];
    const skipped = [];
    const parseErrors = [];

    for (const table of extracted.tableData) {
      for (const row of table) {
        const rowText = row.join(' ').toLowerCase();

        // Identify commodity
        let commodity = null;
        if (rowText.includes('corn') && !rowText.includes('popcorn')) {
          commodity = 'corn';
        } else if (rowText.includes('soybean') || rowText.includes('soy bean')) {
          commodity = 'soybeans';
        }
        if (!commodity) continue;

        // Pull all numbers from the row
        const numbers = row
          .map(cell => cell.replace(/[$,\s]/g, ''))
          .filter(cell => /^-?\d+(\.\d{1,4})?$/.test(cell))
          .map(Number);

        if (numbers.length < 1) continue;

        // Heuristic parsing:
        // - Cash price:  likely $2–$20 range
        // - Basis:       likely -200 to +200 (cents)
        let cashPrice = null;
        let basisValue = null;

        for (const n of numbers) {
          if (n >= 2 && n <= 20 && cashPrice === null) {
            cashPrice = n;
          }
          if (n >= -200 && n <= 200 && Math.abs(n) > 0.5 && basisValue === null && !(n >= 2 && n <= 20)) {
            basisValue = n;
          }
        }

        // Look for futures month string (e.g. "Jul25", "December 2025")
        const futuresMatch = row.join(' ').match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s*\d{2,4}\b/i);
        const futuresMonth = futuresMatch ? futuresMatch[0].trim() : null;

        // Skip if we couldn't find a basis value
        if (basisValue === null) {
          skipped.push({ row, reason: 'Could not identify basis value' });
          continue;
        }

        // Skip duplicate entries for same date/commodity/elevator
        const { data: existing } = await db
          .from('basis_entries')
          .select('id')
          .eq('date', today)
          .eq('commodity', commodity)
          .eq('elevator_name', ELEVATOR_NAME)
          .limit(1);

        if (existing && existing.length > 0) {
          skipped.push({ row, reason: `Entry already exists for ${commodity} on ${today}` });
          continue;
        }

        // Save to Supabase
        const entry = {
          date: today,
          commodity,
          elevator_name: ELEVATOR_NAME,
          basis_value: basisValue,
          cash_price: cashPrice,
          futures_month: futuresMonth,
          notes: 'Auto-imported',
        };

        const { error } = await db.from('basis_entries').insert(entry);
        if (error) {
          parseErrors.push(error.message);
        } else {
          saved.push(entry);
          log.push(`Saved: ${commodity} basis ${basisValue}¢`);
        }
      }
    }

    await browser.close();

    return res.status(200).json({
      success: true,
      message: `Saved ${saved.length} entries.`,
      log,
      saved,
      skipped,
      errors: parseErrors,
      // Full debug output so we can fix selectors if needed
      debug: {
        tableData: extracted.tableData,
        iframeSrcs: extracted.iframeSrcs,
        bodySnippet: extracted.bodySnippet,
      },
    });

  } catch (err) {
    if (browser) await browser.close();
    log.push('Fatal error: ' + err.message);
    console.error(err);
    return res.status(500).json({ success: false, error: err.message, log });
  }
};
