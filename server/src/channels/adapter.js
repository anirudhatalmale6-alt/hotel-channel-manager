/**
 * Channel adapter contract.
 *
 * Everything the platform knows about talking to the outside world lives
 * behind this interface. Adding a real channel manager (SiteMinder, STAAH,
 * eZee, Cloudbeds, ...) means writing ONE file that implements these methods
 * and registering it in registry.js. No other part of the system changes.
 *
 * The three questions that differ between providers, and where each is
 * answered:
 *
 *   1. Push or poll for reservations?
 *        - push  -> the provider calls our webhook; implement parseWebhook()
 *        - poll  -> implement fetchReservations(); the scheduler calls it
 *      Declare which via `capabilities.reservations`.
 *
 *   2. Can we send one date, or must we resend a whole range?
 *      Declare `capabilities.deltaUpdates`. When false the sync engine widens
 *      every job to the full range before calling pushAri().
 *
 *   3. Are rates per room, or per occupancy?
 *      Read from the rate plan's pricing_mode; the adapter shapes the payload.
 */

export class ChannelAdapter {
  /**
   * @param {object} ctx
   * @param {object} ctx.channel     row from `channels`
   * @param {object} ctx.credentials decrypted credentials object
   * @param {function} ctx.log       (level, message, detail) => void
   */
  constructor(ctx) {
    this.channel = ctx.channel;
    this.credentials = ctx.credentials || {};
    this.log = ctx.log || (() => {});
  }

  /** Human readable name shown in the UI. */
  static get displayName() {
    return 'Unnamed channel';
  }

  /**
   * What this provider can and cannot do. The sync engine reads these rather
   * than special-casing provider names.
   */
  static get capabilities() {
    return {
      // 'push' (webhook) or 'poll'
      reservations: 'poll',
      // false => provider only accepts a full date range, not single days
      deltaUpdates: true,
      // false => rates and availability must be sent in the same call
      separateRateAndAvailability: true,
      // how many stay-dates one request may carry
      maxDatesPerRequest: 60,
    };
  }

  /**
   * Credentials the UI should ask for when connecting this channel.
   * Rendered automatically on the Channels screen.
   */
  static get credentialFields() {
    return [];
  }

  /** Cheap call used by the "Test connection" button. */
  async testConnection() {
    throw new Error('testConnection() not implemented');
  }

  /**
   * Fetch the remote room types / rate plans so the user can map ours to
   * theirs. Returns { roomTypes: [{id, name}], ratePlans: [{id, name, roomTypeId}] }.
   */
  async fetchRemoteInventory() {
    throw new Error('fetchRemoteInventory() not implemented');
  }

  /**
   * Send availability and rates.
   *
   * @param {object} batch
   * @param {string} batch.propertyRemoteId
   * @param {Array}  batch.items  [{ remoteRoomTypeId, remoteRatePlanId, date,
   *                                 available, stopSell, minStay, maxStay,
   *                                 closedArrival, closedDeparture,
   *                                 rate, currency }]
   * @returns {Promise<{accepted: number, rejected: Array<{date, reason}>}>}
   */
  async pushAri(batch) {
    throw new Error('pushAri() not implemented');
  }

  /**
   * Poll-style providers only. Return reservations changed since `since`.
   * @returns {Promise<Array<NormalisedReservation>>}
   */
  async fetchReservations(since) {
    throw new Error('fetchReservations() not implemented');
  }

  /**
   * Push-style providers only. Turn a raw webhook body into the same
   * NormalisedReservation shape fetchReservations() returns.
   */
  async parseWebhook(body, headers) {
    throw new Error('parseWebhook() not implemented');
  }
}

/**
 * NormalisedReservation - the single shape the platform stores, whatever the
 * provider sent us.
 *
 * {
 *   remoteRef:        string    provider's booking reference (idempotency key)
 *   remoteRoomTypeId: string
 *   remoteRatePlanId: string|null
 *   status:           'confirmed' | 'cancelled' | 'no_show'
 *   guestName, guestEmail, guestPhone: string
 *   checkIn, checkOut: 'YYYY-MM-DD'
 *   rooms, adults, children: number
 *   totalAmount: number
 *   currency: string
 * }
 */
