import express from 'express';
import { query, one } from './db.js';
import { requireAuth, requireRole, assertProperty, issueToken, verifyPassword, hashPassword } from './auth.js';
import { getCalendar, applyCalendarChanges, addDays, ensureInventoryRows } from './services/inventory.js';
import { ingestReservation, listReservations } from './services/reservations.js';
import { enqueueAriSync } from './services/sync.js';
import { listAdapters, createAdapter } from './channels/registry.js';
import { config } from './config.js';

export const router = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

router.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = await one(
    `SELECT id, org_id, email, full_name, role, status, password_hash
       FROM users WHERE email = ?`,
    [String(email).toLowerCase().trim()]
  );

  // Same message either way so the endpoint cannot be used to discover which
  // email addresses have accounts.
  const bad = () => res.status(401).json({ error: 'Email or password is incorrect' });
  if (!user || user.status !== 'active') return bad();
  if (!(await verifyPassword(password, user.password_hash))) return bad();

  await query(`UPDATE users SET last_login_at = NOW() WHERE id = ?`, [user.id]);
  const org = await one(`SELECT id, name FROM orgs WHERE id = ?`, [user.org_id]);

  res.json({
    token: issueToken(user),
    user: {
      id: Number(user.id), email: user.email, name: user.full_name,
      role: user.role, org: { id: Number(org.id), name: org.name },
    },
  });
}));

router.get('/auth/me', requireAuth, wrap(async (req, res) => {
  const org = await one(`SELECT id, name FROM orgs WHERE id = ?`, [req.user.orgId]);
  res.json({ user: { ...req.user, org: { id: Number(org.id), name: org.name } } });
}));

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

router.get('/properties', requireAuth, wrap(async (req, res) => {
  let sql = `SELECT id, name, code, timezone, currency, status
               FROM properties WHERE org_id = ? AND status = 'active'`;
  const params = [req.user.orgId];

  if (req.user.propertyIds !== null) {
    if (!req.user.propertyIds.length) return res.json({ properties: [] });
    sql += ` AND id IN (${req.user.propertyIds.map(() => '?').join(',')})`;
    params.push(...req.user.propertyIds);
  }
  sql += ` ORDER BY name`;

  const properties = await query(sql, params);
  res.json({ properties: properties.map((p) => ({ ...p, id: Number(p.id) })) });
}));

// ---------------------------------------------------------------------------
// The calendar - the screen this product lives or dies by
// ---------------------------------------------------------------------------

router.get('/properties/:propertyId/calendar', requireAuth, wrap(async (req, res) => {
  const property = await assertProperty(req, req.params.propertyId);

  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')
    ? req.query.from
    : new Date().toISOString().slice(0, 10);

  let to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')
    ? req.query.to
    : addDays(from, config.calendar.defaultDays - 1);

  // Hard cap. An unbounded range is how these screens end up shipping
  // megabytes of JSON and timing out.
  const maxTo = addDays(from, config.calendar.maxDays - 1);
  if (to > maxTo) to = maxTo;
  if (to < from) to = from;

  const data = await getCalendar(req.user.orgId, property.id, from, to);
  res.json({ property, from, to, ...data });
}));

router.post('/properties/:propertyId/calendar', requireAuth,
  requireRole('owner', 'manager', 'frontdesk'), wrap(async (req, res) => {
    const property = await assertProperty(req, req.params.propertyId);
    const { changes } = req.body || {};

    const result = await applyCalendarChanges({
      orgId: req.user.orgId,
      propertyId: property.id,
      userId: req.user.id,
      changes,
    });

    res.json(result);
  })
);

/**
 * Bulk edit: apply one set of values across a date range, optionally limited
 * to certain weekdays. This is the tool that turns "raise weekend rates for
 * December" from 30 clicks into one.
 */
router.post('/properties/:propertyId/calendar/bulk', requireAuth,
  requireRole('owner', 'manager'), wrap(async (req, res) => {
    const property = await assertProperty(req, req.params.propertyId);
    const {
      roomTypeIds = [], ratePlanId = null, from, to,
      weekdays = null, allotment, rate, stopSell, minStay,
    } = req.body || {};

    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'A valid date range is required' });
    }
    if (!roomTypeIds.length) {
      return res.status(400).json({ error: 'Select at least one room type' });
    }

    const changes = [];
    let cursor = from;
    for (let i = 0; i < config.calendar.maxDays && cursor <= to; i++) {
      const dow = new Date(cursor + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
      if (!weekdays || weekdays.includes(dow)) {
        for (const rtId of roomTypeIds) {
          const change = { roomTypeId: rtId, date: cursor };
          if (allotment !== undefined && allotment !== null && allotment !== '') {
            change.allotment = Number(allotment);
          }
          if (stopSell !== undefined && stopSell !== null) change.stopSell = !!stopSell;
          if (minStay !== undefined && minStay !== null && minStay !== '') {
            change.minStay = Number(minStay);
          }
          if (rate !== undefined && rate !== null && rate !== '' && ratePlanId) {
            change.rate = Number(rate);
            change.ratePlanId = ratePlanId;
          }
          if (Object.keys(change).length > 2) changes.push(change);
        }
      }
      cursor = addDays(cursor, 1);
    }

    const result = await applyCalendarChanges({
      orgId: req.user.orgId,
      propertyId: property.id,
      userId: req.user.id,
      changes,
    });

    res.json({ ...result, datesAffected: changes.length });
  })
);

// ---------------------------------------------------------------------------
// Room types and rate plans
// ---------------------------------------------------------------------------

router.get('/properties/:propertyId/room-types', requireAuth, wrap(async (req, res) => {
  const property = await assertProperty(req, req.params.propertyId);
  const roomTypes = await query(
    `SELECT id, code, name, total_rooms, max_occupancy, sort_order, status
       FROM room_types WHERE property_id = ? AND org_id = ? ORDER BY sort_order, name`,
    [property.id, req.user.orgId]
  );
  const ratePlans = await query(
    `SELECT id, room_type_id, code, name, meal_plan, pricing_mode, status
       FROM rate_plans WHERE property_id = ? AND org_id = ? ORDER BY name`,
    [property.id, req.user.orgId]
  );
  res.json({ roomTypes, ratePlans });
}));

router.post('/properties/:propertyId/room-types', requireAuth,
  requireRole('owner', 'manager'), wrap(async (req, res) => {
    const property = await assertProperty(req, req.params.propertyId);
    const { code, name, totalRooms = 0, maxOccupancy = 2 } = req.body || {};
    if (!code || !name) return res.status(400).json({ error: 'Code and name are required' });

    const result = await query(
      `INSERT INTO room_types (org_id, property_id, code, name, total_rooms, max_occupancy)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.user.orgId, property.id, code, name, Number(totalRooms), Number(maxOccupancy)]
    );

    // Pre-create the next 90 nights so the room appears on the calendar
    // straight away rather than as a row of blanks.
    const today = new Date().toISOString().slice(0, 10);
    await ensureInventoryRows(
      req.user.orgId, property.id, result.insertId,
      today, addDays(today, config.calendar.maxDays - 1), Number(totalRooms)
    );

    res.status(201).json({ id: Number(result.insertId) });
  })
);

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

router.get('/channel-adapters', requireAuth, wrap(async (req, res) => {
  res.json({ adapters: listAdapters() });
}));

router.get('/properties/:propertyId/channels', requireAuth, wrap(async (req, res) => {
  const property = await assertProperty(req, req.params.propertyId);

  const channels = await query(
    `SELECT id, adapter, name, enabled, last_sync_at, last_error
       FROM channels WHERE property_id = ? AND org_id = ? ORDER BY name`,
    [property.id, req.user.orgId]
  );

  // Queue depth and failures per channel, so the UI can show whether a
  // channel is keeping up without anyone opening a log file.
  const stats = await query(
    `SELECT channel_id,
            SUM(status = 'queued')  AS queued,
            SUM(status = 'running') AS running,
            SUM(status = 'failed')  AS failed
       FROM sync_jobs
      WHERE property_id = ? AND org_id = ?
      GROUP BY channel_id`,
    [property.id, req.user.orgId]
  );
  const statMap = new Map(stats.map((s) => [String(s.channel_id), s]));

  const pending = await query(
    `SELECT css.channel_id, css.state, COUNT(*) AS n
       FROM channel_sync_state css
       JOIN channels c ON c.id = css.channel_id
      WHERE c.property_id = ? AND c.org_id = ?
      GROUP BY css.channel_id, css.state`,
    [property.id, req.user.orgId]
  );
  const cellMap = new Map();
  for (const p of pending) {
    const key = String(p.channel_id);
    if (!cellMap.has(key)) cellMap.set(key, { pending: 0, synced: 0, failed: 0 });
    cellMap.get(key)[p.state] = Number(p.n);
  }

  res.json({
    channels: channels.map((c) => ({
      ...c,
      id: Number(c.id),
      enabled: !!c.enabled,
      jobs: statMap.get(String(c.id)) || { queued: 0, running: 0, failed: 0 },
      cells: cellMap.get(String(c.id)) || { pending: 0, synced: 0, failed: 0 },
    })),
  });
}));

router.post('/properties/:propertyId/channels', requireAuth,
  requireRole('owner', 'manager'), wrap(async (req, res) => {
    const property = await assertProperty(req, req.params.propertyId);
    const { adapter, name, credentials = {} } = req.body || {};
    if (!adapter || !name) return res.status(400).json({ error: 'Adapter and name are required' });

    const result = await query(
      `INSERT INTO channels (org_id, property_id, adapter, name, credentials)
       VALUES (?, ?, ?, ?, ?)`,
      [req.user.orgId, property.id, adapter, name, JSON.stringify(credentials)]
    );
    res.status(201).json({ id: Number(result.insertId) });
  })
);

router.post('/channels/:channelId/test', requireAuth,
  requireRole('owner', 'manager'), wrap(async (req, res) => {
    const channel = await one(
      `SELECT * FROM channels WHERE id = ? AND org_id = ?`,
      [req.params.channelId, req.user.orgId]
    );
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const adapter = createAdapter(channel, () => {});
    try {
      const result = await adapter.testConnection();
      await query(`UPDATE channels SET last_error = NULL WHERE id = ?`, [channel.id]);
      res.json(result);
    } catch (err) {
      await query(`UPDATE channels SET last_error = ? WHERE id = ?`,
        [String(err.message).slice(0, 2000), channel.id]);
      res.status(400).json({ ok: false, error: err.message });
    }
  })
);

router.get('/channels/:channelId/remote-inventory', requireAuth, wrap(async (req, res) => {
  const channel = await one(
    `SELECT * FROM channels WHERE id = ? AND org_id = ?`,
    [req.params.channelId, req.user.orgId]
  );
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const adapter = createAdapter(channel, () => {});
  const remote = await adapter.fetchRemoteInventory();

  const mappings = await query(
    `SELECT entity_type, entity_id, remote_id FROM channel_mappings WHERE channel_id = ?`,
    [channel.id]
  );
  res.json({ remote, mappings });
}));

router.put('/channels/:channelId/mappings', requireAuth,
  requireRole('owner', 'manager'), wrap(async (req, res) => {
    const channel = await one(
      `SELECT * FROM channels WHERE id = ? AND org_id = ?`,
      [req.params.channelId, req.user.orgId]
    );
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const { mappings = [] } = req.body || {};
    for (const m of mappings) {
      if (!['room_type', 'rate_plan'].includes(m.entityType)) continue;

      // Confirm the entity really belongs to this channel's property.
      const table = m.entityType === 'room_type' ? 'room_types' : 'rate_plans';
      const owned = await one(
        `SELECT id FROM ${table} WHERE id = ? AND property_id = ? AND org_id = ?`,
        [m.entityId, channel.property_id, req.user.orgId]
      );
      if (!owned) continue;

      if (m.remoteId) {
        await query(
          `INSERT INTO channel_mappings (org_id, channel_id, entity_type, entity_id, remote_id, remote_name)
           VALUES (?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE remote_id = VALUES(remote_id), remote_name = VALUES(remote_name)`,
          [req.user.orgId, channel.id, m.entityType, m.entityId, m.remoteId, m.remoteName || '']
        );
      } else {
        await query(
          `DELETE FROM channel_mappings
            WHERE channel_id = ? AND entity_type = ? AND entity_id = ?`,
          [channel.id, m.entityType, m.entityId]
        );
      }
    }
    res.json({ ok: true });
  })
);

/** Push everything in a date range to a channel - the "resync" button. */
router.post('/channels/:channelId/resync', requireAuth,
  requireRole('owner', 'manager'), wrap(async (req, res) => {
    const channel = await one(
      `SELECT * FROM channels WHERE id = ? AND org_id = ?`,
      [req.params.channelId, req.user.orgId]
    );
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const from = req.body?.from || new Date().toISOString().slice(0, 10);
    const to = req.body?.to || addDays(from, 29);

    const roomTypes = await query(
      `SELECT id FROM room_types WHERE property_id = ? AND status = 'active'`,
      [channel.property_id]
    );

    const cells = [];
    for (const rt of roomTypes) {
      let cur = from;
      for (let i = 0; i < config.calendar.maxDays && cur <= to; i++) {
        cells.push(`${rt.id}|${cur}`);
        cur = addDays(cur, 1);
      }
    }

    await enqueueAriSync({
      orgId: req.user.orgId,
      propertyId: Number(channel.property_id),
      cells,
    });
    res.json({ queued: cells.length });
  })
);

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

router.get('/properties/:propertyId/reservations', requireAuth, wrap(async (req, res) => {
  const property = await assertProperty(req, req.params.propertyId);
  const reservations = await listReservations(req.user.orgId, property.id, {
    from: req.query.from, to: req.query.to, status: req.query.status,
  });
  res.json({ reservations });
}));

/**
 * Demo endpoint: inject a booking as though a channel had sent it.
 * Lets the overbooking guard be demonstrated without a live channel.
 */
router.post('/channels/:channelId/demo-reservation', requireAuth,
  requireRole('owner', 'manager'), wrap(async (req, res) => {
    const channel = await one(
      `SELECT * FROM channels WHERE id = ? AND org_id = ?`,
      [req.params.channelId, req.user.orgId]
    );
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const result = await ingestReservation({
      orgId: req.user.orgId,
      propertyId: Number(channel.property_id),
      channelId: channel.id,
      reservation: req.body,
    });
    res.status(201).json(result);
  })
);

// ---------------------------------------------------------------------------
// Sync activity - visible queue
// ---------------------------------------------------------------------------

router.get('/properties/:propertyId/sync-jobs', requireAuth, wrap(async (req, res) => {
  const property = await assertProperty(req, req.params.propertyId);
  const jobs = await query(
    `SELECT j.id, j.job_type, j.status, j.attempts, j.max_attempts,
            j.last_error, j.created_at, j.finished_at, j.run_after,
            c.name AS channel_name
       FROM sync_jobs j
       LEFT JOIN channels c ON c.id = j.channel_id
      WHERE j.property_id = ? AND j.org_id = ?
      ORDER BY j.id DESC LIMIT 100`,
    [property.id, req.user.orgId]
  );
  res.json({ jobs: jobs.map((j) => ({ ...j, id: Number(j.id) })) });
}));

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

router.get('/properties/:propertyId/dashboard', requireAuth, wrap(async (req, res) => {
  const property = await assertProperty(req, req.params.propertyId);
  const today = new Date().toISOString().slice(0, 10);
  const horizon = addDays(today, 29);

  const [occupancy] = await query(
    `SELECT COALESCE(SUM(booked),0) AS booked, COALESCE(SUM(allotment),0) AS allotment
       FROM inventory
      WHERE property_id = ? AND org_id = ? AND stay_date BETWEEN ? AND ?`,
    [property.id, req.user.orgId, today, horizon]
  );

  const [arrivals] = await query(
    `SELECT COUNT(*) AS n FROM reservations
      WHERE property_id = ? AND org_id = ? AND check_in = ? AND status = 'confirmed'`,
    [property.id, req.user.orgId, today]
  );

  const [departures] = await query(
    `SELECT COUNT(*) AS n FROM reservations
      WHERE property_id = ? AND org_id = ? AND check_out = ? AND status IN ('confirmed','checked_in')`,
    [property.id, req.user.orgId, today]
  );

  const [revenue] = await query(
    `SELECT COALESCE(SUM(total_amount),0) AS total FROM reservations
      WHERE property_id = ? AND org_id = ? AND status <> 'cancelled'
        AND check_in BETWEEN ? AND ?`,
    [property.id, req.user.orgId, today, horizon]
  );

  const [syncHealth] = await query(
    `SELECT SUM(css.state = 'failed')  AS failed,
            SUM(css.state = 'pending') AS pending
       FROM channel_sync_state css
       JOIN channels c ON c.id = css.channel_id
      WHERE c.property_id = ? AND c.org_id = ? AND css.stay_date >= ?`,
    [property.id, req.user.orgId, today]
  );

  const allotment = Number(occupancy.allotment) || 0;
  const booked = Number(occupancy.booked) || 0;

  res.json({
    property,
    next30Days: {
      roomNightsSold: booked,
      roomNightsAvailable: allotment,
      occupancyPct: allotment ? Math.round((booked / allotment) * 1000) / 10 : 0,
      revenue: Number(revenue.total),
      currency: property.currency,
    },
    today: {
      arrivals: Number(arrivals.n),
      departures: Number(departures.n),
    },
    sync: {
      failedCells: Number(syncHealth.failed) || 0,
      pendingCells: Number(syncHealth.pending) || 0,
    },
  });
}));
