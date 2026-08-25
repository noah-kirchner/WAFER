/* ============================================================
   WAFER -- loadACS.js

   Populates `census_tracts` -- both the geometry (from TIGERweb, which
   has no attribute data) and the ACS demographic/fiscal-capacity fields
   (from the Census ACS API, which has no geometry). Two sources, joined
   by GEOID, because neither Census endpoint supplies both.

   Geometry:  https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0
              Verified live on 2026-08-23, keyless, paginated.
   Attributes: https://api.census.gov/data/{year}/acs/acs5
              Requires a free key (CENSUS_API_KEY) -- api.census.gov now
              302-redirects to a "missing key" page without one. Register at
              https://api.census.gov/data/key_signup.html

   B19013_001E = median household income
   B17001_002E / B17001_001E = poverty rate (population below poverty line
   over the poverty-status-determined population)
   ============================================================ */
require('dotenv').config();
const pool = require('../db');

const WI_STATE_FIPS = '55';
const ACS_YEAR = 2022; // most recent 5-year ACS release at time of writing
const TIGERWEB_LAYER_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Tracts_Blocks/MapServer/0/query';
const PAGE_SIZE = 1000;

function requireCensusKey() {
  const key = process.env.CENSUS_API_KEY;
  if (!key) {
    throw new Error(
      'CENSUS_API_KEY is not set. api.census.gov requires a free key as of this ' +
      'writing -- sign up at https://api.census.gov/data/key_signup.html and add it to .env'
    );
  }
  return key;
}

async function fetchTractGeometry() {
  let offset = 0;
  let keepGoing = true;
  const geomByGeoid = {};
  while (keepGoing) {
    const params = new URLSearchParams({
      where: `STATE='${WI_STATE_FIPS}'`,
      outFields: 'GEOID,COUNTY',
      outSR: '4326',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
      f: 'geojson'
    });
    const res = await fetch(`${TIGERWEB_LAYER_URL}?${params.toString()}`);
    if (!res.ok) throw new Error(`TIGERweb query failed: HTTP ${res.status}`);
    const page = await res.json();
    const features = page.features || [];
    for (const f of features) {
      geomByGeoid[f.properties.GEOID] = {
        geometry: f.geometry,
        countyFips: f.properties.COUNTY
      };
    }
    console.log(`  ...${Object.keys(geomByGeoid).length} tract geometries fetched so far`);
    keepGoing = features.length === PAGE_SIZE;
    offset += PAGE_SIZE;
  }
  return geomByGeoid;
}

async function fetchAcsAttributes() {
  const key = requireCensusKey();
  const params = new URLSearchParams({
    get: 'B19013_001E,B17001_002E,B17001_001E,NAME',
    for: 'tract:*',
    in: `state:${WI_STATE_FIPS}`,
    key
  });
  const res = await fetch(`https://api.census.gov/data/${ACS_YEAR}/acs/acs5?${params.toString()}`);
  if (!res.ok) throw new Error(`Census ACS query failed: HTTP ${res.status}`);
  const rows = await res.json();
  const [header, ...data] = rows;
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  const attrsByGeoid = {};
  for (const row of data) {
    const geoid = row[idx.state] + row[idx.county] + row[idx.tract];
    const income = parseFloat(row[idx.B19013_001E]);
    const belowPoverty = parseFloat(row[idx.B17001_002E]);
    const povertyUniverse = parseFloat(row[idx.B17001_001E]);
    attrsByGeoid[geoid] = {
      tractName: row[idx.NAME],
      medianHouseholdIncome: Number.isFinite(income) && income >= 0 ? income : null,
      povertyRate: povertyUniverse > 0 ? (belowPoverty / povertyUniverse) * 100 : null
    };
  }
  return attrsByGeoid;
}

async function upsertTract(client, geoid, countyFips, geomJson, attrs) {
  await client.query(
    `INSERT INTO census_tracts (geoid, county_fips, tract_name, median_household_income, poverty_rate, geom)
     VALUES ($1, $2, $3, $4, $5, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($6), 4326)))
     ON CONFLICT (geoid) DO UPDATE SET
       county_fips = EXCLUDED.county_fips,
       tract_name = EXCLUDED.tract_name,
       median_household_income = EXCLUDED.median_household_income,
       poverty_rate = EXCLUDED.poverty_rate,
       geom = EXCLUDED.geom`,
    [geoid, countyFips, attrs ? attrs.tractName : null,
     attrs ? attrs.medianHouseholdIncome : null, attrs ? attrs.povertyRate : null, geomJson]
  );
}

async function run() {
  console.log('Fetching Wisconsin tract geometry from TIGERweb...');
  const geomByGeoid = await fetchTractGeometry();
  console.log(`Fetched geometry for ${Object.keys(geomByGeoid).length} tracts.`);

  console.log('Fetching ACS demographic attributes...');
  const attrsByGeoid = await fetchAcsAttributes();
  console.log(`Fetched ACS attributes for ${Object.keys(attrsByGeoid).length} tracts.`);

  const client = await pool.connect();
  let loaded = 0;
  let missingAttrs = 0;
  try {
    for (const [geoid, { geometry, countyFips }] of Object.entries(geomByGeoid)) {
      const attrs = attrsByGeoid[geoid];
      if (!attrs) missingAttrs += 1;
      await upsertTract(client, geoid, countyFips, JSON.stringify(geometry), attrs);
      loaded += 1;
    }
  } finally {
    client.release();
  }
  console.log(`Done. Loaded ${loaded} tracts (${missingAttrs} had no matching ACS row -- geometry-only, income/poverty left NULL).`);
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch((err) => {
      console.error('loadACS failed:', err.message);
      pool.end();
      process.exit(1);
    });
}

module.exports = { run };
