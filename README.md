# WAFER — Wisconsin Analysis of Flood / Expansion Risk

**Geography 576 — Final Project**
Noah Kirchner | University of Wisconsin–Madison

---

## Overview

WAFER identifies Wisconsin census tracts where new housing growth is concentrating in places with rising, physically-measured flood risk — including tracts that sit outside FEMA's official floodplain maps, which are widely documented as outdated and unable to capture increased heavy-rainfall intensity.

Rather than measuring flood risk from insurance claims — unreliable in Wisconsin, where NFIP take-up is roughly 1-2% and claims mostly reflect who bought a policy, not who actually flooded — WAFER measures risk directly from decades of USGS gauge history: how often a river has actually exceeded its flood stage, comparing the full historical record to the most recent 30 years. That trend is compared against tract-level (not county-level) Census housing growth, and intersected spatially against both the FEMA floodplain boundary and the watershed of each trending gauge, to surface tracts where growth is colliding with risk the official maps don't show.

For questions, comments, or other feedback, please contact Noah Kirchner (npkirchner@wisc.edu).

**Live Application:** http://54.235.176.178:3000

---

## Features

| View | Description |
|------|-------------|
| **Map** | Statewide Leaflet map: tract choropleth colored by classification (with a plain-language tagline and WAFER Score percentile context in each popup), gauge markers (styled by trend status, with an inline peak-stage history chart per gauge), FEMA floodplain polygons (loaded per viewport, geometry-simplified by zoom level for speed), and a live exposed-infrastructure list per tract popup. |
| **Query** | Filter tracts by county and classification. Results link back to the map and export to CSV. |
| **Catalog** | Statewide ranking of all 1,542 tracts by WAFER Score, filterable by classification, exportable to CSV. |
| **About** | Methodology, classifications, data sources, and known limitations. |

---

## Data Sources

| Dataset | Source | Update Frequency |
|---------|--------|-------------------|
| Streamgage peak-flow history | USGS National Water Information System | Historical archive; a handful of new records per gauge per year |
| Flood-stage thresholds | NOAA National Water Prediction Service | Static per gauge (NWS-maintained) |
| Regulatory floodplain polygons | FEMA National Flood Hazard Layer | Periodic (FEMA-maintained) |
| Tract demographics + geometry | U.S. Census Bureau (ACS 5-Year, TIGERweb) | Annual |
| Tract housing-unit counts | U.S. Census Bureau (Decennial, 2010 & 2020) | Every 10 years |
| Hospitals | Wisconsin DHS Facilities service | Periodic (state-maintained) |
| Public schools | Wisconsin DPI Public Schools layer | Periodic (state-maintained) |

No data is stored as manual downloads — every source above is a live, re-runnable API pull.

---

## Architecture

```
app/
├── server.js              # Express REST API + static frontend host
├── db.js                  # Shared PostGIS connection pool
├── schema.sql              # Full database schema (run once)
├── loaders/                 # One script per external data source
│   ├── loadACS.js             # Census ACS + TIGERweb tract geometry
│   ├── loadHousingUnits.js    # Census Decennial housing units
│   ├── loadFloodZones.js      # FEMA NFHL, batched by WI county, resumable
│   ├── loadGaugePeakFlows.js  # NWPS + USGS peak-flow history
│   ├── loadInfrastructure.js  # WI DHS hospitals + WI DPI schools
│   └── runAllLoaders.js       # Orchestrator, dependency-ordered
├── scripts/
│   └── computeRiskScores.js  # Phase 3: the actual analytical payoff
└── public/                  # Static frontend
    ├── index.html
    ├── css/style.css
    └── js/main.js
```

**Backend:** Node/Express on AWS EC2, PostgreSQL + PostGIS on AWS RDS — the same infrastructure built in Labs 6-7, reused rather than rebuilt. All writes happen in `loaders/` (ingestion) and `scripts/computeRiskScores.js` (analysis); `server.js` is read-only.

**No build step.** Vanilla JS frontend, CDN-loaded Leaflet, no bundler or framework.

---

## Setup & Local Development

Requires an existing PostgreSQL/PostGIS instance (this project was built against AWS RDS) and Node 18+.

```bash
git clone <repo-url>
cd app
npm install
cp .env.example .env   # fill in pgUser/pgPassword/pgHost/pgPort/targetDB and CENSUS_API_KEY
psql -h $pgHost -U $pgUser -d $targetDB -f schema.sql
npm run load:acs          # must run first -- creates census_tracts
npm run load:housing
npm run load:floodzones
npm run load:gauges
npm run load:infrastructure
npm run score              # computes risk_scores -- rerun any time the above sources refresh
npm start                  # serves the API + frontend on :3000
```

A free Census API key is required (`api.census.gov` 302-redirects without one): https://api.census.gov/data/key_signup.html

---

## Query / Classification Logic

Every tract gets a **priority tier**, computed in `scripts/computeRiskScores.js`, driven by growth and nearby flood-risk trend alone:

- **High Priority** — the tract has positive 2010→2020 housing growth and is within 15km (`ST_DWithin`) of a USGS gauge whose recent (30-year) flood-stage exceedance rate exceeds its full-record rate by more than 10 percentage points.
- **Moderate Priority** — positive growth, but no nearby gauge currently shows a confirmed rising trend.
- **Low Priority** — little or no recent growth.

Whether the tract falls inside FEMA's mapped 100/500-year floodplain (`ST_Intersects`) is computed and stored separately (`in_floodplain`) and shown as an independent attribute in the UI, not folded into the tier above.

**Why floodplain status isn't the primary signal:** an earlier version classified tracts by FEMA map membership first — "in the map" vs. a "blind spot" outside it. That fell apart once FEMA's Zone X minimal-hazard fill layer was correctly excluded from ingestion: 79% of all Wisconsin tracts still genuinely intersected some mapped floodplain, since Wisconsin is extremely water-dense. A signal that's true for four out of five tracts isn't discriminating much as the primary axis. Growth + trend proximity is the sharper, more universally meaningful question; FEMA map status is a real and interesting secondary fact (worth surfacing — "X% of high-priority tracts aren't even on the official map" is a genuinely sharper finding this way), not the category every tract should be sorted into first.

The **WAFER Score** (`pct_housing_growth × 100 × (1 + trend_delta × 3)` near a trending gauge, `pct_housing_growth × 100 × 0.5` otherwise) ranks tracts for the Catalog view — amplified by how severe a nearby gauge's trend actually is, not just whether one exists. A tract with zero or negative growth scores 0 regardless of flood status — the thesis is growth colliding with risk, not risk alone.

---

## Known Limitations

- **A single pathological query can starve the whole app of database connections.** This actually happened during development: simplifying FEMA's largest non-hazard fill polygons on every map pan pegged the RDS instance's CPU badly enough that Query and Catalog silently stopped responding. Fixed by excluding those polygons from the map layer and adding a 15-second `statement_timeout`/`query_timeout` to the connection pool (`db.js`) so one query can no longer hang indefinitely and starve the rest.

- **The priority tier is deliberately decoupled from FEMA floodplain status.** An earlier version used floodplain membership as the primary classification; that was restructured after live data showed 79% of all Wisconsin tracts intersect some mapped floodplain once FEMA's non-hazard Zone X fill layer is correctly excluded, making "on the map or not" a weak first-cut signal. Growth + nearby gauge trend is now the primary tier; FEMA map status is still computed and shown per tract, just as an independent attribute rather than the sorting category.
- **The 15km gauge-proximity buffer and 0.10 trend-delta threshold are documented starting points, not validated findings.** They're explicit, tunable constants in `computeRiskScores.js`, not hardcoded assumptions dressed up as precision.
- **Gauge coverage is partial by necessity.** 143 of 237 Wisconsin NWS gauges have a USGS crosswalk with enough peak-flow history to compute a trend; the other 94 are correctly excluded rather than estimated.
- **2010 housing data has gaps.** 127 of 1,542 tracts have no 2010-vintage match, because Census tract boundaries were redrawn before 2020. Those tracts are excluded from growth scoring rather than guessed at.
- **FEMA's flood zone data may have small coverage gaps.** FEMA's own server intermittently errors on individual pages regardless of request size; the loader retries with backoff and skips a page that still fails after three attempts, rather than losing an entire county over one bad page.
- **This is not a live-monitoring tool.** All data sources refresh periodically (as FEMA, Census, and USGS themselves update), which is the right cadence for a planning and budgeting tool, not an emergency-response one.
- **The live application runs on an AWS Academy Learner Lab instance**, which auto-suspends after a 4-hour session with no persistence beyond that. If the live URL above is unreachable, the backend has been suspended, not permanently broken — screenshots and a walkthrough are available in the project's slide deck as a fallback.
- **Infrastructure coverage is hospitals and public schools only.** Fire/EMS and water treatment were originally scoped but dropped — no clean, live, statewide source turned up for either without disproportionate search time. The original source planned for all four categories, HIFLD Open, was permanently shut down by DHS in August 2025.

---

## AI Disclaimer

Anthropic's Claude models were used extensively in the development of this project — architecture design, data pipeline implementation, debugging against live external APIs, and frontend development.

---

## Author

Noah Kirchner
Geography 576 — Web GIS
University of Wisconsin–Madison
