/* ============================================================
   WAFER -- loadGaugePeakFlows.js

   Populates `gauges` and `gauge_peak_flows`.

   Two live sources, joined by USGS site number:
     1. NOAA National Water Prediction Service (NWPS) -- bulk gauge list
        and per-gauge detail, which supplies the NWS "minor" flood-stage
        threshold and, critically, the `usgsId` crosswalk field.
        https://api.water.noaa.gov/nwps/v1/gauges
     2. USGS NWIS legacy peak-flow service -- full historical annual
        peak-streamflow record per site, tab-delimited (RDB) format.
        https://nwis.waterdata.usgs.gov/usa/nwis/peak/

   Verified live on 2026-08-23: both endpoints return real Wisconsin data
   with the field names this script expects. Not every NWPS gauge has a
   `usgsId` or a `flood.categories.minor` threshold -- those gauges are
   skipped rather than inserted with made-up values.
   ============================================================ */
require('dotenv').config();
const pool = require('../db');

const NWPS_BASE = 'https://api.water.noaa.gov/nwps/v1';
const USGS_PEAK_BASE = 'https://nwis.waterdata.usgs.gov/usa/nwis/peak/';
const REQUEST_DELAY_MS = 150; // be a polite citizen of two free public APIs

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parses USGS RDB (tab-delimited) text into an array of row objects.
 * RDB format: lines starting with '#' are comments, the first non-comment
 * line is the header row, the second is a field-width/type code row (skipped),
 * every line after that is data.
 */
function parseRDB(text) {
  const lines = text.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  const dataLines = lines.slice(2); // skip the format-code row
  return dataLines
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const cols = line.split('\t');
      const row = {};
      headers.forEach((h, i) => { row[h] = cols[i]; });
      return row;
    });
}

async function fetchWiGauges() {
  const res = await fetch(`${NWPS_BASE}/gauges?format=json`);
  if (!res.ok) throw new Error(`NWPS bulk gauge list failed: HTTP ${res.status}`);
  const data = await res.json();
  const gauges = Array.isArray(data) ? data : data.gauges;
  return gauges.filter((g) => g.state && g.state.abbreviation === 'WI');
}

async function fetchGaugeDetail(lid) {
  const res = await fetch(`${NWPS_BASE}/gauges/${lid}`);
  if (!res.ok) return null;
  return res.json();
}

async function fetchPeakFlows(siteNo) {
  const url = `${USGS_PEAK_BASE}?site_no=${siteNo}&agency_cd=USGS&format=rdb`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const text = await res.text();
  return parseRDB(text);
}

async function upsertGauge(client, { site_no, station_name, county_fips, flood_stage_ft, lat, lon }) {
  await client.query(
    `INSERT INTO gauges (site_no, station_name, county_fips, flood_stage_ft, geom)
     VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326))
     ON CONFLICT (site_no) DO UPDATE SET
       station_name = EXCLUDED.station_name,
       county_fips = EXCLUDED.county_fips,
       flood_stage_ft = EXCLUDED.flood_stage_ft,
       geom = EXCLUDED.geom`,
    [site_no, station_name, county_fips, flood_stage_ft, lon, lat]
  );
}

/**
 * USGS peak-flow dates are sometimes only precise to the month or year --
 * older records store the unknown component as "00" (e.g. "1937-02-00"
 * means "day unknown", "1937-00-00" means "month and day unknown"), which
 * Postgres correctly rejects as an invalid date. Since gauge_peak_flows is
 * only ever bucketed by decade (see Schema.md's Phase 3 sketch), snapping
 * an unknown month/day to "01" is a harmless approximation here -- it would
 * not be for anything requiring day-level precision.
 */
function sanitizePeakDate(raw) {
  if (!raw) return null;
  const parts = raw.split('-');
  if (parts.length !== 3) return null;
  const [y, m, d] = parts;
  if (!/^\d{4}$/.test(y)) return null;
  const month = m === '00' ? '01' : m;
  const day = d === '00' ? '01' : d;
  return `${y}-${month}-${day}`;
}

async function upsertPeakFlow(client, siteNo, row) {
  const peakDate = sanitizePeakDate(row.peak_dt);
  if (!peakDate) return; // some historic rows omit the date entirely; skip those
  const stage = row.gage_ht ? parseFloat(row.gage_ht) : null;
  const discharge = row.peak_va ? parseFloat(row.peak_va) : null;
  await client.query(
    `INSERT INTO gauge_peak_flows (site_no, peak_date, peak_stage_ft, peak_discharge_cfs)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (site_no, peak_date) DO UPDATE SET
       peak_stage_ft = EXCLUDED.peak_stage_ft,
       peak_discharge_cfs = EXCLUDED.peak_discharge_cfs`,
    [siteNo, peakDate, stage, discharge]
  );
}

async function run() {
  console.log('Fetching Wisconsin gauge list from NWPS...');
  const wiGauges = await fetchWiGauges();
  console.log(`Found ${wiGauges.length} NWPS gauges in Wisconsin.`);

  const client = await pool.connect();
  let loadedGauges = 0;
  let skippedNoUsgsId = 0;
  let totalPeakRecords = 0;

  try {
    for (const gauge of wiGauges) {
      const detail = await fetchGaugeDetail(gauge.lid);
      await sleep(REQUEST_DELAY_MS);

      if (!detail || !detail.usgsId) {
        skippedNoUsgsId += 1;
        continue;
      }

      const floodStage = detail.flood && detail.flood.categories && detail.flood.categories.minor
        ? detail.flood.categories.minor.stage
        : null;

      await upsertGauge(client, {
        site_no: detail.usgsId,
        station_name: detail.name,
        county_fips: null, // NWPS gives a county *name*, not FIPS; resolved at query time via spatial join instead
        flood_stage_ft: floodStage,
        lat: detail.latitude,
        lon: detail.longitude
      });
      loadedGauges += 1;

      const peakRows = await fetchPeakFlows(detail.usgsId);
      for (const row of peakRows) {
        await upsertPeakFlow(client, detail.usgsId, row);
        totalPeakRecords += 1;
      }
      await sleep(REQUEST_DELAY_MS);

      if (loadedGauges % 25 === 0) {
        console.log(`  ...${loadedGauges} gauges loaded so far`);
      }
    }
  } finally {
    client.release();
  }

  console.log(`Done. Loaded ${loadedGauges} gauges, skipped ${skippedNoUsgsId} (no USGS crosswalk), ${totalPeakRecords} peak-flow records.`);
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch((err) => {
      console.error('loadGaugePeakFlows failed:', err);
      pool.end();
      process.exit(1);
    });
}

module.exports = { run, parseRDB, sanitizePeakDate };
