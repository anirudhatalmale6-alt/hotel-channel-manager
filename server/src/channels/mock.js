import { ChannelAdapter } from './adapter.js';

/**
 * A stand-in channel used to build and test the sync engine before the real
 * API documentation arrives.
 *
 * It behaves like a real channel in the ways that matter: it is slow, it
 * sometimes fails, and it rejects dates it does not like. That is deliberate -
 * a sync engine only tested against a perfect channel falls over on the first
 * timeout in production.
 *
 * Deterministic: the same date always produces the same outcome, so a failing
 * case can be reproduced rather than waited for.
 */
export class MockChannelAdapter extends ChannelAdapter {
  static get displayName() {
    return 'Demo channel (test connection)';
  }

  static get capabilities() {
    return {
      reservations: 'poll',
      deltaUpdates: true,
      separateRateAndAvailability: false,
      maxDatesPerRequest: 60,
    };
  }

  static get credentialFields() {
    return [
      { key: 'hotelId', label: 'Hotel ID', type: 'text', required: true },
      { key: 'apiKey', label: 'API key', type: 'password', required: true },
      {
        key: 'failureRate',
        label: 'Simulated failure rate (0-100%)',
        type: 'number',
        required: false,
        help: 'Demo only. Lets you see how the queue retries.',
      },
    ];
  }

  async testConnection() {
    await this.#latency();
    if (!this.credentials.hotelId || !this.credentials.apiKey) {
      throw new Error('Hotel ID and API key are both required');
    }
    return { ok: true, message: `Connected to demo hotel ${this.credentials.hotelId}` };
  }

  async fetchRemoteInventory() {
    await this.#latency();
    return {
      roomTypes: [
        { id: 'DLX', name: 'Deluxe Double' },
        { id: 'STD', name: 'Standard Twin' },
        { id: 'SUI', name: 'Executive Suite' },
      ],
      ratePlans: [
        { id: 'DLX-BB', name: 'Deluxe / Bed & Breakfast', roomTypeId: 'DLX' },
        { id: 'STD-BB', name: 'Standard / Bed & Breakfast', roomTypeId: 'STD' },
        { id: 'SUI-HB', name: 'Suite / Half Board', roomTypeId: 'SUI' },
      ],
    };
  }

  async pushAri(batch) {
    await this.#latency();

    const failureRate = Number(this.credentials.failureRate || 0);

    // Whole-request failure: this is what a timeout or a 500 looks like. The
    // job goes back on the queue with backoff rather than being lost.
    if (failureRate > 0 && this.#hash(JSON.stringify(batch.items.map(i => i.date))) % 100 < failureRate) {
      throw new Error('Demo channel: upstream returned 503 Service Unavailable');
    }

    const rejected = [];
    for (const item of batch.items) {
      // Real channels reject individual dates for their own reasons. The
      // engine must record a per-date failure without failing the batch.
      if (item.rate !== null && Number(item.rate) <= 0 && !item.stopSell) {
        rejected.push({ date: item.date, reason: 'Rate must be greater than zero unless the date is stopped' });
      }
    }

    this.log('info', `Demo channel accepted ${batch.items.length - rejected.length} of ${batch.items.length} dates`);
    return { accepted: batch.items.length - rejected.length, rejected };
  }

  async fetchReservations() {
    await this.#latency();
    // Bookings are injected by the demo endpoint rather than invented here,
    // so the demo stays predictable.
    return [];
  }

  #latency() {
    const ms = 60 + (this.#hash(this.channel.id + ':' + Date.now()) % 90);
    return new Promise((r) => setTimeout(r, ms));
  }

  #hash(str) {
    let h = 2166136261;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }
}
