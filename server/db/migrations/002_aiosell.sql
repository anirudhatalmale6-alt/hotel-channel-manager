-- ============================================================================
--  Migration 002 - changes forced by the Aiosell specification
--
--  Reading apidocs.aiosell.com turned up three things my phase 1 schema got
--  wrong. All three are cheap to fix now and expensive to fix once there is
--  live booking data, so they go in before anything is built on top.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. A RESERVATION IS NOT ONE ROOM.
--
--    Aiosell's booking payload carries `rooms[]` — an array. One booking can
--    hold several rooms, and they can be DIFFERENT room types (an Executive
--    and a Suite on the same reference). Two entries with the same roomCode
--    means two rooms of that type; there is no quantity field.
--
--    My `reservations` table had a single room_type_id and a rooms count,
--    which would have silently dropped the second room type — and therefore
--    failed to hold back inventory for it. That is an overbooking bug.
--
--    Room-level detail moves to a child table. The parent keeps only what is
--    genuinely per-booking.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reservation_rooms (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id          BIGINT UNSIGNED NOT NULL,
  reservation_id  BIGINT UNSIGNED NOT NULL,
  room_type_id    BIGINT UNSIGNED NOT NULL,
  rate_plan_id    BIGINT UNSIGNED NULL,
  -- Kept even when we could resolve them, so an unmapped code is still
  -- visible to whoever has to fix the mapping.
  remote_room_code     VARCHAR(120) NOT NULL DEFAULT '',
  remote_rateplan_code VARCHAR(120) NOT NULL DEFAULT '',
  guest_name      VARCHAR(190)    NOT NULL DEFAULT '',
  adults          TINYINT UNSIGNED NOT NULL DEFAULT 0,
  children        TINYINT UNSIGNED NOT NULL DEFAULT 0,
  line_total      DECIMAL(12,2)   NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_rr_reservation (reservation_id),
  KEY idx_rr_room_type (room_type_id),
  KEY idx_rr_org (org_id),
  CONSTRAINT fk_rr_reservation FOREIGN KEY (reservation_id)
    REFERENCES reservations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-night sell rates. Aiosell sends rooms[].prices[] per night, so ADR,
-- RevPAR and any "revenue on the books for March" report can be answered
-- honestly instead of by dividing a total by the number of nights.
CREATE TABLE IF NOT EXISTS reservation_nights (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  org_id               BIGINT UNSIGNED NOT NULL,
  reservation_id       BIGINT UNSIGNED NOT NULL,
  reservation_room_id  BIGINT UNSIGNED NOT NULL,
  room_type_id         BIGINT UNSIGNED NOT NULL,
  stay_date            DATE            NOT NULL,
  sell_rate            DECIMAL(12,2)   NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_rn (reservation_room_id, stay_date),
  KEY idx_rn_reservation (reservation_id),
  KEY idx_rn_date (room_type_id, stay_date),
  KEY idx_rn_org (org_id),
  CONSTRAINT fk_rn_reservation FOREIGN KEY (reservation_id)
    REFERENCES reservations(id) ON DELETE CASCADE,
  CONSTRAINT fk_rn_room FOREIGN KEY (reservation_room_id)
    REFERENCES reservation_rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- 2. FIELDS THE PAYLOAD CARRIES THAT I HAD NOWHERE TO PUT.
--
--    `pah` decides whether the front desk collects money at check-out, so it
--    is not optional detail. commission / tcs / tds are what the client's
--    invoicing and any channel-production report will be built on. Throwing
--    them away on arrival means they cannot be recovered later.
-- ---------------------------------------------------------------------------

ALTER TABLE reservations
  ADD COLUMN cm_booking_id     VARCHAR(120)  NULL AFTER remote_ref,
  ADD COLUMN booked_on         DATETIME      NULL AFTER received_at,
  ADD COLUMN segment           VARCHAR(60)   NOT NULL DEFAULT '' AFTER status,
  ADD COLUMN special_requests  TEXT          NULL AFTER segment,
  ADD COLUMN pay_at_hotel      TINYINT(1)    NOT NULL DEFAULT 0 AFTER special_requests,
  ADD COLUMN amount_before_tax DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER total_amount,
  ADD COLUMN tax_amount        DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER amount_before_tax,
  ADD COLUMN commission        DECIMAL(12,2) NULL AFTER tax_amount,
  ADD COLUMN tcs               DECIMAL(12,2) NULL AFTER commission,
  ADD COLUMN tds               DECIMAL(12,2) NULL AFTER tcs,
  ADD COLUMN guest_address     VARCHAR(255)  NOT NULL DEFAULT '' AFTER guest_phone,
  ADD COLUMN guest_city        VARCHAR(120)  NOT NULL DEFAULT '' AFTER guest_address,
  ADD COLUMN guest_country     VARCHAR(120)  NOT NULL DEFAULT '' AFTER guest_city,
  -- Kept verbatim. When a booking looks wrong six weeks later, the only
  -- reliable answer is what the channel actually sent.
  ADD COLUMN raw_payload       JSON          NULL;

-- room_type_id stays on reservations as the PRIMARY room for list screens,
-- but it is no longer the authority - reservation_rooms is.
ALTER TABLE reservations
  MODIFY COLUMN room_type_id BIGINT UNSIGNED NULL;

-- ---------------------------------------------------------------------------
-- 3. RATE PLANS ARE PER-OCCUPANCY, AND THE MEAL PLAN CODES ARE DIFFERENT.
--
--    Aiosell's rate plan ids are {room}-{occupancy}-{mealplan}, e.g.
--    `executive-s-ep`. So occupancy is part of the plan's identity, not a
--    property of the booking, and one room type carries 4-8 plans.
--
--    Their meal plans are EP / CP / MAP / AP. I had modelled RO / BB / HB /
--    FB / AI, which is the European convention. Storing ours and mapping on
--    the way out would mean a lossy translation in both directions, so the
--    column takes their codes and the UI shows the friendly name.
-- ---------------------------------------------------------------------------

ALTER TABLE rate_plans
  ADD COLUMN occupancy    TINYINT UNSIGNED NOT NULL DEFAULT 2 AFTER meal_plan,
  ADD COLUMN extra_adult  DECIMAL(12,2)    NOT NULL DEFAULT 0 AFTER occupancy,
  ADD COLUMN meals_included TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER extra_adult,
  MODIFY COLUMN meal_plan ENUM('EP','CP','MAP','AP','RO','BB','HB','FB','AI')
    NOT NULL DEFAULT 'EP';

UPDATE rate_plans SET meal_plan = 'EP'  WHERE meal_plan = 'RO';
UPDATE rate_plans SET meal_plan = 'CP'  WHERE meal_plan = 'BB';
UPDATE rate_plans SET meal_plan = 'MAP' WHERE meal_plan = 'HB';
UPDATE rate_plans SET meal_plan = 'AP'  WHERE meal_plan = 'FB';

-- ---------------------------------------------------------------------------
-- 4. Channel identity.
--
--    Aiosell distinguishes the PARTNER id (which software is calling) from
--    the HOTEL code (which property). Both are needed on every call and they
--    are not the same thing, so they get their own columns rather than being
--    buried in the credentials blob.
-- ---------------------------------------------------------------------------

ALTER TABLE channels
  ADD COLUMN hotel_code  VARCHAR(120) NOT NULL DEFAULT '' AFTER adapter,
  ADD COLUMN partner_id  VARCHAR(120) NOT NULL DEFAULT '' AFTER hotel_code,
  -- Restrictions must name their target channels; rates and availability go
  -- to every connected OTA. This holds the OTA list for the former.
  ADD COLUMN ota_channels TEXT NULL AFTER partner_id;

CREATE INDEX idx_ch_hotel_code ON channels (hotel_code);
