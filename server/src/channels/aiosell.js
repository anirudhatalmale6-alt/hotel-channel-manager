import { ChannelAdapter } from './adapter.js';

/**
 * Aiosell Channel Manager adapter.
 *
 * Docs: https://apidocs.aiosell.com   Base: https://live.aiosell.com/api/v2/cm
 *
 * We are the PMS in Aiosell's model: we PUSH inventory, rates and restrictions
 * to them, and they POST reservations to a webhook we expose.
 *
 * Two constraints from their spec shape almost everything here:
 *
 *  1. RATE LIMIT: 40 requests per minute per partner - and that is per
 *     partner, not per hotel. Every property in the whole platform shares one
 *     budget. So requests are (a) compressed into date RANGES rather than one
 *     per day, and (b) put through a token bucket before they are sent.
 *
 *  2. Their update APIs take {startDate, endDate} blocks, so a month of
 *     unchanged availability is ONE block, not thirty. compressRanges() below
 *     is what turns a 90-day push for 6 room types from 540 requests into
 *     typically one or two.
 */

const BASE_URL = 'https://live.aiosell.com/api/v2/cm';

/**
 * Token bucket shared by every Aiosell channel in this process.
 *
 * Deliberately module-level: the limit is per PARTNER, so two properties
 * syncing at once must draw from the same budget or we get 429s.
 *
 * Note for multi-server deployments: this must move to Redis or a database
 * row, otherwise each app server gets its own 40/min and the limit is
 * breached. Flagged in the README.
 */
const rateLimiter = {
  capacity: 40,
  tokens: 40,
  refillPerMs: 40 / 60000,
  last: 0,

  async take(nowMs) {
    const now = nowMs;
    if (this.last === 0) this.last = now;

    this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.refillPerMs);
    this.last = now;

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    // How long until one token is available.
    const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
    await new Promise((r) => setTimeout(r, waitMs));
    this.tokens = 0;
    this.last = Date.now();
    return waitMs;
  },
};

/**
 * Collapse per-date items into {startDate, endDate} blocks.
 *
 * Items are grouped by a caller-supplied signature (everything except the
 * date). Consecutive dates sharing a signature become one range. This is the
 * single most important optimisation against a 40 req/min ceiling.
 */
export function compressRanges(items, signatureOf) {
  const groups = new Map();
  for (const item of items) {
    const sig = signatureOf(item);
    if (!groups.has(sig)) groups.set(sig, { sig, item, dates: [] });
    groups.get(sig).dates.push(item.date);
  }

  const ranges = [];
  for (const group of groups.values()) {
    group.dates.sort();
    let start = group.dates[0];
    let prev = group.dates[0];

    for (let i = 1; i < group.dates.length; i++) {
      const d = group.dates[i];
      if (d === prev) continue;                  // duplicate date
      if (d === nextDay(prev)) { prev = d; continue; }
      ranges.push({ startDate: start, endDate: prev, item: group.item });
      start = d;
      prev = d;
    }
    ranges.push({ startDate: start, endDate: prev, item: group.item });
  }
  return ranges;
}

function nextDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Group ranges that share identical start/end into one update block. */
function groupByWindow(ranges, buildEntry, entryKey) {
  const windows = new Map();
  for (const r of ranges) {
    const key = `${r.startDate}|${r.endDate}`;
    if (!windows.has(key)) {
      windows.set(key, { startDate: r.startDate, endDate: r.endDate, entries: [] });
    }
    windows.get(key).entries.push(buildEntry(r.item));
  }
  return [...windows.values()].map((w) => ({
    startDate: w.startDate,
    endDate: w.endDate,
    [entryKey]: w.entries,
  }));
}

export class AiosellAdapter extends ChannelAdapter {
  static get displayName() {
    return 'Aiosell Channel Manager';
  }

  static get capabilities() {
    return {
      // Aiosell POSTs book/modify/cancel to an endpoint we expose. There is
      // also a Fetch Reservations API, which we use for reconciliation
      // rather than as the primary path.
      reservations: 'push',
      reservationsPollFallback: true,

      // Their API takes date ranges, so partial updates are fine - we never
      // need to resend a whole window.
      deltaUpdates: true,

      // Availability and rates are separate endpoints.
      separateRateAndAvailability: true,

      // Not a real limit for Aiosell: ranges mean one request can carry a
      // year. Kept high so the engine does not slice unnecessarily; the token
      // bucket is what actually protects us.
      maxDatesPerRequest: 3650,

      // 40 requests/minute per PARTNER, shared across all properties.
      requestsPerMinute: 40,

      // Restrictions are addressed to named channels; rates and availability
      // are not - they go to every connected OTA.
      perChannelRestrictions: true,
    };
  }

  static get credentialFields() {
    return [
      { key: 'username', label: 'Aiosell username', type: 'text', required: true,
        help: 'Basic Auth username issued at partner onboarding' },
      { key: 'password', label: 'Aiosell password', type: 'password', required: true },
      { key: 'partnerId', label: 'Partner id ({pms})', type: 'text', required: true,
        help: 'Your software\'s id, e.g. sample-pms. Goes in the URL path.' },
      { key: 'hotelCode', label: 'Hotel code', type: 'text', required: true,
        help: 'Identifies THIS property, e.g. sandbox-pms. Different from the partner id.' },
      { key: 'baseUrl', label: 'Base URL', type: 'text', required: false,
        help: `Defaults to ${BASE_URL}. Override to point at a sandbox.` },
    ];
  }

  get baseUrl() {
    return (this.credentials.baseUrl || BASE_URL).replace(/\/+$/, '');
  }

  get authHeader() {
    const raw = `${this.credentials.username || ''}:${this.credentials.password || ''}`;
    return 'Basic ' + Buffer.from(raw, 'utf8').toString('base64');
  }

  async #request(method, path, body) {
    const waited = await rateLimiter.take(Date.now());
    if (waited > 0) this.log('info', `rate limit: waited ${waited}ms before calling Aiosell`);

    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    // 429 is transient - let the queue retry with its backoff rather than
    // failing the job outright.
    if (res.status === 429) {
      const err = new Error('Aiosell rate limit hit (429). The job will retry.');
      err.retryable = true;
      throw err;
    }
    if (res.status >= 500) {
      const err = new Error(`Aiosell returned ${res.status}. The job will retry.`);
      err.retryable = true;
      throw err;
    }
    if (!res.ok) {
      // 4xx is our fault - wrong codes, bad payload. Retrying will not help.
      const err = new Error(
        `Aiosell rejected the request (${res.status}): ${data?.message || text.slice(0, 300)}`
      );
      err.retryable = false;
      throw err;
    }

    // They return 200 with success:false for business-level rejections.
    if (data && data.success === false) {
      const err = new Error(`Aiosell: ${data.message || 'request was not accepted'}`);
      err.retryable = false;
      throw err;
    }

    return data;
  }

  async testConnection() {
    const missing = ['username', 'password', 'partnerId', 'hotelCode']
      .filter((k) => !this.credentials[k]);
    if (missing.length) {
      throw new Error(`Missing credentials: ${missing.join(', ')}`);
    }

    const details = await this.#request(
      'GET',
      `/property_details/${encodeURIComponent(this.credentials.hotelCode)}` +
      `?partnerId=${encodeURIComponent(this.credentials.partnerId)}`
    );

    const rooms = Array.isArray(details?.rooms) ? details.rooms.length : 0;
    return {
      ok: true,
      message: `Connected to Aiosell. ${rooms} room type${rooms === 1 ? '' : 's'}, ` +
               `currency ${details?.currency || 'unknown'}, timezone ${details?.timezone || 'unknown'}.`,
      details,
    };
  }

  /**
   * Pull Aiosell's room and rate plan codes so they can be mapped to ours.
   *
   * Their rate plan ids encode room, occupancy and meal plan
   * ({room}-{occupancy}-{mealplan}, e.g. executive-s-ep), so one room type
   * typically has 4-8 plans. The extra fields are surfaced because the
   * mapping screen needs them to make sense of a long list.
   */
  async fetchRemoteInventory() {
    const details = await this.#request(
      'GET',
      `/property_details/${encodeURIComponent(this.credentials.hotelCode)}` +
      `?partnerId=${encodeURIComponent(this.credentials.partnerId)}`
    );

    const roomTypes = [];
    const ratePlans = [];

    for (const room of details?.rooms || []) {
      roomTypes.push({
        id: room.room_id,
        name: room.room_name || room.room_id,
        totalRooms: room.count ?? null,
        minOccupancy: room.min_occ ?? null,
        maxOccupancy: room.max_occ ?? null,
        active: room.active !== false,
      });

      for (const rp of room.rateplans || []) {
        ratePlans.push({
          id: rp.rateplan_id,
          name: rp.rateplan_name || rp.rateplan_id,
          roomTypeId: room.room_id,
          occupancy: rp.occupancy ?? null,
          mealsIncluded: rp.no_of_meals ?? null,
          extraAdult: rp.extra_adult ?? null,
        });
      }
    }

    return {
      roomTypes,
      ratePlans,
      property: {
        currency: details?.currency || null,
        timezone: details?.timezone || null,
        address: details?.address || null,
      },
    };
  }

  /**
   * Push availability, rates and restrictions.
   *
   * Up to four requests regardless of how many dates are involved, because
   * everything is compressed into ranges first.
   */
  async pushAri(batch) {
    const items = batch.items || [];
    if (!items.length) return { accepted: 0, rejected: [] };

    const hotelCode = this.credentials.hotelCode;
    const pms = encodeURIComponent(this.credentials.partnerId);
    const rejected = [];

    // ---- availability -------------------------------------------------
    // One entry per (roomCode, date); several rate plans on the same room
    // and date carry the same availability, so de-duplicate first.
    const seenAvail = new Set();
    const availItems = [];
    for (const it of items) {
      if (!it.remoteRoomTypeId) continue;
      const key = `${it.remoteRoomTypeId}|${it.date}`;
      if (seenAvail.has(key)) continue;
      seenAvail.add(key);
      availItems.push({
        date: it.date,
        roomCode: it.remoteRoomTypeId,
        available: Math.max(0, Number(it.available) || 0),
      });
    }

    if (availItems.length) {
      const ranges = compressRanges(availItems, (i) => `${i.roomCode}|${i.available}`);
      const updates = groupByWindow(
        ranges,
        (i) => ({ roomCode: i.roomCode, available: i.available }),
        'rooms'
      );
      this.log('info',
        `availability: ${availItems.length} room-days compressed into ${updates.length} block(s)`);
      await this.#request('POST', `/update/${pms}`, { hotelCode, updates });
    }

    // ---- rates --------------------------------------------------------
    const rateItems = items
      .filter((it) => it.remoteRatePlanId && it.rate !== null && it.rate !== undefined)
      .map((it) => ({
        date: it.date,
        roomCode: it.remoteRoomTypeId,
        rateplanCode: it.remoteRatePlanId,
        rate: Number(it.rate),
      }));

    // Aiosell rejects a zero rate on a date that is still open for sale, so
    // catch it here and report it against the date instead of letting the
    // whole request fail.
    const validRates = [];
    for (const r of rateItems) {
      const stopped = items.find(
        (it) => it.date === r.date && it.remoteRatePlanId === r.rateplanCode
      )?.stopSell;
      if (r.rate <= 0 && !stopped) {
        rejected.push({ date: r.date, reason: 'Rate is zero while the date is still open for sale' });
        continue;
      }
      validRates.push(r);
    }

    if (validRates.length) {
      const ranges = compressRanges(
        validRates,
        (i) => `${i.roomCode}|${i.rateplanCode}|${i.rate}`
      );
      const updates = groupByWindow(
        ranges,
        (i) => ({ roomCode: i.roomCode, rateplanCode: i.rateplanCode, rate: i.rate }),
        'rates'
      );
      this.log('info',
        `rates: ${validRates.length} plan-days compressed into ${updates.length} block(s)`);
      await this.#request('POST', `/update-rates/${pms}`, { hotelCode, updates });
    }

    // ---- restrictions -------------------------------------------------
    // toChannels is REQUIRED and cannot be empty, so restrictions can only be
    // sent once we know which OTAs the property is connected to.
    const toChannels = Array.isArray(this.credentials.channels)
      ? this.credentials.channels
      : (this.credentials.channels
          ? String(this.credentials.channels).split(',').map((s) => s.trim()).filter(Boolean)
          : []);

    const restrictionItems = availItems.map((a) => {
      const src = items.find((it) => it.remoteRoomTypeId === a.roomCode && it.date === a.date) || {};
      return {
        date: a.date,
        roomCode: a.roomCode,
        stopSell: !!src.stopSell,
        minimumStay: Number(src.minStay) || 1,
        maximumStay: src.maxStay ? Number(src.maxStay) : null,
        closeOnArrival: !!src.closedArrival,
        closeOnDeparture: !!src.closedDeparture,
      };
    });

    const hasRestrictions = restrictionItems.some(
      (r) => r.stopSell || r.minimumStay > 1 || r.maximumStay || r.closeOnArrival || r.closeOnDeparture
    );

    if (hasRestrictions && toChannels.length === 0) {
      this.log('warn',
        'Restrictions are set but no channels are configured. Aiosell requires a non-empty ' +
        'toChannels list, so stop-sell and minimum-stay were NOT sent.');
      for (const r of restrictionItems.filter((x) => x.stopSell || x.minimumStay > 1)) {
        rejected.push({
          date: r.date,
          reason: 'Restrictions need a channel list - set one on the channel settings',
        });
      }
    } else if (hasRestrictions) {
      const ranges = compressRanges(restrictionItems, (i) =>
        [i.roomCode, i.stopSell, i.minimumStay, i.maximumStay, i.closeOnArrival, i.closeOnDeparture].join('|')
      );
      const updates = groupByWindow(
        ranges,
        (i) => ({
          roomCode: i.roomCode,
          restrictions: {
            stopSell: i.stopSell,
            minimumStay: i.minimumStay,
            maximumStay: i.maximumStay,
            closeOnArrival: i.closeOnArrival,
            closeOnDeparture: i.closeOnDeparture,
          },
        }),
        'rooms'
      );
      this.log('info', `restrictions: ${updates.length} block(s) to ${toChannels.join(', ')}`);
      await this.#request('POST', `/update/${pms}`, { hotelCode, toChannels, updates });
    }

    const rejectedDates = new Set(rejected.map((r) => r.date));
    const accepted = new Set(items.map((i) => i.date).filter((d) => !rejectedDates.has(d))).size;

    return { accepted, rejected };
  }

  /**
   * Reconciliation path. The webhook is the primary route; this exists to
   * catch anything a failed webhook delivery lost.
   */
  async fetchReservations(since, until) {
    const startDate = since || new Date().toISOString().slice(0, 10);
    const endDate = until || startDate;

    const data = await this.#request('POST', `/data/${encodeURIComponent(this.credentials.partnerId)}`, {
      type: 'reservation',
      hotelCode: this.credentials.hotelCode,
      startDate,
      endDate,
    });

    const list = Array.isArray(data) ? data : (data?.reservations || []);
    return list.map((r) => normaliseReservation(r));
  }

  async parseWebhook(body) {
    return normaliseReservation(body);
  }
}

/**
 * Turn an Aiosell reservation payload into the platform's shape.
 *
 * Points that matter:
 *  - `rooms` is an ARRAY and each entry may be a different room type, so a
 *    booking is not one room. Two entries with the same roomCode means two
 *    rooms of that type.
 *  - Every guest.* field is optional. OTAs mask them. Nothing here may
 *    require them or reject a booking for their absence.
 *  - A cancel payload carries ONLY action, hotelCode, channel and bookingId -
 *    no dates and no rooms. The nights to release have to come from what we
 *    stored when the booking arrived.
 */
export function normaliseReservation(payload) {
  const action = String(payload.action || 'book').toLowerCase();

  const base = {
    action,
    remoteRef: String(payload.bookingId),
    cmBookingId: payload.cmBookingId || null,
    hotelCode: payload.hotelCode || null,
    channelName: payload.channel || null,
    status: action === 'cancel' ? 'cancelled' : 'confirmed',
  };

  // Cancel is intentionally minimal - the caller looks the booking up by
  // remoteRef and releases what it already knows about.
  if (action === 'cancel') {
    return { ...base, isCancellation: true, rooms: [] };
  }

  const guest = payload.guest || {};
  const address = guest.address || {};
  const amount = payload.amount || {};

  const rooms = (payload.rooms || []).map((room) => ({
    remoteRoomTypeId: room.roomCode,
    remoteRatePlanId: room.rateplanCode || null,
    guestName: room.guestName || null,
    adults: room.occupancy?.adults ?? 0,
    children: room.occupancy?.children ?? 0,
    nightlyPrices: (room.prices || []).map((p) => ({
      date: p.date,
      sellRate: Number(p.sellRate) || 0,
    })),
  }));

  const guestName = [guest.firstName, guest.lastName].filter(Boolean).join(' ').trim();

  return {
    ...base,
    bookedOn: payload.bookedOn || null,
    checkIn: payload.checkin,
    checkOut: payload.checkout,
    segment: payload.segment || null,
    specialRequests: payload.specialRequests || null,
    payAtHotel: payload.pah === true,

    guestName: guestName || null,
    guestEmail: guest.email || null,
    guestPhone: guest.phone || null,
    guestAddress: {
      line1: address.line1 || null,
      city: address.city || null,
      state: address.state || null,
      country: address.country || null,
      zipCode: address.zipCode || null,
    },

    totalAmount: Number(amount.amountAfterTax) || 0,
    amountBeforeTax: Number(amount.amountBeforeTax) || 0,
    tax: Number(amount.tax) || 0,
    commission: amount.commission === null || amount.commission === undefined
      ? null : Number(amount.commission),
    tcs: amount.tcs === null || amount.tcs === undefined ? null : Number(amount.tcs),
    tds: amount.tds === null || amount.tds === undefined ? null : Number(amount.tds),
    currency: amount.currency || 'INR',

    rooms,
    // Convenience: total rooms is the length of the array, not a field.
    roomCount: rooms.length,
  };
}
