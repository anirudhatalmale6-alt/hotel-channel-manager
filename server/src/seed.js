/**
 * Demo data: one hotel group, two properties, room types, rate plans, a
 * connected demo channel with mappings, and 90 nights of inventory and rates.
 *
 * Enough to click around and judge the product without waiting for a real
 * channel manager API.
 */
import { query, one, pool } from './db.js';
import { hashPassword } from './auth.js';
import { addDays, dateRange } from './services/inventory.js';

const today = new Date().toISOString().slice(0, 10);
const HORIZON = 90;

async function main() {
  console.log('Seeding demo data...');

  // Wipe in FK-safe order so re-seeding is repeatable.
  await query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of ['audit_log', 'sync_jobs', 'channel_sync_state', 'channel_mappings',
                   'reservations', 'rates', 'inventory', 'rate_plans', 'room_types',
                   'channels', 'user_properties', 'users', 'properties', 'orgs']) {
    await query(`TRUNCATE TABLE ${t}`);
  }
  await query('SET FOREIGN_KEY_CHECKS = 1');

  const org = await query(
    `INSERT INTO orgs (name, slug) VALUES ('Serendib Hotels Group', 'serendib')`
  );
  const orgId = org.insertId;

  const pwOwner = await hashPassword('demo1234');
  const owner = await query(
    `INSERT INTO users (org_id, email, password_hash, full_name, role)
     VALUES (?, 'owner@demo.com', ?, 'Group Owner', 'owner')`,
    [orgId, pwOwner]
  );

  const properties = [
    { code: 'CMB', name: 'Serendib Colombo', tz: 'Asia/Colombo', cur: 'LKR' },
    { code: 'GLL', name: 'Serendib Galle Fort', tz: 'Asia/Colombo', cur: 'LKR' },
  ];

  const propertyIds = [];
  for (const p of properties) {
    const r = await query(
      `INSERT INTO properties (org_id, name, code, timezone, currency)
       VALUES (?, ?, ?, ?, ?)`,
      [orgId, p.name, p.code, p.tz, p.cur]
    );
    propertyIds.push(Number(r.insertId));
  }

  // A manager scoped to the first property only - proves the permission model
  // does something rather than being decorative.
  const pwManager = await hashPassword('demo1234');
  const manager = await query(
    `INSERT INTO users (org_id, email, password_hash, full_name, role)
     VALUES (?, 'manager@demo.com', ?, 'Colombo Manager', 'manager')`,
    [orgId, pwManager]
  );
  await query(
    `INSERT INTO user_properties (user_id, property_id) VALUES (?, ?)`,
    [manager.insertId, propertyIds[0]]
  );

  const roomTypeSpec = [
    { code: 'DLX', name: 'Deluxe Double', rooms: 24, occ: 2, base: 28500 },
    { code: 'STD', name: 'Standard Twin', rooms: 30, occ: 2, base: 19500 },
    { code: 'SUI', name: 'Executive Suite', rooms: 8, occ: 4, base: 52000 },
  ];

  for (const propertyId of propertyIds) {
    const isColombo = propertyId === propertyIds[0];

    for (const [i, rt] of roomTypeSpec.entries()) {
      const rooms = isColombo ? rt.rooms : Math.round(rt.rooms * 0.6);
      const r = await query(
        `INSERT INTO room_types (org_id, property_id, code, name, total_rooms, max_occupancy, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [orgId, propertyId, rt.code, rt.name, rooms, rt.occ, i]
      );
      const roomTypeId = Number(r.insertId);

      const plans = [
        { code: `${rt.code}-BB`, name: `${rt.name} / Bed & Breakfast`, meal: 'BB', mult: 1.0 },
        { code: `${rt.code}-HB`, name: `${rt.name} / Half Board`, meal: 'HB', mult: 1.22 },
      ];

      const planIds = [];
      for (const plan of plans) {
        const rp = await query(
          `INSERT INTO rate_plans (org_id, property_id, room_type_id, code, name, meal_plan)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [orgId, propertyId, roomTypeId, plan.code, plan.name, plan.meal]
        );
        planIds.push({ id: Number(rp.insertId), mult: plan.mult });
      }

      // Inventory + rates for the horizon, written in bulk rather than a
      // query per night.
      const dates = dateRange(today, addDays(today, HORIZON - 1));

      const invVals = dates.map(() => '(?, ?, ?, ?, ?)').join(',');
      const invParams = [];
      for (const d of dates) {
        invParams.push(orgId, propertyId, roomTypeId, d, rooms);
      }
      await query(
        `INSERT INTO inventory (org_id, property_id, room_type_id, stay_date, allotment)
         VALUES ${invVals}`,
        invParams
      );

      for (const plan of planIds) {
        const rateVals = dates.map(() => '(?, ?, ?, ?, ?, ?)').join(',');
        const rateParams = [];
        for (const d of dates) {
          const dow = new Date(d + 'T00:00:00Z').getUTCDay();
          // Weekend uplift, so the calendar shows a realistic pattern rather
          // than one flat number down every column.
          const weekend = dow === 5 || dow === 6 ? 1.18 : 1.0;
          const base = isColombo ? rt.base : rt.base * 0.88;
          const amount = Math.round(base * plan.mult * weekend);
          rateParams.push(orgId, propertyId, plan.id, d, amount.toFixed(2), 'LKR');
        }
        await query(
          `INSERT INTO rates (org_id, property_id, rate_plan_id, stay_date, amount, currency)
           VALUES ${rateVals}`,
          rateParams
        );
      }
    }

    // A demo channel, connected and mapped, so sync can be watched working.
    const ch = await query(
      `INSERT INTO channels (org_id, property_id, adapter, name, credentials)
       VALUES (?, ?, 'mock', ?, ?)`,
      [orgId, propertyId,
       isColombo ? 'Booking.com (demo)' : 'Agoda (demo)',
       JSON.stringify({ hotelId: `H-${propertyId}`, apiKey: 'demo-key', failureRate: isColombo ? 0 : 15 })]
    );
    const channelId = Number(ch.insertId);

    const roomTypes = await query(
      `SELECT id, code FROM room_types WHERE property_id = ?`, [propertyId]
    );
    for (const rt of roomTypes) {
      await query(
        `INSERT INTO channel_mappings (org_id, channel_id, entity_type, entity_id, remote_id, remote_name)
         VALUES (?, ?, 'room_type', ?, ?, ?)`,
        [orgId, channelId, rt.id, rt.code, rt.code]
      );
    }

    const ratePlans = await query(
      `SELECT id, code FROM rate_plans WHERE property_id = ?`, [propertyId]
    );
    for (const rp of ratePlans) {
      // Deliberately only map the BB plans. The unmapped HB plans show what
      // the UI does when a configuration is incomplete.
      if (!rp.code.endsWith('-BB')) continue;
      await query(
        `INSERT INTO channel_mappings (org_id, channel_id, entity_type, entity_id, remote_id, remote_name)
         VALUES (?, ?, 'rate_plan', ?, ?, ?)`,
        [orgId, channelId, rp.id, rp.code, rp.code]
      );
    }
  }

  // Mark everything already in sync so the calendar starts clean.
  const channels = await query(`SELECT id, property_id FROM channels`);
  for (const ch of channels) {
    const roomTypes = await query(
      `SELECT id FROM room_types WHERE property_id = ?`, [ch.property_id]
    );
    const dates = dateRange(today, addDays(today, HORIZON - 1));
    for (const rt of roomTypes) {
      const vals = dates.map(() => '(?, ?, ?, ?)').join(',');
      const params = [];
      for (const d of dates) params.push(ch.id, rt.id, d, 'synced');
      await query(
        `INSERT INTO channel_sync_state (channel_id, room_type_id, stay_date, state)
         VALUES ${vals}`,
        params
      );
    }
  }

  const counts = {};
  for (const t of ['orgs', 'users', 'properties', 'room_types', 'rate_plans',
                   'inventory', 'rates', 'channels', 'channel_mappings']) {
    const r = await one(`SELECT COUNT(*) AS n FROM ${t}`);
    counts[t] = Number(r.n);
  }

  console.log('Seeded:', counts);
  console.log('\nSign in with:');
  console.log('  owner@demo.com   / demo1234   (whole group)');
  console.log('  manager@demo.com / demo1234   (Colombo only)');

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
