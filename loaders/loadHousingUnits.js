/* ============================================================
   WAFER -- loadHousingUnits.js

   Populates `housing_units_by_tract` from the Census Decennial API,
   2010 and 2020, giving the tract-level growth signal at the heart
   of the WAFER Score (see Scope.md).

   MUST run after loadACS.js -- this table has a foreign key on
   census_tracts.geoid, which loadACS.js is what creates.

   Requires CENSUS_API_KEY (see loadACS.js header for why).

   Variable-name note: the Census P.L. 94-171 redistricting file changed
   its variable naming convention between the 2010 and 2020 releases.
   2020's H1_001N ("Total housing units") is confirmed correct against
   the live API. 2010's H001001 is the well-documented equivalent under
   the pre-2020 naming convention, but could not be verified against the
   live endpoint from this environment (it 302-redirects without a key,
   and no key was available while writing this loader) -- confirm it
   returns non-null values for a known WI tract before trusting a full run.
   ============================================================ */
require('dotenv').config();
const pool = require('../db');

const WI_STATE_FIPS = '55';

const CENSUS_YEARS = [
  { year: 2020, dataset: 'dec/pl', housingVar: 'H1_001N' },
  { year: 2010, dataset: 'dec/pl', housingVar: 'H001001' } // verify before trusting -- see header note
];

function requireCensusKey() {
  const key = process.env.CENSUS_API_KEY;
  if (!key) {
    throw new Error(
      'CENSUS_API_KEY is not set. Sign up at https://api.census.gov/data/key_signup.html and add it to .env'
    );
  }
  return key;
}

async function fetchHousingUnits({ year, dataset, housingVar }) {
  const key = requireCensusKey();
  const params = new URLSearchParams({
    get: `${housingVar},NAME`,
    for: 'tract:*',
    in: `state:${WI_STATE_FIPS}`,
    key
  });
  const res = await fetch(`https://api.census.gov/data/${year}/${dataset}?${params.toString()}`);
  if (!res.ok) throw new Error(`Census ${year} ${dataset} query failed: HTTP ${res.status}`);
  const rows = await res.json();
  const [header, ...data] = rows;
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  return data.map((row) => ({
    geoid: row[idx.state] + row[idx.county] + row[idx.tract],
    housingUnits: parseInt(row[idx[housingVar]], 10)
  })).filter((r) => Number.isFinite(r.housingUnits));
}

async function upsertHousingUnits(client, geoid, year, housingUnits) {
  // Tracts that don't exist yet in census_tracts (e.g. 2010-vintage tract
  // boundaries that were split/merged by 2020) are skipped rather than
  // violating the FK -- logged so the gap is visible, not silent.
  const exists = await client.query('SELECT 1 FROM census_tracts WHERE geoid = $1', [geoid]);
  if (exists.rowCount === 0) return false;

  await client.query(
    `INSERT INTO housing_units_by_tract (geoid, census_year, housing_units)
     VALUES ($1, $2, $3)
     ON CONFLICT (geoid, census_year) DO UPDATE SET housing_units = EXCLUDED.housing_units`,
    [geoid, year, housingUnits]
  );
  return true;
}

async function run() {
  const client = await pool.connect();
  try {
    for (const yearConfig of CENSUS_YEARS) {
      console.log(`Fetching ${yearConfig.year} housing unit counts...`);
      const rows = await fetchHousingUnits(yearConfig);
      let loaded = 0;
      let skippedNoTract = 0;
      for (const { geoid, housingUnits } of rows) {
        const ok = await upsertHousingUnits(client, geoid, yearConfig.year, housingUnits);
        if (ok) loaded += 1; else skippedNoTract += 1;
      }
      console.log(`  ${yearConfig.year}: loaded ${loaded} tracts, skipped ${skippedNoTract} (no matching census_tracts row -- boundary changed between vintages)`);
    }
  } finally {
    client.release();
  }
  console.log('Done.');
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch((err) => {
      console.error('loadHousingUnits failed:', err.message);
      pool.end();
      process.exit(1);
    });
}

module.exports = { run };
