/* ============================================================
   WAFER -- server.js
   Geography 576 | Noah Kirchner
   Express REST API over the PostGIS schema in schema.sql. Read-only --
   all writes happen in the loaders (loaders/) and the scoring job
   (scripts/computeRiskScores.js), never here.

   CORS: wide open (no origin restriction) rather than a specific origin
   string -- Lab 6 lost time to a trailing-slash mismatch in an exact
   origin string; since this is a public read-only data API with no
   auth and no write routes, there's no reason to reintroduce that
   failure mode for a benefit (origin locking) that doesn't apply here.
   ============================================================ */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.static(`${__dirname}/public`));

const PORT = process.env.PORT || 3000;

// Default map/query result cap for endpoints that could otherwise return
// a very large payload (flood zones especially -- tens of thousands of
// polygons statewide). Tracts and gauges are small enough statewide
// (~1,542 and ~140 rows) to not need this.
const FLOODZONE_LIMIT = 5000;

/* GET /risk/:geoid -- one tract's score + components */
app.get('/risk/:geoid', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT rs.geoid, rs.classification, rs.wafer_score, rs.pct_housing_growth,
              rs.housing_units_2010, rs.housing_units_2020, rs.in_floodplain,
              rs.nearest_trending_gauge, rs.gauge_exceedance_trend, rs.computed_at,
              ct.tract_name, ct.county_fips, ct.median_household_income, ct.poverty_rate
       FROM risk_scores rs
       JOIN census_tracts ct ON ct.geoid = rs.geoid
       WHERE rs.geoid = $1`,
      [req.params.geoid]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Tract not found or not yet scored' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* GET /catalog -- statewide ranked list, filterable
   Query params: classification (in_floodplain|blind_spot|low_risk), maxIncome */
app.get('/catalog', async (req, res) => {
  try {
    const { classification, maxIncome } = req.query;
    const result = await pool.query(
      `SELECT rs.geoid, ct.tract_name, ct.county_fips, rs.classification,
              rs.wafer_score, rs.pct_housing_growth, rs.in_floodplain,
              ct.median_household_income, ct.poverty_rate
       FROM risk_scores rs
       JOIN census_tracts ct ON ct.geoid = rs.geoid
       WHERE ($1::text IS NULL OR rs.classification = $1)
         AND ($2::numeric IS NULL OR ct.median_household_income <= $2)
       ORDER BY rs.wafer_score DESC`,
      [classification || null, maxIncome || null]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* GET /gauges -- all gauges + trend status, for map markers */
app.get('/gauges', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT g.site_no, g.station_name, g.flood_stage_ft,
              ST_X(g.geom) AS lon, ST_Y(g.geom) AS lat,
              gt.full_record_rate, gt.recent_rate, gt.trend_delta,
              COALESCE(gt.is_trending_up, false) AS is_trending_up
       FROM gauges g
       LEFT JOIN gauge_trend gt ON gt.site_no = g.site_no`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* GET /gauges/:site_no/trend -- one gauge's full peak-flow history + trend,
   for the Phase 8 trend-line chart */
app.get('/gauges/:site_no/trend', async (req, res) => {
  try {
    const gauge = await pool.query(
      `SELECT g.site_no, g.station_name, g.flood_stage_ft,
              gt.full_record_rate, gt.full_record_n,
              gt.recent_rate, gt.recent_n, gt.trend_delta,
              COALESCE(gt.is_trending_up, false) AS is_trending_up
       FROM gauges g
       LEFT JOIN gauge_trend gt ON gt.site_no = g.site_no
       WHERE g.site_no = $1`,
      [req.params.site_no]
    );
    if (gauge.rowCount === 0) return res.status(404).json({ error: 'Gauge not found' });

    const series = await pool.query(
      `SELECT peak_date, peak_stage_ft, peak_discharge_cfs
       FROM gauge_peak_flows WHERE site_no = $1 ORDER BY peak_date`,
      [req.params.site_no]
    );
    res.json({ gauge: gauge.rows[0], series: series.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* GET /infrastructure/exposed/:geoid -- infrastructure inside one tract.
   geoid was already resolved onto each infrastructure row at load time
   (spatial join in the loader), so this is a plain indexed lookup, not
   a spatial query at request time. */
app.get('/infrastructure/exposed/:geoid', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, source_id, facility_name, facility_type, county_fips,
              ST_X(geom) AS lon, ST_Y(geom) AS lat
       FROM infrastructure WHERE geoid = $1`,
      [req.params.geoid]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* GET /tracts -- statewide tract polygons + classification, for the
   choropleth map layer. ~1,542 rows statewide -- small enough to return
   whole, no pagination needed. */
app.get('/tracts', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ct.geoid, ct.tract_name, ct.county_fips,
              COALESCE(rs.classification, 'unscored') AS classification,
              rs.wafer_score, rs.pct_housing_growth, rs.in_floodplain,
              ST_AsGeoJSON(ct.geom)::json AS geometry
       FROM census_tracts ct
       LEFT JOIN risk_scores rs ON rs.geoid = ct.geoid`
    );
    res.json(toFeatureCollection(result.rows, (row) => {
      const { geometry, ...properties } = row;
      return { geometry, properties };
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/* GET /floodzones -- flood zone polygons for the map layer.
   Query params: bbox=minLon,minLat,maxLon,maxLat (recommended -- keeps
   the response to what's actually in view). Without one, returns up to
   FLOODZONE_LIMIT polygons statewide, arbitrarily ordered -- fine for a
   quick check, not for a real map render. The frontend (Phase 5) should
   always pass a bbox from the current Leaflet viewport. */
// Flood zone polygons can carry thousands of vertices each (real river/
// floodplain boundaries), which was making them slow to transfer and
// render -- especially painful since they're refetched on every pan/zoom.
// ST_SimplifyPreserveTopology at a zoom-appropriate tolerance cuts vertex
// count sharply at wide zooms, where that detail isn't visible anyway,
// and only serves full resolution once actually zoomed in close.
function simplifyToleranceForZoom(zoom) {
  const z = Number(zoom);
  if (!Number.isFinite(z)) return 0.003;
  if (z >= 13) return 0.0003;
  if (z >= 11) return 0.001;
  return 0.005;
}

app.get('/floodzones', async (req, res) => {
  try {
    const { bbox, zoom } = req.query;
    const tolerance = simplifyToleranceForZoom(zoom);
    let result;
    if (bbox) {
      const [minLon, minLat, maxLon, maxLat] = bbox.split(',').map(Number);
      if ([minLon, minLat, maxLon, maxLat].some(Number.isNaN)) {
        return res.status(400).json({ error: 'bbox must be minLon,minLat,maxLon,maxLat' });
      }
      result = await pool.query(
        `SELECT flood_zone, zone_subtype, county_fips,
                ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, $6))::json AS geometry
         FROM flood_zones
         WHERE ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
           AND NOT (flood_zone = 'X' AND zone_subtype = 'AREA OF MINIMAL FLOOD HAZARD')
         LIMIT $5`,
        [minLon, minLat, maxLon, maxLat, FLOODZONE_LIMIT, tolerance]
      );
    } else {
      result = await pool.query(
        `SELECT flood_zone, zone_subtype, county_fips,
                ST_AsGeoJSON(ST_SimplifyPreserveTopology(geom, $2))::json AS geometry
         FROM flood_zones
         WHERE NOT (flood_zone = 'X' AND zone_subtype = 'AREA OF MINIMAL FLOOD HAZARD')
         LIMIT $1`,
        [FLOODZONE_LIMIT, tolerance]
      );
    }
    res.json(toFeatureCollection(result.rows, (row) => {
      const { geometry, ...properties } = row;
      return { geometry, properties };
    }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function toFeatureCollection(rows, toFeatureParts) {
  return {
    type: 'FeatureCollection',
    features: rows.map((row) => {
      const { geometry, properties } = toFeatureParts(row);
      return { type: 'Feature', geometry, properties };
    })
  };
}

app.get('/api/status', (req, res) => {
  res.json({ status: 'ok', name: 'WAFER API', routes: [
    'GET /risk/:geoid', 'GET /catalog', 'GET /gauges', 'GET /gauges/:site_no/trend',
    'GET /infrastructure/exposed/:geoid', 'GET /tracts', 'GET /floodzones'
  ] });
});

app.listen(PORT, () => {
  console.log(`WAFER API listening on port ${PORT}`);
});
