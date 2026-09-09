/**
 * Exercises the Aiosell adapter against a stand-in built from their docs.
 *
 * The point of these is the request COUNT as much as correctness: their limit
 * is 40 requests per minute for the whole partner account, so a 90-day push
 * that made one call per day would exhaust the budget on a single property.
 */
import assert from 'node:assert';
import { startFakeAiosell } from './fake-aiosell.js';
import { AiosellAdapter, compressRanges, normaliseReservation } from '../src/channels/aiosell.js';

const results = [];
function test(name, fn) { results.push({ name, fn }); }

function makeAdapter(fake, extra = {}) {
  return new AiosellAdapter({
    channel: { id: 1, name: 'Aiosell', adapter: 'aiosell' },
    credentials: {
      ...fake.credentials,
      partnerId: 'sample-pms',
      hotelCode: 'sandbox-pms',
      baseUrl: fake.baseUrl,
      ...extra,
    },
    log: () => {},
  });
}

function days(from, n) {
  const out = [];
  let cur = from;
  for (let i = 0; i < n; i++) {
    out.push(cur);
    const d = new Date(cur + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    cur = d.toISOString().slice(0, 10);
  }
  return out;
}

// ---------------------------------------------------------------------------

test('compressRanges collapses consecutive identical days into one range', () => {
  const items = days('2026-01-01', 10).map((date) => ({ date, roomCode: 'executive', available: 5 }));
  const ranges = compressRanges(items, (i) => `${i.roomCode}|${i.available}`);
  assert.strictEqual(ranges.length, 1);
  assert.strictEqual(ranges[0].startDate, '2026-01-01');
  assert.strictEqual(ranges[0].endDate, '2026-01-10');
});

test('compressRanges splits when a value changes mid-run', () => {
  const items = days('2026-01-01', 6).map((date, i) => ({
    date, roomCode: 'executive', available: i < 3 ? 5 : 2,
  }));
  const ranges = compressRanges(items, (i) => `${i.roomCode}|${i.available}`)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  assert.strictEqual(ranges.length, 2);
  assert.strictEqual(ranges[0].endDate, '2026-01-03');
  assert.strictEqual(ranges[1].startDate, '2026-01-04');
});

test('compressRanges splits on a gap in the dates', () => {
  const items = [
    { date: '2026-01-01', roomCode: 'a', available: 3 },
    { date: '2026-01-02', roomCode: 'a', available: 3 },
    { date: '2026-01-09', roomCode: 'a', available: 3 },
  ];
  const ranges = compressRanges(items, (i) => `${i.roomCode}|${i.available}`)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  assert.strictEqual(ranges.length, 2);
  assert.strictEqual(ranges[1].startDate, '2026-01-09');
});

test('90 days x 2 room types x 2 rate plans stays within a handful of requests', async () => {
  const fake = await startFakeAiosell();
  try {
    const adapter = makeAdapter(fake);
    const items = [];
    for (const date of days('2026-03-01', 90)) {
      for (const room of ['executive', 'suite']) {
        for (const plan of [`${room}-s-ep`, `${room}-d-cp`]) {
          items.push({
            date, remoteRoomTypeId: room, remoteRatePlanId: plan,
            available: 5, rate: 2500, stopSell: false,
            minStay: 1, maxStay: 0, closedArrival: false, closedDeparture: false,
          });
        }
      }
    }
    assert.strictEqual(items.length, 360);

    const before = fake.state.requests.length;
    const res = await adapter.pushAri({ items });
    const calls = fake.state.requests.length - before;

    // 360 rate-plan-days would be 360 calls unbatched, and 90 even if batched
    // per day. Range compression must get it to 2 - one availability, one rate.
    assert.ok(calls <= 3, `expected at most 3 requests, made ${calls}`);
    assert.strictEqual(res.rejected.length, 0);

    // And the data actually landed, expanded back out to every day.
    assert.strictEqual(fake.state.inventory.get('sandbox-pms|executive|2026-03-15'), 5);
    assert.strictEqual(fake.state.rates.get('sandbox-pms|suite|suite-d-cp|2026-05-29'), 2500);
    assert.strictEqual(fake.state.inventory.size, 180);   // 2 rooms x 90 days
  } finally {
    await fake.close();
  }
});

test('a mid-range price change produces separate blocks, not separate requests', async () => {
  const fake = await startFakeAiosell();
  try {
    const adapter = makeAdapter(fake);
    const items = days('2026-04-01', 30).map((date) => {
      const weekend = [5, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay());
      return {
        date, remoteRoomTypeId: 'executive', remoteRatePlanId: 'executive-d-cp',
        available: 4, rate: weekend ? 3600 : 2900, stopSell: false,
        minStay: 1, maxStay: 0, closedArrival: false, closedDeparture: false,
      };
    });

    const before = fake.state.requests.length;
    await adapter.pushAri({ items });
    const calls = fake.state.requests.length - before;

    assert.ok(calls <= 2, `expected 2 requests, made ${calls}`);
    assert.strictEqual(fake.state.rates.get('sandbox-pms|executive|executive-d-cp|2026-04-03'), 3600); // Friday
    assert.strictEqual(fake.state.rates.get('sandbox-pms|executive|executive-d-cp|2026-04-06'), 2900); // Monday
  } finally {
    await fake.close();
  }
});

test('restrictions without a channel list are reported, not silently dropped', async () => {
  const fake = await startFakeAiosell();
  try {
    const adapter = makeAdapter(fake);   // no `channels` credential
    const res = await adapter.pushAri({
      items: [{
        date: '2026-06-01', remoteRoomTypeId: 'executive', remoteRatePlanId: 'executive-d-cp',
        available: 0, rate: 2500, stopSell: true,
        minStay: 3, maxStay: 0, closedArrival: false, closedDeparture: false,
      }],
    });
    assert.ok(res.rejected.length > 0, 'expected the stop-sell to be reported as not sent');
    assert.match(res.rejected[0].reason, /channel list/i);
  } finally {
    await fake.close();
  }
});

test('restrictions are sent when channels are configured', async () => {
  const fake = await startFakeAiosell();
  try {
    const adapter = makeAdapter(fake, { channels: 'booking.com, agoda' });
    await adapter.pushAri({
      items: [{
        date: '2026-06-01', remoteRoomTypeId: 'executive', remoteRatePlanId: 'executive-d-cp',
        available: 0, rate: 2500, stopSell: true,
        minStay: 3, maxStay: 0, closedArrival: false, closedDeparture: false,
      }],
    });
    const stored = fake.state.restrictions.get('sandbox-pms|executive|2026-06-01');
    assert.ok(stored, 'restriction was not stored');
    assert.strictEqual(stored.stopSell, true);
    assert.strictEqual(stored.minimumStay, 3);

    const restrictionCall = fake.state.requests.find((r) => r.body?.toChannels);
    assert.deepStrictEqual(restrictionCall.body.toChannels, ['booking.com', 'agoda']);
  } finally {
    await fake.close();
  }
});

test('a zero rate on an open date is rejected per-date, not as a whole batch', async () => {
  const fake = await startFakeAiosell();
  try {
    const adapter = makeAdapter(fake);
    const res = await adapter.pushAri({
      items: [
        { date: '2026-07-01', remoteRoomTypeId: 'executive', remoteRatePlanId: 'executive-d-cp',
          available: 3, rate: 0, stopSell: false, minStay: 1, maxStay: 0,
          closedArrival: false, closedDeparture: false },
        { date: '2026-07-02', remoteRoomTypeId: 'executive', remoteRatePlanId: 'executive-d-cp',
          available: 3, rate: 2500, stopSell: false, minStay: 1, maxStay: 0,
          closedArrival: false, closedDeparture: false },
      ],
    });
    assert.strictEqual(res.rejected.length, 1);
    assert.strictEqual(res.rejected[0].date, '2026-07-01');
    // The good date still went through.
    assert.strictEqual(fake.state.rates.get('sandbox-pms|executive|executive-d-cp|2026-07-02'), 2500);
  } finally {
    await fake.close();
  }
});

test('property details map to room types and per-occupancy rate plans', async () => {
  const fake = await startFakeAiosell();
  try {
    const adapter = makeAdapter(fake);
    const remote = await adapter.fetchRemoteInventory();
    assert.strictEqual(remote.roomTypes.length, 2);
    assert.strictEqual(remote.roomTypes[0].id, 'executive');
    assert.strictEqual(remote.roomTypes[0].totalRooms, 25);
    assert.strictEqual(remote.ratePlans.length, 5);
    const single = remote.ratePlans.find((p) => p.id === 'executive-s-ep');
    assert.strictEqual(single.occupancy, 1);
    assert.strictEqual(single.roomTypeId, 'executive');
    assert.strictEqual(remote.property.currency, 'INR');
  } finally {
    await fake.close();
  }
});

test('bad credentials fail without being retried', async () => {
  const fake = await startFakeAiosell();
  try {
    const adapter = makeAdapter(fake, { password: 'wrong' });
    await assert.rejects(
      () => adapter.testConnection(),
      (err) => { assert.strictEqual(err.retryable, false); return true; }
    );
  } finally {
    await fake.close();
  }
});

test('a 429 is marked retryable so the queue backs off instead of giving up', async () => {
  const fake = await startFakeAiosell();
  try {
    const adapter = makeAdapter(fake);
    fake.state.windowCount = 41;      // force the next call over the limit
    await assert.rejects(
      () => adapter.testConnection(),
      (err) => {
        assert.strictEqual(err.retryable, true);
        assert.match(err.message, /rate limit/i);
        return true;
      }
    );
  } finally {
    await fake.close();
  }
});

// --- reservation payload handling ------------------------------------------

test('a booking with two different room types is not flattened into one room', () => {
  const r = normaliseReservation({
    action: 'book', hotelCode: 'sandbox-pms', channel: 'Goibibo', bookingId: '111222333',
    checkin: '2026-12-10', checkout: '2026-12-12', segment: 'OTA', pah: false,
    amount: { amountAfterTax: 4000, amountBeforeTax: 3600, tax: 400, currency: 'INR', commission: 500 },
    guest: { firstName: 'A', lastName: 'Kumar' },
    rooms: [
      { roomCode: 'executive', rateplanCode: 'executive-s-ep', occupancy: { adults: 1, children: 0 },
        prices: [{ date: '2026-12-10', sellRate: 900 }, { date: '2026-12-11', sellRate: 900 }] },
      { roomCode: 'suite', rateplanCode: 'suite-d-cp', occupancy: { adults: 2, children: 1 },
        prices: [{ date: '2026-12-10', sellRate: 1100 }, { date: '2026-12-11', sellRate: 1100 }] },
    ],
  });
  assert.strictEqual(r.rooms.length, 2);
  assert.strictEqual(r.roomCount, 2);
  assert.strictEqual(r.rooms[0].remoteRoomTypeId, 'executive');
  assert.strictEqual(r.rooms[1].remoteRoomTypeId, 'suite');
  assert.strictEqual(r.rooms[1].children, 1);
  assert.strictEqual(r.rooms[0].nightlyPrices.length, 2);
  assert.strictEqual(r.commission, 500);
});

test('two rooms of the SAME type count as two rooms', () => {
  const r = normaliseReservation({
    action: 'book', bookingId: 'X1', channel: 'Agoda',
    checkin: '2026-12-10', checkout: '2026-12-11',
    amount: { amountAfterTax: 100, currency: 'INR' },
    rooms: [
      { roomCode: 'executive', rateplanCode: 'executive-d-ep', occupancy: { adults: 2, children: 0 }, prices: [] },
      { roomCode: 'executive', rateplanCode: 'executive-d-ep', occupancy: { adults: 2, children: 0 }, prices: [] },
    ],
  });
  assert.strictEqual(r.roomCount, 2);
});

test('a booking with every guest field masked is still accepted', () => {
  const r = normaliseReservation({
    action: 'book', bookingId: 'M1', channel: 'Booking.com',
    checkin: '2026-12-10', checkout: '2026-12-11',
    amount: { amountAfterTax: 1000, currency: 'INR', commission: null, tcs: null, tds: null },
    guest: { firstName: null, lastName: null, email: null, phone: null },
    rooms: [{ roomCode: 'executive', rateplanCode: 'executive-d-ep', occupancy: { adults: 2, children: 0 }, prices: [] }],
  });
  assert.strictEqual(r.guestName, null);
  assert.strictEqual(r.guestEmail, null);
  assert.strictEqual(r.commission, null);
  assert.strictEqual(r.status, 'confirmed');
});

test('a guest object that is missing entirely does not throw', () => {
  const r = normaliseReservation({
    action: 'book', bookingId: 'M2', channel: 'Expedia',
    checkin: '2026-12-10', checkout: '2026-12-11',
    amount: { amountAfterTax: 1000, currency: 'INR' },
    rooms: [],
  });
  assert.strictEqual(r.guestName, null);
  assert.deepStrictEqual(r.rooms, []);
});

test('cancel carries no dates or rooms, so it is flagged for lookup', () => {
  const r = normaliseReservation({
    action: 'cancel', hotelCode: 'sandbox-pms', channel: 'Goibibo', bookingId: '111222333',
  });
  assert.strictEqual(r.status, 'cancelled');
  assert.strictEqual(r.isCancellation, true);
  assert.strictEqual(r.remoteRef, '111222333');
  assert.deepStrictEqual(r.rooms, []);
  assert.strictEqual(r.checkIn, undefined);
});

test('modify is a full replacement of the booking state', () => {
  const r = normaliseReservation({
    action: 'modify', bookingId: '111222333', channel: 'Goibibo',
    checkin: '2026-12-11', checkout: '2026-12-14',
    amount: { amountAfterTax: 5000, currency: 'INR' },
    rooms: [{ roomCode: 'suite', rateplanCode: 'suite-d-cp', occupancy: { adults: 2, children: 0 }, prices: [] }],
  });
  assert.strictEqual(r.action, 'modify');
  assert.strictEqual(r.status, 'confirmed');
  assert.strictEqual(r.checkIn, '2026-12-11');
  assert.strictEqual(r.rooms[0].remoteRoomTypeId, 'suite');
});

test('pay-at-hotel is carried through', () => {
  const paid = normaliseReservation({
    action: 'book', bookingId: 'P1', channel: 'MakeMyTrip', checkin: '2026-01-01',
    checkout: '2026-01-02', pah: false, amount: { amountAfterTax: 1, currency: 'INR' }, rooms: [],
  });
  const collect = normaliseReservation({
    action: 'book', bookingId: 'P2', channel: 'MakeMyTrip', checkin: '2026-01-01',
    checkout: '2026-01-02', pah: true, amount: { amountAfterTax: 1, currency: 'INR' }, rooms: [],
  });
  assert.strictEqual(paid.payAtHotel, false);
  assert.strictEqual(collect.payAtHotel, true);
});

// ---------------------------------------------------------------------------

let passed = 0, failed = 0;
for (const t of results) {
  try {
    await t.fn();
    console.log(`  ok    ${t.name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${t.name}`);
    console.log(`        ${err.message}`);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
