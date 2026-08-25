/* ============================================================
   WAFER -- db.js
   Shared PostGIS connection pool, used by every loader and later
   by the Phase 4 API server. Same .env variable names as the
   Lab 7 flight_tracking project (pgUser/pgPassword/pgHost/pgPort/targetDB).
   ============================================================ */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.pgUser,
  password: process.env.pgPassword,
  host: process.env.pgHost,
  port: process.env.pgPort || 5432,
  database: process.env.targetDB,
  // Safety net: a single pathological query (e.g. simplifying an unexpectedly
  // huge flood-zone polygon) must not be able to pin a pool connection
  // indefinitely and starve every other endpoint of a connection.
  statement_timeout: 15000,
  query_timeout: 15000
});

module.exports = pool;
