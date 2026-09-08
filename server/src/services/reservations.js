import { transaction, query } from '../db.js';
import { recalculateBooked, addDays, dateRange } from './inventory.js';
import { enqueueAriSync } from './sync.js';

/**
 * Take a reservation from a channel and land it in our system.
 *
 * Three things have to be true and they are easy to get wrong:
 *
 *  1. IDEMPOTENT. Channels redeliver webhooks and poll windows overlap. The
 *     unique key on (channel_id, remote_ref) plus ON DUPLICATE KEY UPDATE
 *     means the same booking arriving twice updates one row instead of
 *     selling the room twice.
 *
 *  2. ATOMIC with the availability change. The booking row and the `booked`
 *     counts move in one transaction, so availability is never briefly wrong.
 *
 *  3. IT PUSHES BACK OUT. A booking taken on one channel has to reduce
 *     availability on all the others - that is the whole point. The sync is
 *     queued from here, not left to a nightly job.
 */
export async function ingestReservation({ orgId, propertyId, channelId, reservation }) {
  const {
    remoteRef, remoteRoomTypeId, remoteRatePlanId,
    guestName = '', guestEmail = '', guestPhone = '',
    checkIn, checkOut, rooms = 1, adults = 2, children = 0,
    totalAmount = 0, currency = 'LKR', status = 'confirmed',
  } = reservation;

  if (!remoteRef) throw new Error('Reservation has no reference');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkIn) || !/^\d{4}-\d{2}-\d{2}$/.test(checkOut)) {
    throw new Error(`Reservation ${remoteRef}: invalid dates`);
  }
  if (checkOut <= checkIn) {
    throw new Error(`Reservation ${remoteRef}: check-out must be after check-in`);
  }

  const result = await transaction(async (conn) => {
    // Translate the channel's room id into ours.
    const [[mapping]] = await conn.execute(
      `SELECT entity_id FROM channel_mappings
        WHERE channel_id = ? AND entity_type = 'room_type' AND remote_id = ?`,
      [channelId, String(remoteRoomTypeId)]
    );
    if (!mapping) {
      throw new Error(
        `Reservation ${remoteRef}: channel room "${remoteRoomTypeId}" is not mapped to a room type`
      );
    }
    const roomTypeId = Number(mapping.entity_id);

    let ratePlanId = null;
    if (remoteRatePlanId) {
      const [[rp]] = await conn.execute(
        `SELECT entity_id FROM channel_mappings
          WHERE channel_id = ? AND entity_type = 'rate_plan' AND remote_id = ?`,
        [channelId, String(remoteRatePlanId)]
      );
      if (rp) ratePlanId = Number(rp.entity_id);
    }

    // What did this booking look like before, if we have seen it? Needed so
    // a modification or cancellation releases the nights it used to hold.
    const [[previous]] = await conn.execute(
      `SELECT id, room_type_id, check_in, check_out, status
         FROM reservations
        WHERE channel_id = ? AND remote_ref = ?
        FOR UPDATE`,
      [channelId, remoteRef]
    );

    await conn.execute(
      `INSERT INTO reservations
         (org_id, property_id, channel_id, remote_ref, room_type_id, rate_plan_id,
          guest_name, guest_email, guest_phone, check_in, check_out,
          rooms, adults, children, total_amount, currency, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         room_type_id = VALUES(room_type_id),
         rate_plan_id = VALUES(rate_plan_id),
         guest_name   = VALUES(guest_name),
         guest_email  = VALUES(guest_email),
         guest_phone  = VALUES(guest_phone),
         check_in     = VALUES(check_in),
         check_out    = VALUES(check_out),
         rooms        = VALUES(rooms),
         adults       = VALUES(adults),
         children     = VALUES(children),
         total_amount = VALUES(total_amount),
         currency     = VALUES(currency),
         status       = VALUES(status)`,
      [orgId, propertyId, channelId, remoteRef, roomTypeId, ratePlanId,
       guestName, guestEmail, guestPhone, checkIn, checkOut,
       rooms, adults, children, Number(totalAmount).toFixed(2), currency, status]
    );

    // Every night affected, old dates included, so a shortened stay frees the
    // nights it no longer occupies.
    const spans = [{ roomTypeId, from: checkIn, to: addDays(checkOut, -1) }];
    if (previous) {
      spans.push({
        roomTypeId: Number(previous.room_type_id),
        from: previous.check_in,
        to: addDays(previous.check_out, -1),
      });
    }

    const touched = new Set();
    for (const span of spans) {
      // Make sure a row exists for each night before recalculating, otherwise
      // a booking for a date nobody has loaded yet updates nothing.
      const dates = dateRange(span.from, span.to);
      if (dates.length) {
        const vals = dates.map(() => '(?, ?, ?, ?, 0)').join(',');
        const params = [];
        for (const d of dates) params.push(orgId, propertyId, span.roomTypeId, d);
        await conn.query(
          `INSERT INTO inventory (org_id, property_id, room_type_id, stay_date, allotment)
           VALUES ${vals}
           ON DUPLICATE KEY UPDATE allotment = allotment`,
          params
        );
      }

      await recalculateBooked(conn, orgId, propertyId, span.roomTypeId, span.from, span.to);
      for (const d of dates) touched.add(`${span.roomTypeId}|${d}`);
    }

    await conn.execute(
      `INSERT INTO audit_log (org_id, property_id, user_id, action, detail)
       VALUES (?, ?, NULL, 'reservation.ingest', ?)`,
      [orgId, propertyId, JSON.stringify({ remoteRef, status, checkIn, checkOut, rooms })]
    );

    return { roomTypeId, touched: [...touched], wasUpdate: !!previous };
  });

  // Availability changed, so every other channel needs to hear about it.
  if (result.touched.length) {
    await enqueueAriSync({ orgId, propertyId, cells: result.touched });
  }

  return result;
}

export async function listReservations(orgId, propertyId, { from, to, status, limit = 200 }) {
  const params = [orgId, propertyId];
  let sql = `
    SELECT r.id, r.remote_ref, r.guest_name, r.guest_email, r.guest_phone,
           r.check_in, r.check_out, r.rooms, r.adults, r.children,
           r.total_amount, r.currency, r.status, r.received_at,
           rt.name AS room_type_name, rt.code AS room_type_code,
           c.name AS channel_name
      FROM reservations r
      JOIN room_types rt ON rt.id = r.room_type_id
      LEFT JOIN channels c ON c.id = r.channel_id
     WHERE r.org_id = ? AND r.property_id = ?`;

  if (from) { sql += ` AND r.check_out > ?`; params.push(from); }
  if (to)   { sql += ` AND r.check_in  <= ?`; params.push(to); }
  if (status) { sql += ` AND r.status = ?`; params.push(status); }

  sql += ` ORDER BY r.check_in DESC, r.id DESC LIMIT ${Math.min(Number(limit) || 200, 1000)}`;

  const rows = await query(sql, params);
  return rows.map((r) => ({
    ...r,
    total_amount: Number(r.total_amount),
    rooms: Number(r.rooms),
  }));
}
