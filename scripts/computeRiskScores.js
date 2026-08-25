/* ============================================================
   WAFER -- computeRiskScores.js  (Phase 3)

   The analytical payoff of the whole pipeline. Computes, in order:

   1. gauge_trend (view) -- per-gauge flood-stage exceedance rate,
      full historical record vs. the most recent 30 years. A gauge
      counts as "trending up" when the recent rate exceeds the full-
      record rate by more than TREND_DELTA_THRESHOLD.
   2. tract_growth (view) -- % housing-unit change 2010->2020 per tract.
   3. risk_scores (table) -- for every tract, a PRIORITY tier driven by
      growth and gauge-trend proximity ALONE:
        - high   : growing, and within GAUGE_PROXIMITY_METERS of a
                   trending gauge -- the strongest evidence of colliding
                   risk and growth
        - medium : growing, but no confirmed nearby rising-trend gauge
        - low    : little or no recent growth

      Whether the tract is inside FEMA's mapped floodplain is still
      computed (ST_Intersects against flood_zones) and stored in
      `in_floodplain`, but it is deliberately NOT part of the priority
      tier above.

      Earlier version of this script used floodplain membership as the
      PRIMARY classification axis (in_floodplain / blind_spot / low_risk),
      with "blind spot" -- growth near a trending gauge but outside the
      map -- as the headline finding. That fell apart on inspection: once
      FEMA Zone X's minimal-hazard fill was correctly excluded, 79% of
      all tracts still intersected some real mapped floodplain (Wisconsin
      is extremely water-dense), which meant "in floodplain" wasn't
      discriminating much as the *first* thing every tract gets sorted
      by -- it was answering "is this on the map" before the more useful
      question "is risk and growth actually colliding here at all."
      Restructured so growth+trend is the primary signal for every tract
      regardless of map status, and `in_floodplain` is surfaced as an
      independent, secondary attribute in the API/frontend (a badge, not
      a bucket) -- so the FEMA-gap story ("X% of high-priority tracts
      aren't even on the official map") is still fully visible, just as
      the sharper follow-up finding it actually is, not the primary lens.

   Every tunable constant below is exactly that -- a documented starting
   point, not a validated finding.
   ============================================================ */
require('dotenv').config();
const pool = require('../db');

// A gauge's recent (last N years) exceedance rate must clear its full-
// record rate by this many percentage points to count as "trending up."
const TREND_DELTA_THRESHOLD = 0.10;
const RECENT_WINDOW_YEARS = 30;
// A trending gauge's "zone of relevance" for the high-priority tier.
const GAUGE_PROXIMITY_METERS = 15000; // 15km
// A gauge needs at least this many peak-flow records within the recent
// window to trust its recent rate -- otherwise one flood year out of one
// observation would read as a 100% recent exceedance rate, which is noise,
// not a trend.
const MIN_RECENT_OBSERVATIONS = 3;

// WAFER Score: growth near a trending gauge is amplified by how severe
// that gauge's trend actually is (gauge_exceedance_trend, a 0-1 fraction),
// so two "high" tracts aren't scored identically -- a tract near a gauge
// whose recent exceedance rate is way above its historical rate outranks
// one just barely over the threshold. Growth with no confirmed nearby
// trend still scores, but discounted -- real signal, just weaker evidence.
const TREND_AMPLIFICATION = 3.0;
const NO_TREND_DISCOUNT = 0.5;

const CREATE_VIEWS_SQL = `
CREATE OR REPLACE VIEW gauge_trend AS
WITH exceedance AS (
    SELECT gpf.site_no, gpf.peak_date,
           (gpf.peak_stage_ft >= g.flood_stage_ft) AS exceeded
    FROM gauge_peak_flows gpf
    JOIN gauges g ON g.site_no = gpf.site_no
    WHERE g.flood_stage_ft IS NOT NULL AND gpf.peak_stage_ft IS NOT NULL
),
full_record_rate AS (
    SELECT site_no, AVG(exceeded::int) AS rate, COUNT(*) AS n
    FROM exceedance GROUP BY site_no
),
recent_rate AS (
    SELECT site_no, AVG(exceeded::int) AS rate, COUNT(*) AS n
    FROM exceedance
    WHERE peak_date >= (CURRENT_DATE - INTERVAL '${RECENT_WINDOW_YEARS} years')
    GROUP BY site_no
)
SELECT
    f.site_no,
    f.rate AS full_record_rate, f.n AS full_record_n,
    r.rate AS recent_rate, r.n AS recent_n,
    (r.rate - f.rate) AS trend_delta,
    (r.rate - f.rate) > ${TREND_DELTA_THRESHOLD} AS is_trending_up
FROM full_record_rate f
JOIN recent_rate r ON r.site_no = f.site_no
WHERE r.n >= ${MIN_RECENT_OBSERVATIONS};

CREATE OR REPLACE VIEW tract_growth AS
SELECT
    geoid,
    MAX(housing_units) FILTER (WHERE census_year = 2020) AS hu_2020,
    MAX(housing_units) FILTER (WHERE census_year = 2010) AS hu_2010,
    CASE
        WHEN MAX(housing_units) FILTER (WHERE census_year = 2010) > 0
        THEN (MAX(housing_units) FILTER (WHERE census_year = 2020)
              - MAX(housing_units) FILTER (WHERE census_year = 2010))::numeric
             / MAX(housing_units) FILTER (WHERE census_year = 2010)
    END AS pct_growth
FROM housing_units_by_tract
GROUP BY geoid;
`;

const UPSERT_SCORES_SQL = `
INSERT INTO risk_scores (
    geoid, housing_units_2010, housing_units_2020, pct_housing_growth,
    in_floodplain, nearest_trending_gauge, gauge_exceedance_trend,
    classification, wafer_score, computed_at
)
SELECT
    ct.geoid,
    tg.hu_2010,
    tg.hu_2020,
    tg.pct_growth,
    -- Still computed and stored -- surfaced independently in the API/
    -- frontend as a badge, not used to determine the tier below.
    -- FEMA's NFHL layer includes Zone X twice over: the real 500-year
    -- shaded floodplain and a separate "AREA OF MINIMAL FLOOD HAZARD"
    -- fill covering most non-hazard land. The fill is excluded here
    -- (see the Phase 2 postmortem in Project_Plan.md for how that was
    -- caught) or this would read true for nearly every tract in the state.
    (fo.geoid IS NOT NULL) AS in_floodplain,
    ntg.site_no,
    ntg.trend_delta,
    CASE
        WHEN tg.pct_growth > 0 AND ntg.site_no IS NOT NULL THEN 'high'
        WHEN tg.pct_growth > 0 THEN 'medium'
        ELSE 'low'
    END AS classification,
    CASE
        WHEN tg.pct_growth IS NULL OR tg.pct_growth <= 0 THEN 0
        WHEN ntg.site_no IS NOT NULL
            THEN tg.pct_growth * 100 * (1 + ntg.trend_delta * ${TREND_AMPLIFICATION})
        ELSE tg.pct_growth * 100 * ${NO_TREND_DISCOUNT}
    END AS wafer_score,
    now()
FROM census_tracts ct
JOIN tract_growth tg ON tg.geoid = ct.geoid
LEFT JOIN (
    SELECT DISTINCT ct2.geoid
    FROM census_tracts ct2
    JOIN flood_zones fz ON ST_Intersects(ct2.geom, fz.geom)
    WHERE NOT (fz.flood_zone = 'X' AND fz.zone_subtype = 'AREA OF MINIMAL FLOOD HAZARD')
) fo ON fo.geoid = ct.geoid
LEFT JOIN LATERAL (
    SELECT g.site_no, gt.trend_delta
    FROM gauges g
    JOIN gauge_trend gt ON gt.site_no = g.site_no AND gt.is_trending_up
    WHERE ST_DWithin(ct.geom::geography, g.geom::geography, ${GAUGE_PROXIMITY_METERS})
    ORDER BY ST_Distance(ct.geom::geography, g.geom::geography) ASC
    LIMIT 1
) ntg ON true
ON CONFLICT (geoid) DO UPDATE SET
    housing_units_2010 = EXCLUDED.housing_units_2010,
    housing_units_2020 = EXCLUDED.housing_units_2020,
    pct_housing_growth = EXCLUDED.pct_housing_growth,
    in_floodplain = EXCLUDED.in_floodplain,
    nearest_trending_gauge = EXCLUDED.nearest_trending_gauge,
    gauge_exceedance_trend = EXCLUDED.gauge_exceedance_trend,
    classification = EXCLUDED.classification,
    wafer_score = EXCLUDED.wafer_score,
    computed_at = EXCLUDED.computed_at;
`;

const SANITY_CHECK_SQL = `
SELECT classification, COUNT(*) AS tracts,
       ROUND(AVG(pct_housing_growth) * 100, 1) AS avg_growth_pct,
       COUNT(*) FILTER (WHERE in_floodplain) AS also_in_floodplain,
       ROUND(100.0 * COUNT(*) FILTER (WHERE NOT in_floodplain) / COUNT(*), 1) AS pct_unmapped
FROM risk_scores GROUP BY classification ORDER BY classification;
`;

const TOP_TRACTS_SQL = `
SELECT ct.geoid, ct.tract_name, rs.classification, rs.in_floodplain,
       ROUND(rs.pct_housing_growth * 100, 1) AS growth_pct,
       rs.nearest_trending_gauge, ROUND(rs.wafer_score, 1) AS wafer_score
FROM risk_scores rs
JOIN census_tracts ct ON ct.geoid = rs.geoid
WHERE rs.wafer_score > 0
ORDER BY rs.wafer_score DESC
LIMIT 10;
`;

const TRENDING_GAUGES_SQL = `
SELECT g.site_no, g.station_name, gt.full_record_rate, gt.recent_rate, gt.trend_delta
FROM gauge_trend gt JOIN gauges g ON g.site_no = gt.site_no
WHERE gt.is_trending_up
ORDER BY gt.trend_delta DESC
LIMIT 10;
`;

async function run() {
  const client = await pool.connect();
  try {
    console.log('Creating/refreshing gauge_trend and tract_growth views...');
    await client.query(CREATE_VIEWS_SQL);

    console.log('Computing risk_scores for every Wisconsin tract...');
    const result = await client.query(UPSERT_SCORES_SQL);
    console.log(`Upserted ${result.rowCount} tract scores.`);

    console.log('\n--- Sanity check: priority tier breakdown (pct_unmapped = % of that tier NOT on FEMA\'s map) ---');
    const breakdown = await client.query(SANITY_CHECK_SQL);
    console.table(breakdown.rows);

    console.log('\n--- Sanity check: gauges classified as trending up ---');
    const trending = await client.query(TRENDING_GAUGES_SQL);
    console.table(trending.rows);
    if (trending.rowCount === 0) {
      console.warn('WARNING: zero gauges cleared the trend threshold. Either the ' +
        `${TREND_DELTA_THRESHOLD} threshold is too strict for the real data, or ` +
        'something upstream (flood_stage_ft coverage, peak-flow date range) is thinner ' +
        'than expected. Worth inspecting before trusting the high-priority tier.');
    }

    console.log('\n--- Top 10 tracts by WAFER Score (manual spot-check these against known growth areas) ---');
    const top = await client.query(TOP_TRACTS_SQL);
    console.table(top.rows);
  } finally {
    client.release();
  }
  console.log('\nDone.');
}

if (require.main === module) {
  run()
    .then(() => pool.end())
    .catch((err) => {
      console.error('computeRiskScores failed:', err);
      pool.end();
      process.exit(1);
    });
}

module.exports = { run };
