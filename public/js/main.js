/* ============================================================
   WAFER — Short Description: Wisconsin flood-growth exposure map
   Geography 576 | Noah Kirchner
   main.js — all application logic in one file, MDOAT pattern.
   ============================================================ */

/* API BASE — same-origin (server.js serves both the API and these
   static files), so relative paths work with no CORS round-trip. */
const API_BASE = '';

/* PRIORITY TIER COLORS — the primary signal is growth + nearby rising
   gauge trend, independent of FEMA floodplain status. Whether a tract is
   on FEMA's map is a separate, secondary attribute (see IN_FLOODPLAIN_*
   below and the badge in the tract popup) -- not folded into this color.
   Earlier version classified by floodplain membership first; that fell
   apart once 79% of all tracts turned out to intersect some mapped
   floodplain, since Wisconsin is extremely water-dense -- "on the map or
   not" wasn't discriminating much as the primary lens. See
   computeRiskScores.js's header comment for the full story. */
const CLASS_COLORS = {
  high: '#c0392b',
  medium: '#d68910',
  low: '#8a9a94',
  unscored: '#aaaaaa'
};

const CLASS_LABELS = {
  high: 'High Priority',
  medium: 'Moderate Priority',
  low: 'Low Priority',
  unscored: 'Unscored'
};

const CLASS_DESCRIPTIONS = {
  high: 'Real housing growth combined with a nearby river gauge showing a statistically rising flood-stage trend -- the strongest evidence of colliding risk and growth.',
  medium: 'Real housing growth, but no nearby gauge currently shows a confirmed rising flood-risk trend.',
  low: 'Little or no recent housing growth.'
};

/* FEMA floodplain status -- independent of the priority tier above,
   shown as a badge on click rather than folded into the map color. */
const IN_FLOODPLAIN_LABEL = { true: 'On FEMA’s floodplain map', false: 'Not on FEMA’s floodplain map' };
const IN_FLOODPLAIN_ICON = { true: '✓', false: '⚠' };

/* Short, scannable one-liner shown right under the badge -- the longer
   CLASS_DESCRIPTIONS text stays too, for anyone who wants the full
   criteria, but this is the "read it in one second" version. */
const CLASS_TAGLINES = {
  high: 'Flood risk rising + population growing',
  medium: 'Population growing, flood-risk trend not confirmed',
  low: 'Little population growth'
};

/* NAV — Tab switching */
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.app-view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
    if (btn.dataset.view === 'catalog' && !catalogLoaded) loadCatalog();
  });
});

/* ============================================================
   MAP VIEW
   ============================================================ */
const map = L.map('map-container', { center: [44.5, -89.8], zoom: 7 });

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors',
  maxZoom: 19
}).addTo(map);

/* Visual hierarchy: "high" priority (growth + confirmed nearby trend) is
   the rare, actionable case and is styled to visually dominate -- bold
   fill, thick border. "medium" (growth alone) is muted context. "low"
   fades further still, since there's nothing to look at there. */
const TRACT_STYLES = {
  high:     { color: '#c0392b', weight: 1.6, fillColor: CLASS_COLORS.high,     fillOpacity: 0.75 },
  medium:   { color: '#a58a5c', weight: 0.5, fillColor: CLASS_COLORS.medium,   fillOpacity: 0.30 },
  low:      { color: '#8a9a94', weight: 0.4, fillColor: CLASS_COLORS.low,      fillOpacity: 0.10 },
  unscored: { color: '#999',    weight: 0.4, fillColor: CLASS_COLORS.unscored, fillOpacity: 0.10 }
};

const tractLayer = L.geoJSON(null, {
  style: (feature) => TRACT_STYLES[feature.properties.classification] || TRACT_STYLES.unscored,
  onEachFeature: (feature, layer) => {
    const p = feature.properties;
    const label = CLASS_LABELS[p.classification] || 'Unscored';
    const desc = CLASS_DESCRIPTIONS[p.classification] || '';
    const tagline = CLASS_TAGLINES[p.classification] || '';
    const mapped = p.in_floodplain === true || p.in_floodplain === 'true';
    layer.bindPopup(`
      <h4>${p.tract_name || p.geoid}</h4>
      <span class="class-badge class-${p.classification}">${label}</span>
      ${tagline ? `<p style="margin-top:0.25rem; font-size:0.8rem; font-weight:600; color:#333;">${tagline}</p>` : ''}
      <p style="margin-top:0.3rem; font-size:0.78rem; color:#666;">${desc}</p>
      <p style="margin-top:0.4rem; font-size:0.8rem;">
        <span style="color:${mapped ? '#1e8449' : '#c0392b'};">${IN_FLOODPLAIN_ICON[mapped]}</span>
        ${IN_FLOODPLAIN_LABEL[mapped]}
      </p>
      <p style="margin-top:0.4rem;">
        ${p.pct_housing_growth != null ? `Growth 2010-2020: <strong>${(p.pct_housing_growth * 100).toFixed(1)}%</strong><br>` : ''}
        ${p.wafer_score != null ? `WAFER Score: <strong>${Number(p.wafer_score).toFixed(1)}</strong> <span style="color:#777; font-size:0.78rem;">(${scoreContext(Number(p.wafer_score))})</span>` : ''}
      </p>
      <p class="infra-list" data-geoid="${p.geoid}" style="margin-top:0.4rem; font-size:0.82rem; color:#555;">Loading exposed infrastructure…</p>
    `);
    layer.on('popupopen', () => loadExposedInfrastructure(p.geoid, layer.getPopup()));
  }
}).addTo(map);

/* Infrastructure exposure -- fetched lazily per popup, not preloaded for
   all 1,542 tracts up front (that's 1,542 extra requests for data most
   users will never open a popup for). */
const infraCache = new Map();
async function loadExposedInfrastructure(geoid, popup) {
  try {
    let facilities = infraCache.get(geoid);
    if (!facilities) {
      const res = await fetch(`${API_BASE}/infrastructure/exposed/${geoid}`);
      facilities = await res.json();
      infraCache.set(geoid, facilities);
    }
    const html = facilities.length
      ? `<strong>Exposed infrastructure:</strong><br>${facilities.map((f) => `${f.facility_type === 'hospital' ? '🏥' : '🏫'} ${f.facility_name}`).join('<br>')}`
      : 'No hospitals or schools in this tract.';
    const el = popup.getElement()?.querySelector(`.infra-list[data-geoid="${geoid}"]`);
    if (el) el.innerHTML = html;
  } catch (err) {
    console.warn('Infrastructure lookup failed:', err);
  }
}

/* Gauges get their own pane above the default overlay pane (z-index 400,
   shared by both tractLayer and floodZoneLayer) so they always render on
   top -- including after floodZoneLayer clears and re-adds its data on
   every pan/zoom, which would otherwise re-stack on top of the gauge
   dots each time regardless of original add-order. */
map.createPane('gaugePane');
map.getPane('gaugePane').style.zIndex = 650;

const gaugeLayer = L.layerGroup().addTo(map);
const floodZoneLayer = L.geoJSON(null, {
  style: { color: '#2e6da4', weight: 1, fillColor: '#2e6da4', fillOpacity: 0.25 }
}).addTo(map);

L.control.layers(null, {
  'Census Tracts (risk)': tractLayer,
  'Gauges': gaugeLayer,
  'FEMA Flood Zones': floodZoneLayer
}, { collapsed: false }).addTo(map);

/* LEGEND — bottom-right, explains tract fill colors and gauge dot styling */
const legend = L.control({ position: 'bottomright' });
legend.onAdd = () => {
  const div = L.DomUtil.create('div', 'map-legend');
  div.innerHTML = `
    <h4>Legend</h4>
    <div class="legend-section">
      <div class="legend-row" data-tip="${CLASS_DESCRIPTIONS.high}"><span class="legend-swatch" style="background:${CLASS_COLORS.high}"></span>${CLASS_LABELS.high}</div>
      <div class="legend-row" data-tip="${CLASS_DESCRIPTIONS.medium}"><span class="legend-swatch" style="background:${CLASS_COLORS.medium}"></span>${CLASS_LABELS.medium}</div>
      <div class="legend-row" data-tip="${CLASS_DESCRIPTIONS.low}"><span class="legend-swatch" style="background:${CLASS_COLORS.low}"></span>${CLASS_LABELS.low}</div>
    </div>
    <div class="legend-section">
      <div class="legend-row"><span class="legend-dot" style="background:#c0392b;width:11px;height:11px;"></span>Gauge, trending up</div>
      <div class="legend-row"><span class="legend-dot" style="background:#2e6da4;width:9px;height:9px;"></span>Gauge, no trend</div>
    </div>
    <div class="legend-section">
      <div class="legend-row" data-tip="Whether the tract falls inside FEMA's officially mapped floodplain -- shown per-tract in its popup, independent of the priority color above.">
        <span style="color:#1e8449;font-weight:700;">✓</span>/<span style="color:#c0392b;font-weight:700;">⚠</span> On FEMA's map?
      </div>
    </div>
  `;
  return div;
};
legend.addTo(map);

/* Sorted, ascending, nonzero WAFER Scores across every scored tract --
   populated before tractLayer.addData() below so every popup can place
   its own tract's score in context ("higher than 92% of scored tracts")
   instead of showing a bare, unitless number. Computed from the actual
   live distribution rather than hardcoded thresholds, so it can't drift
   out of sync with the real data the way a fixed cutoff could. */
let allScoresSorted = [];

function scoreContext(score) {
  if (score == null || score <= 0 || allScoresSorted.length === 0) return 'no growth signal';
  let lo = 0, hi = allScoresSorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (allScoresSorted[mid] < score) lo = mid + 1; else hi = mid;
  }
  const percentile = Math.round((lo / allScoresSorted.length) * 100);
  if (percentile >= 90) return `top ${100 - percentile}% statewide`;
  if (percentile >= 50) return `higher than ${percentile}% of scored tracts`;
  return `lower ${100 - percentile}% of scored tracts`;
}

async function loadTracts() {
  const res = await fetch(`${API_BASE}/tracts`);
  const geojson = await res.json();
  allScoresSorted = geojson.features
    .map((f) => Number(f.properties.wafer_score))
    .filter((s) => Number.isFinite(s) && s > 0)
    .sort((a, b) => a - b);
  tractLayer.addData(geojson);
}

async function loadGauges() {
  const res = await fetch(`${API_BASE}/gauges`);
  const gauges = await res.json();
  gauges.forEach((g) => {
    const color = g.is_trending_up ? '#c0392b' : '#2e6da4';
    const marker = L.circleMarker([g.lat, g.lon], {
      pane: 'gaugePane',
      radius: g.is_trending_up ? 7 : 5,
      color,
      fillColor: color,
      fillOpacity: 0.8,
      weight: 1.5
    });
    marker.bindPopup(`
      <h4>${g.station_name}</h4>
      <p>Site ${g.site_no}${g.flood_stage_ft ? ` &middot; Flood stage ${g.flood_stage_ft} ft` : ''}</p>
      ${g.is_trending_up
        ? `<p style="color:#c0392b;"><strong>Trending up</strong> — recent exceedance rate ${(g.recent_rate * 100).toFixed(0)}% vs. ${(g.full_record_rate * 100).toFixed(0)}% full record</p>`
        : `<p style="color:#555;">No significant rising trend detected</p>`}
      <div class="gauge-chart" data-site="${g.site_no}">Loading history…</div>
    `);
    marker.on('popupopen', () => loadGaugeChart(g.site_no, marker.getPopup()));
    gaugeLayer.addLayer(marker);
  });
}

/* Minimal inline SVG sparkline of peak-stage history vs. flood stage --
   no charting library dependency for one line + one threshold. Fetched
   lazily per popup open, same reasoning as the infrastructure lookup. */
const gaugeTrendCache = new Map();
async function loadGaugeChart(siteNo, popup) {
  try {
    let data = gaugeTrendCache.get(siteNo);
    if (!data) {
      const res = await fetch(`${API_BASE}/gauges/${siteNo}/trend`);
      data = await res.json();
      gaugeTrendCache.set(siteNo, data);
    }
    const el = popup.getElement()?.querySelector(`.gauge-chart[data-site="${siteNo}"]`);
    if (el) el.innerHTML = renderSparkline(data);
  } catch (err) {
    console.warn('Gauge trend lookup failed:', err);
  }
}

function renderSparkline(data) {
  const points = (data.series || []).filter((r) => r.peak_stage_ft != null);
  if (points.length < 2) return '<p style="color:#888;font-size:0.8rem;">Not enough data for a chart.</p>';

  const W = 260, H = 70, PAD = 6;
  const stages = points.map((p) => Number(p.peak_stage_ft));
  const floodStage = data.gauge.flood_stage_ft != null ? Number(data.gauge.flood_stage_ft) : null;
  const allValues = floodStage != null ? [...stages, floodStage] : stages;
  const min = Math.min(...allValues), max = Math.max(...allValues);
  const range = max - min || 1;

  const x = (i) => PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const y = (v) => H - PAD - ((v - min) / range) * (H - 2 * PAD);

  const linePath = stages.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const floodLine = floodStage != null
    ? `<line x1="${PAD}" y1="${y(floodStage).toFixed(1)}" x2="${W - PAD}" y2="${y(floodStage).toFixed(1)}" stroke="#c0392b" stroke-width="1" stroke-dasharray="3,2" />`
    : '';

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" style="margin-top:0.3rem;">
      ${floodLine}
      <path d="${linePath}" fill="none" stroke="#2e6da4" stroke-width="1.5" />
    </svg>
    <p style="font-size:0.72rem;color:#888;">Peak stage, ${points[0].peak_date.slice(0, 4)}–${points[points.length - 1].peak_date.slice(0, 4)}${floodStage != null ? ' &middot; dashed line = flood stage' : ''}</p>
  `;
}

const floodZoneLoadingIndicator = L.DomUtil.create('div', 'floodzone-loading', document.getElementById('map-container'));
floodZoneLoadingIndicator.textContent = 'Loading flood zones…';

function loadFloodZonesInView() {
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(',');
  floodZoneLoadingIndicator.classList.add('visible');
  // Server-side simplification (see server.js) trims vertex count at wide
  // zooms, where full-resolution river/floodplain boundary detail isn't
  // visible anyway -- this was the actual source of the slow loading.
  fetch(`${API_BASE}/floodzones?bbox=${bbox}&zoom=${map.getZoom()}`)
    .then((r) => r.json())
    .then((geojson) => {
      floodZoneLayer.clearLayers();
      floodZoneLayer.addData(geojson);
    })
    .catch((err) => console.warn('Flood zone load failed:', err))
    .finally(() => floodZoneLoadingIndicator.classList.remove('visible'));
}

map.on('moveend', () => {
  if (map.getZoom() >= 9) loadFloodZonesInView(); // avoid a huge unfiltered pull at low zoom
});

loadTracts();
loadGauges();

/* ============================================================
   QUERY VIEW — filtered lookup against /catalog
   ============================================================ */
let allTractsForCountyList = null;

function countyNameFromTractName(tractName) {
  // "Census Tract 1863; Milwaukee County; Wisconsin" -> "Milwaukee County"
  const parts = (tractName || '').split(';').map((s) => s.trim());
  return parts.length >= 2 ? parts[1] : null;
}

async function populateCountyDropdown() {
  let rows;
  try {
    const res = await fetch(`${API_BASE}/catalog`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    rows = await res.json();
  } catch (err) {
    console.error('County list failed to load:', err);
    return;
  }
  allTractsForCountyList = rows;
  const seen = new Map();
  rows.forEach((r) => {
    if (r.county_fips && !seen.has(r.county_fips)) {
      seen.set(r.county_fips, countyNameFromTractName(r.tract_name) || r.county_fips);
    }
  });
  const select = document.getElementById('query-county');
  [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1])).forEach(([fips, name]) => {
    const opt = document.createElement('option');
    opt.value = fips;
    opt.textContent = name;
    select.appendChild(opt);
  });
}
populateCountyDropdown();

let lastQueryResults = [];

document.getElementById('query-run').addEventListener('click', async () => {
  const classification = document.getElementById('query-classification').value;
  const countyFips = document.getElementById('query-county').value;
  const msg = document.getElementById('query-msg');
  const runBtn = document.getElementById('query-run');

  runBtn.disabled = true;
  msg.textContent = 'Running query…';
  msg.classList.remove('hidden');

  try {
    const params = new URLSearchParams();
    if (classification) params.set('classification', classification);
    const res = await fetch(`${API_BASE}/catalog?${params.toString()}`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    let rows = await res.json();
    if (countyFips) rows = rows.filter((r) => r.county_fips === countyFips);

    lastQueryResults = rows;
    renderQueryTable(rows);
  } catch (err) {
    console.error('Query failed:', err);
    document.getElementById('query-table-body').innerHTML = '';
    document.getElementById('query-result-count').textContent = '';
    msg.textContent = 'Query failed -- the API may be temporarily unreachable. Try again in a moment.';
    msg.classList.remove('hidden');
  } finally {
    runBtn.disabled = false;
  }
});

function femaMapCell(r) {
  const mapped = r.in_floodplain === true || r.in_floodplain === 'true';
  const color = mapped ? '#1e8449' : '#c0392b';
  return `<span style="color:${color};font-weight:700;" title="${IN_FLOODPLAIN_LABEL[mapped]}">${IN_FLOODPLAIN_ICON[mapped]}</span>`;
}

function renderQueryTable(rows) {
  const tbody = document.getElementById('query-table-body');
  const msg = document.getElementById('query-msg');
  tbody.innerHTML = '';
  document.getElementById('query-result-count').textContent = `${rows.length} tract${rows.length === 1 ? '' : 's'}`;

  if (rows.length === 0) {
    msg.textContent = 'No tracts match this query.';
    msg.classList.remove('hidden');
    return;
  }
  msg.classList.add('hidden');

  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.tract_name || r.geoid}</td>
      <td>${countyNameFromTractName(r.tract_name) || r.county_fips}</td>
      <td><span class="class-badge class-${r.classification}">${CLASS_LABELS[r.classification] || r.classification}</span></td>
      <td>${r.pct_housing_growth != null ? (r.pct_housing_growth * 100).toFixed(1) + '%' : '—'}</td>
      <td>${femaMapCell(r)}</td>
      <td>${r.median_household_income != null ? '$' + Number(r.median_household_income).toLocaleString() : '—'}</td>
      <td>${r.wafer_score != null ? Number(r.wafer_score).toFixed(1) : '—'}</td>
    `;
    tr.addEventListener('click', () => flyToTract(r.geoid));
    tbody.appendChild(tr);
  });
}

function flyToTract(geoid) {
  const layer = tractLayer.getLayers().find((l) => l.feature.properties.geoid === geoid);
  if (layer) {
    document.querySelector('.nav-btn[data-view="map"]').click();
    map.fitBounds(layer.getBounds());
    layer.openPopup();
  }
}

function exportCSV(rows, filename) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  rows.forEach((row) => {
    lines.push(headers.map((h) => `"${String(row[h] ?? '').replace(/"/g, '""')}"`).join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById('query-export').addEventListener('click', () => {
  exportCSV(lastQueryResults, 'wafer-query-results.csv');
});

/* ============================================================
   CATALOG VIEW — statewide ranked list
   ============================================================ */
let catalogLoaded = false;
let lastCatalogResults = [];

async function loadCatalog() {
  try {
    const res = await fetch(`${API_BASE}/catalog`);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    lastCatalogResults = await res.json();
    renderCatalogTable(lastCatalogResults);
    catalogLoaded = true;
  } catch (err) {
    console.error('Catalog load failed:', err);
    document.getElementById('catalog-table-body').innerHTML =
      '<tr><td colspan="7" style="text-align:center; color:#888; font-style:italic;">Catalog failed to load -- the API may be temporarily unreachable.</td></tr>';
  }
}

function renderCatalogTable(rows) {
  const tbody = document.getElementById('catalog-table-body');
  tbody.innerHTML = '';
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${r.tract_name || r.geoid}</td>
      <td>${countyNameFromTractName(r.tract_name) || r.county_fips}</td>
      <td><span class="class-badge class-${r.classification}">${CLASS_LABELS[r.classification] || r.classification}</span></td>
      <td>${r.pct_housing_growth != null ? (r.pct_housing_growth * 100).toFixed(1) + '%' : '—'}</td>
      <td>${femaMapCell(r)}</td>
      <td>${r.wafer_score != null ? Number(r.wafer_score).toFixed(1) : '—'}</td>
    `;
    tr.addEventListener('click', () => flyToTract(r.geoid));
    tbody.appendChild(tr);
  });
}

document.getElementById('catalog-filter').addEventListener('change', (e) => {
  const val = e.target.value;
  const filtered = val ? lastCatalogResults.filter((r) => r.classification === val) : lastCatalogResults;
  renderCatalogTable(filtered);
});

document.getElementById('catalog-export').addEventListener('click', () => {
  exportCSV(lastCatalogResults, 'wafer-catalog.csv');
});
