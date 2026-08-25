/* ============================================================
   WAFER -- loadFloodZones.js

   Populates `flood_zones` from FEMA's National Flood Hazard Layer,
   layer 28 ("Flood Hazard Zones") of the public NFHL MapServer.
   Verified live on 2026-08-23:
   https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28

   Batched by Wisconsin county rather than one statewide crawl -- a real
   design change made after the first two live runs. Reasons:

   1. Resumability. FEMA's server occasionally 500s regardless of page
      size (see fetchPageWithRetry below), and the AWS Academy Learner
      Lab session cap can end a run mid-flight with zero warning -- both
      have now happened for real. Upserting on FEMA's own OBJECTID (a
      real per-feature unique ID, confirmed present on this layer) means
      a rerun after an interruption is a cheap no-op for counties already
      loaded, not a wasted full-state restart. The old version deleted
      the whole table and reloaded from offset 0 every run; this version
      never deletes anything.
   2. Smaller per-request result sets are inherently less likely to hit
      FEMA's response-size sensitivity in the first place (see the
      PAGE_SIZE comment below), on top of the existing retry/skip logic.
   3. It's the natural unit for progress reporting and for tagging
      county_fips on each row -- which FEMA's own data doesn't provide
      cleanly, so this loader now derives it from which county's query
      found the polygon (see the caveat on that below).

   County boundaries come from TIGERweb (same source as loadACS.js),
   fetched once at the start, not stored -- this loader owns no new
   external dependency beyond what's already in the project.
   ============================================================ */
require('dotenv').config();
const pool = require('../db');

const NFHL_LAYER_URL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query';
const TIGERWEB_COUNTY_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1/query';
const WI_STATE_FIPS = '55';

// FEMA's advertised maxRecordCount for this layer is 2000, but in practice
// the server 500s well below that -- confirmed live: 200 succeeds, 500 does
// not. Flood zone polygons are geometrically heavy, so this is a
// response-size limit in disguise, not a simple record-count cap.
const PAGE_SIZE = 200;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCounties() {
  const params = new URLSearchParams({
    where: `STATE='${WI_STATE_FIPS}'`,
    outFields: 'GEOID,NAME,COUNTY',
    outSR: '4326',
    f: 'geojson'
  });
  const res = await fetch(`${TIGERWEB_COUNTY_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`TIGERweb county query failed: HTTP ${res.status}`);
  const data = await res.json();
  return data.features.map((f) => {
    const coords = flattenCoords(f.geometry);
    const lons = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    return {
      geoid: f.properties.GEOID,
      name: f.properties.NAME,
      countyFips: f.properties.COUNTY,
      bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]
    };
  });
}

function flattenCoords(geometry) {
  // Handles Polygon and MultiPolygon -- all we need is every vertex, to
  // compute a bounding box; ring/part structure doesn't matter for that.
  const out = [];
  const walk = (arr) => {
    if (typeof arr[0] === 'number') { out.push(arr); return; }
    arr.forEach(walk);
  };
  walk(geometry.coordinates);
  return out;
}

async function alreadyLoaded(client, countyFips) {
  const result = await client.query('SELECT 1 FROM flood_zones WHERE county_fips = $1 LIMIT 1', [countyFips]);
  return result.rowCount > 0;
}

async function fetchPage(bbox, offset) {
  const params = new URLSearchParams({
    where: '1=1',
    geometry: bbox.join(','),
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: 'OBJECTID,FLD_ZONE,ZONE_SUBTY,DFIRM_ID',
    outSR: '4326',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    f: 'geojson'
  });
  const res = await fetch(`${NFHL_LAYER_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`FEMA NFHL query failed: HTTP ${res.status}`);
  return res.json();
}

// FEMA's server intermittently 500s on individual pages regardless of size
// -- confirmed live across two prior runs. Retry with backoff, and if a
// page still fails, skip it and keep going rather than losing the whole
// county over one bad page.
async function fetchPageWithRetry(bbox, offset) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fetchPage(bbox, offset);
    } catch (err) {
      if (attempt === 3) {
        console.warn(`    Page at offset ${offset} failed 3x (${err.message}) -- skipping this page.`);
        return null;
      }
      await sleep(500 * attempt);
    }
  }
  return null;
}

async function upsertZone(client, feature, countyFips) {
  const p = feature.properties;
  const geomJson = JSON.stringify(feature.geometry);
  // ON CONFLICT (objectid): a polygon spanning two counties' bounding
  // boxes gets fetched twice; the second upsert just overwrites
  // county_fips with whichever county queried it more recently. That
  // makes county_fips approximate for boundary-spanning polygons -- fine
  // for a reference attribute, since Phase 3's actual floodplain
  // classification uses ST_Intersects on geometry, not this column.
  await client.query(
    `INSERT INTO flood_zones (objectid, fema_zone_id, flood_zone, zone_subtype, county_fips, geom)
     VALUES ($1, $2, $3, $4, $5, ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($6), 4326)))
     ON CONFLICT (objectid) DO UPDATE SET
       fema_zone_id = EXCLUDED.fema_zone_id,
       flood_zone = EXCLUDED.flood_zone,
       zone_subtype = EXCLUDED.zone_subtype,
       county_fips = EXCLUDED.county_fips,
       geom = EXCLUDED.geom`,
    [p.OBJECTID, p.DFIRM_ID || null, p.FLD_ZONE || 'UNK', p.ZONE_SUBTY || null, countyFips, geomJson]
  );
}

async function loadCounty(client, county) {
  let countyTotal = 0;
  let consecutiveFailures = 0;
  let offset = 0;
  let keepGoing = true;

  while (keepGoing) {
    const page = await fetchPageWithRetry(county.bbox, offset);

    if (page === null) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= 5) {
        console.error(`    5 consecutive page failures in ${county.name} -- moving to the next county (this one is incomplete).`);
        break;
      }
      offset += PAGE_SIZE;
      continue;
    }

    consecutiveFailures = 0;
    const features = page.features || [];
    for (const feature of features) {
      if (!feature.geometry) continue; // NFHL occasionally returns null-geometry rows
      await upsertZone(client, feature, county.countyFips);
      countyTotal += 1;
    }
    keepGoing = features.length === PAGE_SIZE;
    offset += PAGE_SIZE;
  }
  return countyTotal;
}

async function run() {
  console.log('Fetching Wisconsin county boundaries from TIGERweb...');
  const counties = await fetchCounties();
  console.log(`Found ${counties.length} counties.`);

  const client = await pool.connect();
  let grandTotal = 0;
  let countiesLoaded = 0;
  let countiesSkipped = 0;
  try {
    for (const county of counties) {
      if (await alreadyLoaded(client, county.countyFips)) {
        countiesSkipped += 1;
        continue;
      }
      const count = await loadCounty(client, county);
      grandTotal += count;
      countiesLoaded += 1;
      console.log(`  [${countiesLoaded + countiesSkipped}/${counties.length}] ${county.name}: ${count} polygons`);
    }
  } finally {
    client.release();
  }
  console.log(`\nDone. Loaded ${countiesLoaded} counties (${grandTotal} polygons this run), ${countiesSkipped} already had data and were skipped.`);
  if (countiesSkipped > 0) {
    console.log('To force a refresh of an already-loaded county, delete its rows first: DELETE FROM flood_zones WHERE county_fips = \'XXX\';');
  }
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch((err) => {
      console.error('loadFloodZones failed:', err);
      pool.end();
      process.exit(1);
    });
}

module.exports = { run };
