-- ============================================================================
--  Channel Manager / Hotel platform - schema
--
--  MULTI-TENANCY RULE: every business table carries org_id, and every query
--  in the application filters on it. Tenant isolation is in the schema from
--  the first table rather than added later - retrofitting it is the most
--  expensive mistake a SaaS can make.
--
--  Row identity: an org is a hotel group. A group has one or more properties.
--  Everything below a property (room types, rates, inventory, channels,
--  reservations) also carries org_id so a missing join can never leak data
--  across tenants.
-- ============================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- Tenants and people
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS orgs (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(160)    NOT NULL,
  slug          VARCHAR(80)     NOT NULL,
  status        ENUM('active','suspended') NOT NULL DEFAULT 'active',
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_orgs_slug (slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id        BIGINT UNSIGNED NOT NULL,
  email         VARCHAR(190)    NOT NULL,
  password_hash VARCHAR(255)    NOT NULL,
  full_name     VARCHAR(160)    NOT NULL DEFAULT '',
  -- owner: billing + everything. manager: one or more properties.
  -- frontdesk: reservations + inventory. readonly: reports only.
  role          ENUM('owner','manager','frontdesk','readonly') NOT NULL DEFAULT 'frontdesk',
  status        ENUM('active','disabled') NOT NULL DEFAULT 'active',
  last_login_at DATETIME        NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_org (org_id),
  CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS properties (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id        BIGINT UNSIGNED NOT NULL,
  name          VARCHAR(160)    NOT NULL,
  code          VARCHAR(40)     NOT NULL,
  timezone      VARCHAR(64)     NOT NULL DEFAULT 'Asia/Colombo',
  currency      CHAR(3)         NOT NULL DEFAULT 'LKR',
  status        ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_prop_org_code (org_id, code),
  KEY idx_prop_org (org_id),
  CONSTRAINT fk_prop_org FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A manager can be scoped to specific properties. Owners see everything in
-- the org and need no rows here.
CREATE TABLE IF NOT EXISTS user_properties (
  user_id       BIGINT UNSIGNED NOT NULL,
  property_id   BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, property_id),
  KEY idx_up_property (property_id),
  CONSTRAINT fk_up_user     FOREIGN KEY (user_id)     REFERENCES users(id)      ON DELETE CASCADE,
  CONSTRAINT fk_up_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- What the hotel sells
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS room_types (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id        BIGINT UNSIGNED NOT NULL,
  property_id   BIGINT UNSIGNED NOT NULL,
  code          VARCHAR(40)     NOT NULL,
  name          VARCHAR(160)    NOT NULL,
  -- The physical room count. Inventory allotment can never exceed this.
  total_rooms   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  max_occupancy TINYINT UNSIGNED  NOT NULL DEFAULT 2,
  sort_order    SMALLINT          NOT NULL DEFAULT 0,
  status        ENUM('active','inactive') NOT NULL DEFAULT 'active',
  PRIMARY KEY (id),
  UNIQUE KEY uq_rt_prop_code (property_id, code),
  KEY idx_rt_org (org_id),
  CONSTRAINT fk_rt_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rate_plans (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id        BIGINT UNSIGNED NOT NULL,
  property_id   BIGINT UNSIGNED NOT NULL,
  room_type_id  BIGINT UNSIGNED NOT NULL,
  code          VARCHAR(40)     NOT NULL,
  name          VARCHAR(160)    NOT NULL,
  meal_plan     ENUM('RO','BB','HB','FB','AI') NOT NULL DEFAULT 'BB',
  -- Some channels price per occupancy rather than per room. Kept as a flag so
  -- the adapter layer knows which shape to send.
  pricing_mode  ENUM('per_room','per_occupancy') NOT NULL DEFAULT 'per_room',
  status        ENUM('active','inactive') NOT NULL DEFAULT 'active',
  PRIMARY KEY (id),
  UNIQUE KEY uq_rp_prop_code (property_id, code),
  KEY idx_rp_room_type (room_type_id),
  KEY idx_rp_org (org_id),
  CONSTRAINT fk_rp_property  FOREIGN KEY (property_id)  REFERENCES properties(id) ON DELETE CASCADE,
  CONSTRAINT fk_rp_room_type FOREIGN KEY (room_type_id) REFERENCES room_types(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Availability, one row per room type per day
--
-- `allotment` is what we are willing to sell. `booked` is what has actually
-- been sold. Sellable = allotment - booked, and the overbooking guard refuses
-- to let that go below zero.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS inventory (
  org_id        BIGINT UNSIGNED NOT NULL,
  property_id   BIGINT UNSIGNED NOT NULL,
  room_type_id  BIGINT UNSIGNED NOT NULL,
  stay_date     DATE            NOT NULL,
  allotment     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  booked        SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  stop_sell     TINYINT(1)      NOT NULL DEFAULT 0,
  min_stay      TINYINT UNSIGNED NOT NULL DEFAULT 1,
  max_stay      TINYINT UNSIGNED NOT NULL DEFAULT 0,   -- 0 = no limit
  closed_arrival   TINYINT(1)   NOT NULL DEFAULT 0,
  closed_departure TINYINT(1)   NOT NULL DEFAULT 0,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (room_type_id, stay_date),
  KEY idx_inv_prop_date (property_id, stay_date),
  KEY idx_inv_org (org_id),
  CONSTRAINT fk_inv_room_type FOREIGN KEY (room_type_id) REFERENCES room_types(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS rates (
  org_id        BIGINT UNSIGNED NOT NULL,
  property_id   BIGINT UNSIGNED NOT NULL,
  rate_plan_id  BIGINT UNSIGNED NOT NULL,
  stay_date     DATE            NOT NULL,
  amount        DECIMAL(12,2)   NOT NULL DEFAULT 0,
  currency      CHAR(3)         NOT NULL DEFAULT 'LKR',
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (rate_plan_id, stay_date),
  KEY idx_rates_prop_date (property_id, stay_date),
  KEY idx_rates_org (org_id),
  CONSTRAINT fk_rates_plan FOREIGN KEY (rate_plan_id) REFERENCES rate_plans(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Channels
--
-- `adapter` names the code that talks to the remote system. Adding a real
-- channel manager later means adding one adapter file and one row here -
-- nothing else in the platform changes.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS channels (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id        BIGINT UNSIGNED NOT NULL,
  property_id   BIGINT UNSIGNED NOT NULL,
  adapter       VARCHAR(60)     NOT NULL,
  name          VARCHAR(160)    NOT NULL,
  -- Credentials are stored encrypted at rest by the application layer.
  credentials   TEXT            NULL,
  enabled       TINYINT(1)      NOT NULL DEFAULT 1,
  last_sync_at  DATETIME        NULL,
  last_error    TEXT            NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ch_property (property_id),
  KEY idx_ch_org (org_id),
  CONSTRAINT fk_ch_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Our room type / rate plan ids are not the remote system's ids. Every
-- channel integration needs this translation table or nothing lines up.
CREATE TABLE IF NOT EXISTS channel_mappings (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id        BIGINT UNSIGNED NOT NULL,
  channel_id    BIGINT UNSIGNED NOT NULL,
  entity_type   ENUM('room_type','rate_plan') NOT NULL,
  entity_id     BIGINT UNSIGNED NOT NULL,
  remote_id     VARCHAR(120)    NOT NULL,
  remote_name   VARCHAR(190)    NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  UNIQUE KEY uq_map (channel_id, entity_type, entity_id),
  KEY idx_map_remote (channel_id, entity_type, remote_id),
  CONSTRAINT fk_map_channel FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per cell, per channel: did this date's ARI actually reach the channel?
-- This is what the calendar colours are read from, so a user never has to
-- guess whether a price change went out.
CREATE TABLE IF NOT EXISTS channel_sync_state (
  channel_id    BIGINT UNSIGNED NOT NULL,
  room_type_id  BIGINT UNSIGNED NOT NULL,
  stay_date     DATE            NOT NULL,
  state         ENUM('pending','synced','failed') NOT NULL DEFAULT 'pending',
  message       VARCHAR(255)    NOT NULL DEFAULT '',
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, room_type_id, stay_date),
  KEY idx_css_state (channel_id, state),
  CONSTRAINT fk_css_channel FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- The sync queue
--
-- Deliberately a database table rather than Redis: it survives a restart, it
-- is visible in the UI, and it needs no extra service on the hosting. Workers
-- claim jobs with an atomic UPDATE so several can run side by side.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sync_jobs (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id        BIGINT UNSIGNED NOT NULL,
  property_id   BIGINT UNSIGNED NOT NULL,
  channel_id    BIGINT UNSIGNED NULL,
  job_type      VARCHAR(40)     NOT NULL,
  payload       JSON            NOT NULL,
  status        ENUM('queued','running','done','failed') NOT NULL DEFAULT 'queued',
  attempts      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts  TINYINT UNSIGNED NOT NULL DEFAULT 5,
  run_after     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_by    VARCHAR(64)     NULL,
  last_error    TEXT            NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at   DATETIME        NULL,
  PRIMARY KEY (id),
  KEY idx_jobs_claim (status, run_after, id),
  KEY idx_jobs_channel (channel_id, status),
  KEY idx_jobs_org (org_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Reservations pulled in from the channels
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reservations (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id        BIGINT UNSIGNED NOT NULL,
  property_id   BIGINT UNSIGNED NOT NULL,
  channel_id    BIGINT UNSIGNED NULL,
  -- The channel's own reference. Unique per channel so a redelivered webhook
  -- updates the booking instead of creating a duplicate.
  remote_ref    VARCHAR(120)    NOT NULL,
  room_type_id  BIGINT UNSIGNED NOT NULL,
  rate_plan_id  BIGINT UNSIGNED NULL,
  guest_name    VARCHAR(190)    NOT NULL DEFAULT '',
  guest_email   VARCHAR(190)    NOT NULL DEFAULT '',
  guest_phone   VARCHAR(60)     NOT NULL DEFAULT '',
  check_in      DATE            NOT NULL,
  check_out     DATE            NOT NULL,
  rooms         SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  adults        TINYINT UNSIGNED  NOT NULL DEFAULT 2,
  children      TINYINT UNSIGNED  NOT NULL DEFAULT 0,
  total_amount  DECIMAL(12,2)   NOT NULL DEFAULT 0,
  currency      CHAR(3)         NOT NULL DEFAULT 'LKR',
  status        ENUM('confirmed','cancelled','no_show','checked_in','checked_out') NOT NULL DEFAULT 'confirmed',
  received_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_res_channel_ref (channel_id, remote_ref),
  KEY idx_res_property_dates (property_id, check_in, check_out),
  KEY idx_res_org (org_id),
  KEY idx_res_room_type (room_type_id, check_in),
  CONSTRAINT fk_res_property FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Who changed what. Rate and availability disputes with a channel are common
-- and unanswerable without this.
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id        BIGINT UNSIGNED NOT NULL,
  property_id   BIGINT UNSIGNED NULL,
  user_id       BIGINT UNSIGNED NULL,
  action        VARCHAR(60)     NOT NULL,
  detail        JSON            NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_org (org_id, created_at),
  KEY idx_audit_property (property_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
