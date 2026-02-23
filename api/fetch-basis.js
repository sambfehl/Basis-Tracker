const { createClient } = require('@supabase/supabase-js');

// ─── Config ───────────────────────────────────────────────────
// Mid-Iowa stores their cash bids in a public Google Sheet
const SHEETS_CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRLEymqTHUmyKr6r7HqlgyOmAZtgthB5hB3CilPhPhaaK4T-7LNjJfjGQlm5FtEdmbBFWadlSOkPmak/pub?gid=0&single=true&output=csv';
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

  try {
    // ── Fetch CSV directly from Google Sheets ────────────────
    log.push('Fetching Google Sheets CSV...');
    const response = await fetch(SHEETS_CSV_URL);

    if (!response.ok) {
      throw new Error(`Failed to fetch sheet: HTTP ${response.status}`);
    }

    const csvText = await response.text();
    log.push('CSV fetched successfully.');

    // ── Parse CSV rows ───────────────────────────────────────
    // Handle quoted cells that may contain commas
    const rows = csvText.split('\n').map(line => {
      const cells = [];
      let current = '';
      let inQuotes = false;
      for (const char of line) {
        if (char === '"') { inQuotes = !inQuotes; }
        else if (char === ',' && !inQuotes) { cells.push(current.trim()); current = ''; }
        else { current += char; }
      }
      cells.push(current.trim());
      return cells;
    }).filter(row => row.some(cell => cell.length > 0));

    log.push(`Total rows in sheet: ${rows.length}`);
    log.push('First 8 rows: ' + JSON.stringify(rows.slice(0, 8)));

    // ── Extract grain data ───────────────────────────────────
    const today = new Date().toISOString().split('T')[0];
    const saved = [];
    const skipped = [];
    const parseErrors = [];

    for (const row of rows) {
      const rowText = row.join(' ').toLowerCase();

      // Identify commodity
      let commodity = null;
      if (rowText.includes('corn') && !rowText.includes('popcorn')) commodity = 'corn';
      else if (rowText.includes('soybean') || rowText.includes('soy bean')) commodity = 'soybeans';
      if (!commodity) continue;

      // Extract all numbers from the row
      const numbers = row
        .map(cell => cell.replace(/[$,]/g, '').trim())
        .filter(cell => /^-?\d+(\.\d{1,4})?$/.test(cell))
        .map(Number);

      if (numbers.length < 1) continue;

      // Heuristic:
      //   Cash price = $2.00–$20.00 range
      //   Basis      = -200 to +200 cents (not in cash price range)
      let cashPrice = null;
      let basisValue = null;
      for (const n of numbers) {
        if (n >= 2 && n <= 20 && cashPrice === null) cashPrice = n;
        if (n >= -200 && n <= 200 && Math.abs(n) > 0.5 && basisValue === null && !(n >= 2 && n <= 20)) basisValue = n;
      }

      // Look for futures month (e.g. "May25", "Jul 2025")
      const futuresMatch = row.join(' ').match(
        /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s*\d{2,4}\b/i
      );
      const futuresMonth = futuresMatch ? futuresMatch[0].trim() : null;

      if (basisValue === null) {
        skipped.push({ row, reason: 'Could not identify basis value' });
        continue;
      }

      // Skip if already saved today
      const { data: existing } = await db
        .from('basis_entries')
        .select('id')
        .eq('date', today)
        .eq('commodity', commodity)
        .eq('elevator_name', ELEVATOR_NAME)
        .limit(1);

      if (existing && existing.length > 0) {
        skipped.push({ row, reason: `Already saved for ${commodity} on ${today}` });
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
        notes: 'Auto-imported from Google Sheet',
      };

      const { error } = await db.from('basis_entries').insert(entry);
      if (error) {
        parseErrors.push(error.message);
      } else {
        saved.push(entry);
        log.push(`Saved: ${commodity} | basis ${basisValue}¢ | cash $${cashPrice}`);
      }
    }

    return res.status(200).json({
      success: true,
      message: `Saved ${saved.length} entries.`,
      log,
      saved,
      skipped,
      errors: parseErrors,
      debug: { allRows: rows.slice(0, 20) },
    });

  } catch (err) {
    log.push('Fatal error: ' + err.message);
    console.error(err);
    return res.status(500).json({ success: false, error: err.message, log });
  }
};
