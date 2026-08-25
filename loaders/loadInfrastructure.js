/* ============================================================
   WAFER -- loadInfrastructure.js

   Populates `infrastructure` (hospitals, schools) for the exposure
   drill-down feature.

   *** Source changed from the original Scope.md plan -- read this. ***
   HIFLD Open, the originally-scoped national source, was shut down by
   DHS on 2025-08-26. The documented successor mirror (a NASA-hosted
   ArcGIS REST endpoint at maps.nccs.nasa.gov) turned out to be
   genuinely unreachable, not a sandbox artifact -- confirmed live from
   both the dev environment and the EC2 instance: the host resolves to
   an IPv6-only address (`curl -v` shows "IPv4: (none)"), and neither
   environment has IPv6 egress. Most standard cloud VPCs don't, so this
   mirror is impractical for real use, not just for us.

   Rebuilt instead against two live, IPv4-reachable, Wisconsin-specific
   sources -- arguably a better fit for a Wisconsin-scoped tool than a
   frozen national archive anyway:
     - Hospitals: WI DHS Facilities MapServer (layers 5 "Hospital" and
       10 "Critical Access Hospital" -- WI's licensing category for
       small rural hospitals, common enough in this state to matter)
       https://dhsgis.wi.gov/server/rest/services/DHS_GIS/Facilities/MapServer
     - Schools: WI DPI's statewide Public Schools layer
       https://services8.arcgis.com/o4NJgD3NfeHnWy06/arcgis/rest/services/Wisconsin_Public_Schools/FeatureServer/20
   Both verified live and IPv4-reachable from EC2.

   Fire/EMS and water treatment, the other two categories originally
   scoped, are dropped from this pass -- no clean statewide, live,
   IPv4-reachable source turned up for either without a disproportionate
   amount of searching. Worth revisiting if there's time, but hospitals
   and schools alone already cover the two facility types most central
   to a flood-exposure story (vulnerable populations, mass shelter-in-
   place sites), so this isn't a fatal gap, just a documented scope trim.
   ============================================================ */
require('dotenv').config();
const pool = require('../db');

const PAGE_SIZE = 1000;

const SOURCES = [
  {
    facilityType: 'hospital',
    url: 'https://dhsgis.wi.gov/server/rest/services/DHS_GIS/Facilities/MapServer/5/query',
    nameField: 'FACILITY_NAME',
    idField: 'OBJECTID',
    countyField: 'COUNTY_FIPS' // already a full FIPS code (e.g. 55079) on this source
  },
  {
    facilityType: 'hospital', // Critical Access Hospital is a WI licensing sub-type of hospital, not a distinct category for our purposes
    url: 'https://dhsgis.wi.gov/server/rest/services/DHS_GIS/Facilities/MapServer/10/query',
    nameField: 'FACILITY_NAME',
    idField: 'OBJECTID',
    countyField: 'COUNTY_FIPS'
  },
  {
    facilityType: 'school',
    url: 'https://services8.arcgis.com/o4NJgD3NfeHnWy06/arcgis/rest/services/Wisconsin_Public_Schools/FeatureServer/20/query',
    nameField: 'SCHOOL',
    idField: 'OBJECTID',
    countyField: null // no county FIPS field on this source; backfilled spatially below like geoid
  }
];

async function fetchAll(source) {
  const all = [];
  let offset = 0;
  let keepGoing = true;
  while (keepGoing) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      outSR: '4326',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
      f: 'geojson'
    });
    const res = await fetch(`${source.url}?${params.toString()}`);
    if (!res.ok) throw new Error(`Query failed for ${source.facilityType} (${source.url}): HTTP ${res.status}`);
    const page = await res.json();
    const features = page.features || [];
    all.push(...features);
    keepGoing = features.length === PAGE_SIZE;
    offset += PAGE_SIZE;
  }
  return all;
}

async function upsertFacility(client, feature, source) {
  if (!feature.geometry || feature.geometry.type !== 'Point') return false;
  const p = feature.properties;
  const name = p[source.nameField] || 'Unnamed facility';
  const sourceId = p[source.idField];
  const countyFips = source.countyField ? String(p[source.countyField] || '').padStart(5, '0') || null : null;
  const [lon, lat] = feature.geometry.coordinates;

  await client.query(
    `INSERT INTO infrastructure (source_id, facility_name, facility_type, county_fips, geom)
     VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326))`,
    [sourceId ? String(sourceId) : null, name, source.facilityType, countyFips, lon, lat]
  );
  return true;
}

async function backfillGeoid(client) {
  // Denormalized geoid, set via spatial join rather than looked up per-row
  // at insert time -- also fills county_fips for the schools source, which
  // doesn't supply one directly.
  const result = await client.query(
    `UPDATE infrastructure i SET
       geoid = ct.geoid,
       county_fips = COALESCE(i.county_fips, ct.county_fips)
     FROM census_tracts ct
     WHERE i.geoid IS NULL AND ST_Contains(ct.geom, i.geom)`
  );
  return result.rowCount;
}

async function run() {
  const client = await pool.connect();
  let total = 0;
  try {
    await client.query('DELETE FROM infrastructure'); // fully re-derived each refresh

    for (const source of SOURCES) {
      console.log(`Fetching ${source.facilityType} from ${source.url}...`);
      const features = await fetchAll(source);
      let loaded = 0;
      for (const feature of features) {
        const ok = await upsertFacility(client, feature, source);
        if (ok) loaded += 1;
      }
      console.log(`  Loaded ${loaded} ${source.facilityType} points.`);
      total += loaded;
    }

    console.log('Backfilling tract geoid (and county_fips for schools) via spatial join...');
    const updated = await backfillGeoid(client);
    console.log(`  ${updated} facilities matched to a tract.`);
  } finally {
    client.release();
  }
  console.log(`Done. Loaded ${total} infrastructure points total.`);
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch((err) => {
      console.error('loadInfrastructure failed:', err.message);
      pool.end();
      process.exit(1);
    });
}

module.exports = { run };
