import { query, one, pool } from '../db.js';
import { config } from '../config.js';
import { createAdapter, getAdapterClass } from '../channels/registry.js';

/**
 * Queue an availability/rate push for a set of (roomTypeId, date) cells.
 *
 * One job per channel, not one per cell: channels rate-limit per request, not
 * per date, so batching is what keeps a bulk edit from taking an hour.
 *
 * Coalescing: if a queued job for the same channel already exists, the new
 * cells are merged into it. Editing thirty dates in a row should produce one
 * push, not thirty.
 */
export async function enqueueAriSync({ orgId, propertyId, cells }) {
  if (!cells || !cells.length) return { queued: 0 };

  const channels = await query(
    `SELECT id FROM channels
      WHERE property_id = ? AND org_id = ? AND enabled = 1`,
    [propertyId, orgId]
  );
  if (!channels.length) return { queued: 0 };

  // Mark every affected cell as pending so the calendar shows it immediately,
  // before a worker has picked the job up.
  const stateValues = [];
  const stateParams = [];
  for (const ch of channels) {
    for (const cell of cells) {
      const [roomTypeId, date] = cell.split('|');
      stateValues.push('(?, ?, ?, ?)');
      stateParams.push(ch.id, roomTypeId, date, 'pending');
    }
  }
  if (stateValues.length) {
    // Chunked: a month-long bulk edit across several room types and channels
    // can exceed the placeholder limit in a single statement.
    const CHUNK = 500;
    for (let i = 0; i < stateValues.length; i += CHUNK) {
      const vals = stateValues.slice(i, i + CHUNK).join(',');
      const params = stateParams.slice(i * 4, (i + CHUNK) * 4);
      await query(
        `INSERT INTO channel_sync_state (channel_id, room_type_id, stay_date, state)
         VALUES ${vals}
         ON DUPLICATE KEY UPDATE state = VALUES(state), message = ''`,
        params
      );
    }
  }

  let queued = 0;
  for (const ch of channels) {
    const existing = await one(
      `SELECT id, payload FROM sync_jobs
        WHERE channel_id = ? AND job_type = 'push_ari' AND status = 'queued'
        ORDER BY id LIMIT 1`,
      [ch.id]
    );

    if (existing) {
      const payload = typeof existing.payload === 'string'
        ? JSON.parse(existing.payload)
        : existing.payload;
      const merged = new Set([...(payload.cells || []), ...cells]);
      await query(
        `UPDATE sync_jobs SET payload = ? WHERE id = ?`,
        [JSON.stringify({ cells: [...merged] }), existing.id]
      );
    } else {
      await query(
        `INSERT INTO sync_jobs (org_id, property_id, channel_id, job_type, payload)
         VALUES (?, ?, ?, 'push_ari', ?)`,
        [orgId, propertyId, ch.id, JSON.stringify({ cells })]
      );
      queued++;
    }
  }

  return { queued };
}

/**
 * Claim a batch of jobs for this worker.
 *
 * The UPDATE ... WHERE status='queued' is what makes this safe with several
 * workers: MySQL serialises the row locks, so a job is claimed exactly once.
 * A SELECT-then-UPDATE would hand the same job to two workers.
 */
export async function claimJobs(workerId, limit) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT id FROM sync_jobs
        WHERE status = 'queued' AND run_after <= NOW()
        ORDER BY id
        LIMIT ${Number(limit) || 10}
        FOR UPDATE SKIP LOCKED`
    );
    if (!rows.length) {
      await conn.commit();
      return [];
    }
    const ids = rows.map((r) => r.id);
    await conn.query(
      `UPDATE sync_jobs
          SET status = 'running', claimed_by = ?, attempts = attempts + 1
        WHERE id IN (?)`,
      [workerId, ids]
    );
    await conn.commit();

    const [jobs] = await conn.query(`SELECT * FROM sync_jobs WHERE id IN (?)`, [ids]);
    return jobs;
  } catch (err) {
    try { await conn.rollback(); } catch { /* noop */ }
    throw err;
  } finally {
    conn.release();
  }
}

export async function completeJob(jobId) {
  await query(
    `UPDATE sync_jobs SET status = 'done', finished_at = NOW(), last_error = NULL WHERE id = ?`,
    [jobId]
  );
}

export async function failJob(job, error) {
  const attempts = Number(job.attempts);
  const maxAttempts = Number(job.max_attempts);
  const message = String(error && error.message ? error.message : error).slice(0, 2000);

  if (attempts >= maxAttempts) {
    await query(
      `UPDATE sync_jobs SET status = 'failed', finished_at = NOW(), last_error = ? WHERE id = ?`,
      [message, job.id]
    );
    // Leave the affected cells visibly failed rather than quietly pending.
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    await markCells(job.channel_id, payload.cells || [], 'failed', message);
    return { retried: false };
  }

  const delaySec = config.worker.backoff[Math.min(attempts - 1, config.worker.backoff.length - 1)];
  await query(
    `UPDATE sync_jobs
        SET status = 'queued', run_after = DATE_ADD(NOW(), INTERVAL ? SECOND), last_error = ?
      WHERE id = ?`,
    [delaySec, message, job.id]
  );
  return { retried: true, delaySec };
}

export async function markCells(channelId, cells, state, message = '') {
  if (!cells.length) return;
  const CHUNK = 500;
  for (let i = 0; i < cells.length; i += CHUNK) {
    const slice = cells.slice(i, i + CHUNK);
    const vals = slice.map(() => '(?, ?, ?, ?, ?)').join(',');
    const params = [];
    for (const cell of slice) {
      const [roomTypeId, date] = cell.split('|');
      params.push(channelId, roomTypeId, date, state, message.slice(0, 255));
    }
    await query(
      `INSERT INTO channel_sync_state (channel_id, room_type_id, stay_date, state, message)
       VALUES ${vals}
       ON DUPLICATE KEY UPDATE state = VALUES(state), message = VALUES(message)`,
      params
    );
  }
}

/**
 * Build the payload for a push and hand it to the adapter.
 */
export async function runPushAri(job, log) {
  const channel = await one(`SELECT * FROM channels WHERE id = ?`, [job.channel_id]);
  if (!channel) throw new Error('Channel no longer exists');
  if (!channel.enabled) {
    log('info', `Channel ${channel.name} is disabled, skipping`);
    return;
  }

  const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
  let cells = payload.cells || [];
  if (!cells.length) return;

  const Adapter = getAdapterClass(channel.adapter);
  const caps = Adapter.capabilities;

  // Providers that cannot take individual dates get the whole span instead.
  if (!caps.deltaUpdates) {
    cells = widenToFullRange(cells);
  }

  const mappings = await query(
    `SELECT entity_type, entity_id, remote_id FROM channel_mappings WHERE channel_id = ?`,
    [job.channel_id]
  );
  const roomMap = new Map();
  const planMap = new Map();
  for (const m of mappings) {
    if (m.entity_type === 'room_type') roomMap.set(String(m.entity_id), m.remote_id);
    else planMap.set(String(m.entity_id), m.remote_id);
  }

  const roomTypeIds = [...new Set(cells.map((c) => c.split('|')[0]))];
  const dates = [...new Set(cells.map((c) => c.split('|')[1]))].sort();

  // An unmapped room type is a configuration problem, not a transient error.
  // Fail those cells with a clear message instead of retrying five times.
  const unmapped = roomTypeIds.filter((id) => !roomMap.has(String(id)));
  if (unmapped.length) {
    const names = await query(
      `SELECT id, name FROM room_types WHERE id IN (?)`,
      [unmapped]
    ).catch(() => []);
    const label = names.map((r) => r.name).join(', ') || unmapped.join(', ');
    const affected = cells.filter((c) => unmapped.includes(c.split('|')[0]));
    await markCells(job.channel_id, affected, 'failed',
      `Not mapped to a room on ${channel.name}`);
    cells = cells.filter((c) => !unmapped.includes(c.split('|')[0]));
    log('warn', `Skipping unmapped room types: ${label}`);
    if (!cells.length) return;
  }

  const [inventory, rates] = await Promise.all([
    query(
      `SELECT room_type_id, stay_date, allotment, booked, stop_sell,
              min_stay, max_stay, closed_arrival, closed_departure
         FROM inventory
        WHERE property_id = ? AND room_type_id IN (?) AND stay_date IN (?)`,
      [job.property_id, roomTypeIds, dates]
    ),
    query(
      `SELECT r.rate_plan_id, rp.room_type_id, r.stay_date, r.amount, r.currency
         FROM rates r
         JOIN rate_plans rp ON rp.id = r.rate_plan_id
        WHERE r.property_id = ? AND rp.room_type_id IN (?) AND r.stay_date IN (?)`,
      [job.property_id, roomTypeIds, dates]
    ),
  ]);

  const invMap = new Map();
  for (const r of inventory) invMap.set(`${r.room_type_id}|${r.stay_date}`, r);

  const ratesByCell = new Map();
  for (const r of rates) {
    const key = `${r.room_type_id}|${r.stay_date}`;
    if (!ratesByCell.has(key)) ratesByCell.set(key, []);
    ratesByCell.get(key).push(r);
  }

  const items = [];
  for (const cell of cells) {
    const [roomTypeId, date] = cell.split('|');
    const inv = invMap.get(cell);
    const available = inv ? Math.max(0, Number(inv.allotment) - Number(inv.booked)) : 0;
    const cellRates = ratesByCell.get(cell) || [];

    if (cellRates.length === 0) {
      items.push({
        cell,
        remoteRoomTypeId: roomMap.get(String(roomTypeId)),
        remoteRatePlanId: null,
        date,
        available,
        stopSell: inv ? !!inv.stop_sell : false,
        minStay: inv ? Number(inv.min_stay) : 1,
        maxStay: inv ? Number(inv.max_stay) : 0,
        closedArrival: inv ? !!inv.closed_arrival : false,
        closedDeparture: inv ? !!inv.closed_departure : false,
        rate: null,
        currency: null,
      });
      continue;
    }

    for (const r of cellRates) {
      items.push({
        cell,
        remoteRoomTypeId: roomMap.get(String(roomTypeId)),
        remoteRatePlanId: planMap.get(String(r.rate_plan_id)) || null,
        date,
        available,
        stopSell: inv ? !!inv.stop_sell : false,
        minStay: inv ? Number(inv.min_stay) : 1,
        maxStay: inv ? Number(inv.max_stay) : 0,
        closedArrival: inv ? !!inv.closed_arrival : false,
        closedDeparture: inv ? !!inv.closed_departure : false,
        rate: Number(r.amount),
        currency: r.currency,
      });
    }
  }

  const adapter = createAdapter(channel, log);
  const maxPerRequest = caps.maxDatesPerRequest || 60;

  const failedCells = new Map();
  let sentCells = new Set();

  for (let i = 0; i < items.length; i += maxPerRequest) {
    const slice = items.slice(i, i + maxPerRequest);
    const res = await adapter.pushAri({
      propertyRemoteId: channel.remote_property_id || null,
      items: slice.map(({ cell, ...rest }) => rest),
    });

    for (const item of slice) sentCells.add(item.cell);

    for (const rej of res.rejected || []) {
      // Map the rejected date back to every cell that carried it.
      for (const item of slice) {
        if (item.date === rej.date) failedCells.set(item.cell, rej.reason);
      }
    }
  }

  const ok = [...sentCells].filter((c) => !failedCells.has(c));
  await markCells(job.channel_id, ok, 'synced', '');
  for (const [cell, reason] of failedCells) {
    await markCells(job.channel_id, [cell], 'failed', reason);
  }

  await query(
    `UPDATE channels SET last_sync_at = NOW(), last_error = NULL WHERE id = ?`,
    [channel.id]
  );

  log('info', `${channel.name}: ${ok.length} dates synced, ${failedCells.size} rejected`);
}

function widenToFullRange(cells) {
  const byRoom = new Map();
  for (const c of cells) {
    const [roomTypeId, date] = c.split('|');
    if (!byRoom.has(roomTypeId)) byRoom.set(roomTypeId, []);
    byRoom.get(roomTypeId).push(date);
  }
  const out = [];
  for (const [roomTypeId, dates] of byRoom) {
    dates.sort();
    let cur = dates[0];
    const end = dates[dates.length - 1];
    for (let i = 0; i < 400 && cur <= end; i++) {
      out.push(`${roomTypeId}|${cur}`);
      const d = new Date(cur + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      cur = d.toISOString().slice(0, 10);
    }
  }
  return out;
}
