-- WAFER (Wisconsin Analysis of Flood / Expansion Risk)
-- Schema per Final Project/Schema.md (Phase 1). Run once against a fresh
-- database before running any loader: psql -d wafer -f schema.sql

CREATE EXTENSION IF NOT EXISTS postgis;

-- Streamgage sites. flood_stage_ft comes from the NWS NWPS "minor" flood
-- category threshold and is NULL for sites with no NWS flood-category
-- designation -- those are excluded from the Phase 3 exceedance-trend calc.
CREATE TABLE gauges (
    site_no             varchar(15) PRIMARY KEY,
    station_name        varchar(150) NOT NULL,
    county_fips         varchar(5),
    huc_code            varchar(12),
    drainage_area_sqmi  numeric,
    flood_stage_ft      numeric,
    geom                geometry(Point, 4326) NOT NULL
);
CREATE INDEX idx_gauges_geom ON gauges USING GIST (geom);

-- One row per gauge per year of recorded annual peak flow.
CREATE TABLE gauge_peak_flows (
    id                  bigserial PRIMARY KEY,
    site_no             varchar(15) NOT NULL REFERENCES gauges(site_no),
    peak_date           date NOT NULL,
    peak_stage_ft       numeric,
    peak_discharge_cfs  numeric,
    UNIQUE (site_no, peak_date)
);
CREATE INDEX idx_peak_flows_site ON gauge_peak_flows (site_no);

-- FEMA regulatory floodplain polygons. Comparison layer, not ground truth
-- for current risk (see Scope.md, Prior Art & Differentiation).
-- objectid is FEMA's own per-feature unique ID (esriFieldTypeOID on the
-- NFHL layer) -- used for upsert-based loading so a rerun after an
-- interrupted session is a cheap no-op, not a full reload. county_fips is
-- derived by the loader (which county's bounding-box query found the
-- polygon), not supplied by FEMA, so it's approximate for polygons that
-- span a county line -- fine as a reference attribute, since the actual
-- floodplain classification in Phase 3 uses ST_Intersects on geometry.
CREATE TABLE flood_zones (
    id              bigserial PRIMARY KEY,
    objectid        integer UNIQUE,
    fema_zone_id    varchar(30),
    flood_zone      varchar(10) NOT NULL,
    zone_subtype    varchar(80),
    county_fips     varchar(5),
    geom            geometry(MultiPolygon, 4326) NOT NULL
);
CREATE INDEX idx_flood_zones_geom ON flood_zones USING GIST (geom);

-- Tract boundaries (from TIGERweb) + ACS demographic/fiscal-capacity context.
CREATE TABLE census_tracts (
    geoid                     varchar(11) PRIMARY KEY,
    county_fips               varchar(5) NOT NULL,
    tract_name                varchar(100),
    median_household_income   numeric,
    poverty_rate               numeric,
    geom                      geometry(MultiPolygon, 4326) NOT NULL
);
CREATE INDEX idx_census_tracts_geom ON census_tracts USING GIST (geom);

-- Decennial housing-unit counts, one row per tract per census year.
CREATE TABLE housing_units_by_tract (
    id              bigserial PRIMARY KEY,
    geoid           varchar(11) NOT NULL REFERENCES census_tracts(geoid),
    census_year     smallint NOT NULL,
    housing_units   integer NOT NULL,
    UNIQUE (geoid, census_year)
);

-- Critical infrastructure points (WI DHS hospitals + WI DPI schools --
-- see loadInfrastructure.js header comment for source details and why
-- this isn't HIFLD, despite HIFLD being the originally-scoped source).
CREATE TABLE infrastructure (
    id              bigserial PRIMARY KEY,
    source_id       varchar(30),
    facility_name   varchar(150),
    facility_type   varchar(50) NOT NULL,
    county_fips     varchar(5),
    geoid           varchar(11) REFERENCES census_tracts(geoid),
    geom            geometry(Point, 4326) NOT NULL
);
CREATE INDEX idx_infrastructure_geom ON infrastructure USING GIST (geom);
CREATE INDEX idx_infrastructure_geoid ON infrastructure (geoid);

-- Derived table. One row per tract, fully recomputed by the Phase 3
-- scoring job -- never written to directly by an ingestion loader.
CREATE TABLE risk_scores (
    geoid                     varchar(11) PRIMARY KEY REFERENCES census_tracts(geoid),
    housing_units_2010        integer,
    housing_units_2020        integer,
    pct_housing_growth        numeric,
    in_floodplain             boolean NOT NULL DEFAULT FALSE,
    nearest_trending_gauge    varchar(15) REFERENCES gauges(site_no),
    gauge_exceedance_trend    numeric,
    classification            varchar(20) NOT NULL,
    wafer_score               numeric,
    computed_at               timestamptz NOT NULL DEFAULT now()
);
