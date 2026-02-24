const { createClient } = require('@supabase/supabase-js');

// ─────────────────────────────────────────────────────────────
// SOURCE 1: midiowa.agricharts.com
// Uses writeBidRow() format
// ─────────────────────────────────────────────────────────────
const AGRICHARTS_BASE = 'https://midiowa.agricharts.com/markets/cash.php?location_filter=';

const AGRICHARTS_LOCATIONS = [
  { name: 'ADM Cedar Rapids',              id: 66521, commodities: ['corn'] },
  { name: 'Cargill Cedar Rapids (Corn Mill)', id: 26279, commodities: ['corn'] },
  { name: 'Cargill Cedar Rapids',          id: 75163, commodities: ['soybeans'] },
  { name: 'Shell Rock Soy',                  id: 82509, commodities: ['soybeans'] },
  { name: 'La Porte City',                   id: 64477, commodities: ['corn'] },
  { name: 'Pine Lake Corn Processors',       id: 75160, commodities: ['corn'] },
  { name: 'POET Fairbank',                   id: 79809, commodities: ['corn'] },
  { name: 'Sinclair (Mid-Iowa)',             id: 81965, commodities: ['corn'] },
];

// ─────────────────────────────────────────────────────────────
// SOURCE 2: tamabentoncoop.com
// Uses writeBidCell() format — ZC = corn, ZS = soybeans
// ─────────────────────────────────────────────────────────────
const TAMABENTON_URL = 'https://tamabentoncoop.com/markets/cashgrid.php?basis=1&showenddate=1&dateformat=%25m/%25d/%25y';

const TAMABENTON_LOCATIONS = [
  { name: 'Vinton (Tama-Benton)', id: 3076, commodities: ['corn'] },
];

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const today   = new Date().toISOString().split('T')[0];
  const log     = [];
  const saved   = [];
  const skipped = [];
  const errors  = [];

  // ── Fetch & save a single entry ──────────────────────────
  async function saveEntry(name, commodity, basisValue, futuresMonth) {
    const { data: existing } = await db
      .from('basis_entries')
      .select('id')
      .eq('date', today)
      .eq('commodity', commodity)
      .eq('elevator_name', name)
      .limit(1);

    if (existing && existing.length > 0) {
      skipped.push(`${name} ${commodity} already saved for ${today}`);
      return;
    }

    const entry = {
      date:          today,
      commodity,
      elevator_name: name,
      basis_value:   basisValue,
      futures_month: futuresMonth || null,
      notes:         'Auto-imported',
    };

    const { error } = await db.from('basis_entries').insert(entry);
    if (error) {
      errors.push(`${name} ${commodity}: ${error.message}`);
    } else {
      saved.push(entry);
      log.push(`  ✓ ${name} | ${commodity} | ${basisValue}¢ (${futuresMonth || '—'})`);
    }
  }

  // ════════════════════════════════════════════════════════
  // SOURCE 1 — midiowa.agricharts.com
  // writeBidRow('Commodity', basis, false, false, false, 0.75, 'Month Year', ...)
  // ════════════════════════════════════════════════════════
  for (const loc of AGRICHARTS_LOCATIONS) {
    log.push(`Fetching ${loc.name}...`);
    try {
      const res1 = await fetch(AGRICHARTS_BASE + loc.id);
      if (!res1.ok) { errors.push(`${loc.name}: HTTP ${res1.status}`); continue; }
      const html = await res1.text();

      // Extract writeBidRow calls — capture commodity, basis, delivery date
      const regex = /writeBidRow\('([^']+)',\s*(-?\d+(?:\.\d+)?),(?:[^,]*,){4}\s*'([^']+)'/g;
      const bids  = {};
      let m;

      while ((m = regex.exec(html)) !== null) {
        const raw  = m[1].toLowerCase();
        const basis = parseFloat(m[2]);
        const month = m[3].trim();

        let commodity = null;
        if (raw.includes('corn'))    commodity = 'corn';
        if (raw.includes('soybean')) commodity = 'soybeans';
        if (!commodity || !loc.commodities.includes(commodity)) continue;
        if (!bids[commodity]) bids[commodity] = { basis, month }; // keep nearest only
      }

      for (const [commodity, bid] of Object.entries(bids)) {
        await saveEntry(loc.name, commodity, bid.basis, bid.month);
      }

      if (!Object.keys(bids).length) log.push(`  ⚠ No matching bids found`);

    } catch (err) {
      errors.push(`${loc.name}: ${err.message}`);
    }
  }

  // ════════════════════════════════════════════════════════
  // SOURCE 2 — tamabentoncoop.com
  // writeBidCell(basis, ..., 'c=X&l=LOCID&d=MONTH', ..., quotes['SYMBOL'])
  // ZC prefix = corn, ZS prefix = soybeans
  // ════════════════════════════════════════════════════════
  log.push('Fetching Tama-Benton (Vinton)...');
  try {
    const res2 = await fetch(TAMABENTON_URL);
    if (!res2.ok) {
      errors.push(`Tama-Benton: HTTP ${res2.status}`);
    } else {
      const html = await res2.text();

      // Capture: basis value, location ID, futures symbol
      const regex = /writeBidCell\((-?\d+(?:\.\d+)?),(?:[^,]*,){4}\s*'c=\d+&l=(\d+)&[^']*',(?:[^,]*,){1}\s*quotes\['(Z[A-Z]+\d+)'\]/g;
      const bids  = {};
      let m;

      while ((m = regex.exec(html)) !== null) {
        const basis    = parseFloat(m[1]);
        const locId    = parseInt(m[2]);
        const symbol   = m[3]; // e.g. ZCH26 or ZSH26

        // Match location
        const loc = TAMABENTON_LOCATIONS.find(l => l.id === locId);
        if (!loc) continue;

        // Determine commodity from futures symbol prefix
        let commodity = null;
        if (symbol.startsWith('ZC')) commodity = 'corn';
        if (symbol.startsWith('ZS')) commodity = 'soybeans';
        if (!commodity || !loc.commodities.includes(commodity)) continue;

        if (!bids[`${locId}-${commodity}`]) {
          bids[`${locId}-${commodity}`] = { loc, commodity, basis, symbol };
        }
      }

      for (const bid of Object.values(bids)) {
        await saveEntry(bid.loc.name, bid.commodity, bid.basis, bid.symbol);
      }

      if (!Object.keys(bids).length) log.push('  ⚠ No matching Tama-Benton bids found');
    }
  } catch (err) {
    errors.push(`Tama-Benton: ${err.message}`);
  }

  // ── Summary ──────────────────────────────────────────────
  const expected = AGRICHARTS_LOCATIONS.reduce((n, l) => n + l.commodities.length, 0)
                 + TAMABENTON_LOCATIONS.reduce((n, l) => n + l.commodities.length, 0);

  return res.status(200).json({
    success: true,
    message: `Saved ${saved.length} of ${expected} expected entries.`,
    log,
    saved,
    skipped,
    errors,
  });
};
