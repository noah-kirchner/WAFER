/* ============================================================
   WAFER -- runAllLoaders.js

   Runs every loader in dependency order:
     1. loadACS        -- creates census_tracts (everything else FKs into it)
     2. loadHousingUnits -- needs census_tracts to exist
     3. loadFloodZones  -- independent
     4. loadGaugePeakFlows -- independent
     5. loadInfrastructure -- independent to fetch, but its geoid backfill
                              step needs census_tracts populated first

   Intended for a periodic refresh (monthly-or-slower, per Scope.md --
   none of these sources change fast enough to justify anything tighter),
   run manually or via a simple cron entry once verified. Each loader also
   runs standalone via its own npm script for isolated testing.
   ============================================================ */
require('dotenv').config();
const pool = require('../db');

const steps = [
  { name: 'ACS + tract geometry', mod: '../loaders/loadACS' },
  { name: 'Decennial housing units', mod: '../loaders/loadHousingUnits' },
  { name: 'FEMA flood zones', mod: '../loaders/loadFloodZones' },
  { name: 'USGS gauges + peak flows', mod: '../loaders/loadGaugePeakFlows' },
  { name: 'Critical infrastructure', mod: '../loaders/loadInfrastructure' }
];

async function run() {
  for (const step of steps) {
    console.log(`\n=== ${step.name} ===`);
    const loader = require(step.mod);
    try {
      await loader.run();
    } catch (err) {
      console.error(`FAILED: ${step.name} --`, err.message);
      console.error('Continuing with remaining loaders so one bad source does not block the rest.');
    }
  }
}

if (require.main === module) {
  run()
    .then(() => {
      console.log('\nAll loaders complete.');
      pool.end();
    })
    .catch((err) => {
      console.error('runAllLoaders failed:', err);
      pool.end();
      process.exit(1);
    });
}

module.exports = { run };
