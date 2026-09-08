import { query, one, transaction } from '../db.js';
import { enqueueAriSync } from './sync.js';

export function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function dateRange(from, to) {
  const out = [];
  let cur = from;
  // Guard against an inverted or absurd range reaching the database.
  for (let i = 0; i < 400 && cur <= to; i++) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

/**
 * Read the calendar grid: one row per room type, one cell per date.
 *
 * Deliberately three queries rather than one join per cell. The old-POS habit
 * of querying inside a render loop is what makes these screens unusable once
 * there is real data in them.
 */
export async function getCalendar(orgId, propertyId, from, to) {
  const roomTypes = await query(
    `SELECT id, code, name, total_rooms, max_occupancy
       FROM room_types
      WHERE property_id = ? AND org_id = ? AND status = 'active'
      ORDER BY sort_order, name`,
    [propertyId, orgId]
  );
  if (!roomTypes.length) return { roomTypes: [], dates: dateRange(from, to) };

  const ratePlans = await query(
    `SELECT id, room_type_id, code, name, meal_plan, pricing_mode
       FROM rate_plans
      WHERE property_id = ? AND org_id = ? AND status = 'active'
      ORDER BY name`,
    [propertyId, orgId]
  );

  const inventory = await query(
    `SELECT room_type_id, stay_date, allotment, booked, stop_sell,
            min_stay, max_stay, closed_arrival, closed_departure
       FROM inventory
      WHERE property_id = ? AND org_id = ? AND stay_date BETWEEN ? AND ?`,
    [propertyId, orgId, from, to]
  );

  const rates = await query(
    `SELECT rate_plan_id, stay_date, amount, currency
       FROM rates
      WHERE property_id = ? AND org_id = ? AND stay_date BETWEEN ? AND ?`,
    [propertyId, orgId, from, to]
  );

  // Per-cell sync state, worst-of across channels: if any channel failed the
  // cell shows failed, if any is still pending it shows pending.
  const syncRows = await query(
    `SELECT css.room_type_id, css.stay_date, css.state, COUNT(*) AS n
       FROM channel_sync_state css
       JOIN channels c ON c.id = css.channel_id
      WHERE c.property_id = ? AND c.org_id = ? AND css.stay_date BETWEEN ? AND ?
      GROUP BY css.room_type_id, css.stay_date, css.state`,
    [propertyId, orgId, from, to]
  );

  const invMap = new Map();
  for (const r of inventory) invMap.set(`${r.room_type_id}|${r.stay_date}`, r);

  const rateMap = new Map();
  for (const r of rates) rateMap.set(`${r.rate_plan_id}|${r.stay_date}`, r);

  const syncMap = new Map();
  for (const r of syncRows) {
    const key = `${r.room_type_id}|${r.stay_date}`;
    const current = syncMap.get(key);
    // failed beats pending beats synced
    const rank = { failed: 3, pending: 2, synced: 1 };
    if (!current || rank[r.state] > rank[current]) syncMap.set(key, r.state);
  }

  const dates = dateRange(from, to);

  const rows = roomTypes.map((rt) => {
    const plans = ratePlans.filter((rp) => String(rp.room_type_id) === String(rt.id));
    return {
      id: Number(rt.id),
      code: rt.code,
      name: rt.name,
      totalRooms: Number(rt.total_rooms),
      maxOccupancy: Number(rt.max_occupancy),
      days: dates.map((d) => {
        const inv = invMap.get(`${rt.id}|${d}`);
        const allotment = inv ? Number(inv.allotment) : 0;
        const booked = inv ? Number(inv.booked) : 0;
        return {
          date: d,
          allotment,
          booked,
          available: Math.max(0, allotment - booked),
          stopSell: inv ? !!inv.stop_sell : false,
          minStay: inv ? Number(inv.min_stay) : 1,
          maxStay: inv ? Number(inv.max_stay) : 0,
          closedArrival: inv ? !!inv.closed_arrival : false,
          closedDeparture: inv ? !!inv.closed_departure : false,
          syncState: syncMap.get(`${rt.id}|${d}`) || 'synced',
        };
      }),
      ratePlans: plans.map((rp) => ({
        id: Number(rp.id),
        code: rp.code,
        name: rp.name,
        mealPlan: rp.meal_plan,
        pricingMode: rp.pricing_mode,
        days: dates.map((d) => {
          const r = rateMap.get(`${rp.id}|${d}`);
          return {
            date: d,
            amount: r ? Number(r.amount) : null,
            currency: r ? r.currency : null,
          };
        }),
      })),
    };
  });

  return { roomTypes: rows, dates };
}

/**
 * Apply a bulk edit to the calendar.
 *
 * Everything happens in one transaction so a partial write can never leave
 * availability and rates disagreeing, and the sync jobs are only queued once
 * the data is actually committed.
 *
 * @param {object} args
 * @param {Array}  args.changes [{ roomTypeId, ratePlanId?, date, allotment?,
 *                                 stopSell?, minStay?, maxStay?,
 *                                 closedArrival?, closedDeparture?, rate? }]
 */
export async function applyCalendarChanges({ orgId, propertyId, userId, changes }) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return { applied: 0, warnings: [] };
  }
  if (changes.length > 5000) {
    const err = new Error('Too many changes in one request');
    err.status = 400;
    throw err;
  }

  const warnings = [];

  const result = await transaction(async (conn) => {
    // Room types and rate plans are validated against the property, so a
    // crafted request cannot write into another property's calendar.
    const [rtRows] = await conn.execute(
      `SELECT id, total_rooms, name FROM room_types
        WHERE property_id = ? AND org_id = ?`,
      [propertyId, orgId]
    );
    const roomTypes = new Map(rtRows.map((r) => [String(r.id), r]));

    const [rpRows] = await conn.execute(
      `SELECT id, room_type_id FROM rate_plans
        WHERE property_id = ? AND org_id = ?`,
      [propertyId, orgId]
    );
    const ratePlans = new Map(rpRows.map((r) => [String(r.id), r]));

    const [[prop]] = await conn.execute(
      `SELECT currency FROM properties WHERE id = ? AND org_id = ?`,
      [propertyId, orgId]
    );
    const currency = prop ? prop.currency : 'LKR';

    const touched = new Set();   // `${roomTypeId}|${date}` for the sync queue
    let applied = 0;

    for (const change of changes) {
      const rtKey = String(change.roomTypeId);
      const roomType = roomTypes.get(rtKey);
      if (!roomType) {
        warnings.push(`Unknown room type ${change.roomTypeId} - skipped`);
        continue;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(change.date || '')) {
        warnings.push(`Invalid date "${change.date}" - skipped`);
        continue;
      }

      // ---- availability -------------------------------------------------
      const hasInventoryEdit =
        change.allotment !== undefined || change.stopSell !== undefined ||
        change.minStay !== undefined || change.maxStay !== undefined ||
        change.closedArrival !== undefined || change.closedDeparture !== undefined;

      if (hasInventoryEdit) {
        const [[existing]] = await conn.execute(
          `SELECT allotment, booked, stop_sell, min_stay, max_stay,
                  closed_arrival, closed_departure
             FROM inventory
            WHERE room_type_id = ? AND stay_date = ?
            FOR UPDATE`,
          [roomType.id, change.date]
        );

        const booked = existing ? Number(existing.booked) : 0;
        let allotment = change.allotment !== undefined
          ? Number(change.allotment)
          : (existing ? Number(existing.allotment) : 0);

        if (!Number.isFinite(allotment) || allotment < 0) allotment = 0;

        // Guard 1: never sell more rooms than physically exist.
        if (allotment > roomType.total_rooms) {
          warnings.push(
            `${roomType.name} ${change.date}: asked for ${allotment} rooms but only ${roomType.total_rooms} exist - capped`
          );
          allotment = roomType.total_rooms;
        }

        // Guard 2: never drop allotment below what is already sold. This is
        // the overbooking guard - it is enforced here rather than in the UI,
        // because reservations also arrive from channels while a user edits.
        if (allotment < booked) {
          warnings.push(
            `${roomType.name} ${change.date}: ${booked} already booked, cannot set availability to ${allotment} - set to ${booked}`
          );
          allotment = booked;
        }

        const stopSell = change.stopSell !== undefined
          ? (change.stopSell ? 1 : 0)
          : (existing ? existing.stop_sell : 0);
        const minStay = change.minStay !== undefined
          ? Math.max(1, Number(change.minStay) || 1)
          : (existing ? existing.min_stay : 1);
        const maxStay = change.maxStay !== undefined
          ? Math.max(0, Number(change.maxStay) || 0)
          : (existing ? existing.max_stay : 0);
        const closedArrival = change.closedArrival !== undefined
          ? (change.closedArrival ? 1 : 0)
          : (existing ? existing.closed_arrival : 0);
        const closedDeparture = change.closedDeparture !== undefined
          ? (change.closedDeparture ? 1 : 0)
          : (existing ? existing.closed_departure : 0);

        await conn.execute(
          `INSERT INTO inventory
             (org_id, property_id, room_type_id, stay_date, allotment, booked,
              stop_sell, min_stay, max_stay, closed_arrival, closed_departure)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             allotment = VALUES(allotment),
             stop_sell = VALUES(stop_sell),
             min_stay = VALUES(min_stay),
             max_stay = VALUES(max_stay),
             closed_arrival = VALUES(closed_arrival),
             closed_departure = VALUES(closed_departure)`,
          [orgId, propertyId, roomType.id, change.date, allotment, booked,
           stopSell, minStay, maxStay, closedArrival, closedDeparture]
        );

        touched.add(`${roomType.id}|${change.date}`);
        applied++;
      }

      // ---- rate ---------------------------------------------------------
      if (change.rate !== undefined && change.ratePlanId) {
        const plan = ratePlans.get(String(change.ratePlanId));
        if (!plan) {
          warnings.push(`Unknown rate plan ${change.ratePlanId} - skipped`);
          continue;
        }
        if (String(plan.room_type_id) !== rtKey) {
          warnings.push(`Rate plan ${change.ratePlanId} does not belong to that room type - skipped`);
          continue;
        }

        const amount = Number(change.rate);
        if (!Number.isFinite(amount) || amount < 0) {
          warnings.push(`${roomType.name} ${change.date}: invalid rate - skipped`);
          continue;
        }

        await conn.execute(
          `INSERT INTO rates (org_id, property_id, rate_plan_id, stay_date, amount, currency)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE amount = VALUES(amount), currency = VALUES(currency)`,
          [orgId, propertyId, plan.id, change.date, amount.toFixed(2), currency]
        );

        touched.add(`${roomType.id}|${change.date}`);
        applied++;
      }
    }

    await conn.execute(
      `INSERT INTO audit_log (org_id, property_id, user_id, action, detail)
       VALUES (?, ?, ?, 'calendar.update', ?)`,
      [orgId, propertyId, userId, JSON.stringify({ changes: changes.length, applied, warnings: warnings.length })]
    );

    return { applied, touched: [...touched] };
  });

  // Queue the push only after the transaction committed - otherwise a worker
  // could read the old values before the write is visible.
  if (result.touched.length) {
    await enqueueAriSync({ orgId, propertyId, cells: result.touched });
  }

  return { applied: result.applied, warnings };
}

/**
 * Recalculate `booked` for a room type / date range straight from the
 * reservations table.
 *
 * Kept as a derived value that can always be rebuilt: a counter that is only
 * ever incremented drifts, and drift in this particular counter means either
 * overbooking or unsold rooms.
 */
export async function recalculateBooked(conn, orgId, propertyId, roomTypeId, from, to) {
  await conn.execute(
    `UPDATE inventory inv
        SET inv.booked = (
              SELECT COALESCE(SUM(r.rooms), 0)
                FROM reservations r
               WHERE r.room_type_id = inv.room_type_id
                 AND r.status IN ('confirmed','checked_in')
                 AND r.check_in  <= inv.stay_date
                 AND r.check_out >  inv.stay_date
            )
      WHERE inv.org_id = ? AND inv.property_id = ? AND inv.room_type_id = ?
        AND inv.stay_date BETWEEN ? AND ?`,
    [orgId, propertyId, roomTypeId, from, to]
  );

  // A reservation can push booked past allotment (a channel sold a room we
  // had already withdrawn). We do not silently discard it - the room is sold.
  // We raise allotment to match so the number stays truthful, and the sync
  // pushes the reduced availability straight back out.
  await conn.execute(
    `UPDATE inventory
        SET allotment = booked
      WHERE org_id = ? AND property_id = ? AND room_type_id = ?
        AND stay_date BETWEEN ? AND ? AND booked > allotment`,
    [orgId, propertyId, roomTypeId, from, to]
  );
}

export async function ensureInventoryRows(orgId, propertyId, roomTypeId, from, to, defaultAllotment) {
  const dates = dateRange(from, to);
  if (!dates.length) return;

  const values = dates.map(() => '(?, ?, ?, ?, ?)').join(',');
  const params = [];
  for (const d of dates) params.push(orgId, propertyId, roomTypeId, d, defaultAllotment);

  await query(
    `INSERT INTO inventory (org_id, property_id, room_type_id, stay_date, allotment)
     VALUES ${values}
     ON DUPLICATE KEY UPDATE allotment = allotment`,
    params
  );
}
