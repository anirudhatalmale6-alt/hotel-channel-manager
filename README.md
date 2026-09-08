# Channel Manager — hotel distribution platform

Multi-tenant SaaS for hotel groups: one place to manage rates, availability and
bookings across every connected channel, so the same room is never sold twice.

This is **phase 1**: the multi-tenant foundation, the rates & availability
calendar, and the sync engine. The channel API itself plugs in behind an
adapter interface — see [Connecting a real channel](#connecting-a-real-channel).

---

## Running it

Requires Node 18+ and MySQL 5.7+ / MariaDB 10.3+.

```bash
# 1. server
cd server
cp .env.example .env          # fill in your database details
npm install
npm run migrate               # creates the database and 14 tables
npm run seed                  # demo hotel group, 2 properties, 90 nights of data

# 2. frontend
cd ../web
npm install
npm run build

# 3. start
cd ../server
npm start                     # serves the API and the UI on one port
```

Open http://localhost:4000

| Account | Password | Sees |
|---|---|---|
| `owner@demo.com` | `demo1234` | the whole group |
| `manager@demo.com` | `demo1234` | Colombo only |

In production run the worker as its own process so a slow channel can never
make the UI unresponsive:

```bash
INLINE_WORKER=0 npm start     # API only
npm run worker                # one or more of these
```

---

## How it is put together

```
server/
  db/schema.sql             14 tables, tenant id on every business table
  src/
    auth.js                 JWT, roles, the property-access chokepoint
    routes.js               HTTP layer only — no business logic
    services/
      inventory.js          the calendar + the overbooking guard
      sync.js               the queue, batching, retries, per-cell state
      reservations.js       ingesting bookings idempotently
    channels/
      adapter.js            the contract every channel implements
      mock.js               a deliberately imperfect test channel
      registry.js           the one place a channel is named
    worker/                 claims jobs and runs them
web/
  src/Calendar.jsx          the rates & availability grid
  src/App.jsx               shell, overview, reservations, channels
```

### Multi-tenancy

`org_id` is on every business table and every query filters on it. This is in
from the first table rather than added later — retrofitting tenant isolation
into a live SaaS is the most expensive mistake this kind of product can make.

`assertProperty()` in `auth.js` is the single chokepoint. Every route that
takes a property id calls it. It checks the property belongs to the caller's
org *and* that this user may see it, and returns **404 rather than 403** for
both failures, so the API cannot be used to discover which properties exist in
other accounts.

Verified: a manager scoped to one property gets 404 on both reads and writes
to a property in the same org that they are not assigned to.

### The overbooking guard

Two rules, enforced in the database transaction rather than the browser,
because bookings arrive from channels while a user is editing:

1. Availability can never exceed the room type's physical room count.
2. Availability can never drop below what is already sold.

Both return a plain-language warning naming the room and date rather than
silently clamping.

`booked` is always derived from the reservations table, never incremented in
place. A counter that only goes up drifts, and drift in this particular
counter means either overbooking or unsold rooms.

If a channel does manage to sell a room after we withdrew it, the room is
sold — we raise the allotment to match reality rather than discard the
booking, and the sync immediately pushes the reduced availability back out.

### The sync engine

- **A queue, not inline calls.** Editing a rate returns immediately; the push
  happens in a worker. A channel timing out must never freeze the screen.
- **Coalesced.** Editing thirty dates produces one push per channel, not
  thirty. A queued job for the same channel absorbs new cells.
- **Retried with backoff** — 5s, 30s, 2m, 10m, 30m, then parked as failed.
- **Visible per cell.** `channel_sync_state` records the outcome for every
  (channel, room type, date), and the calendar shows it as a dot in the cell.
  Nobody should have to open a log to find out whether a price change reached
  Booking.com.
- **Configuration errors are not retried.** An unmapped room type fails once
  with "not mapped to a room on <channel>" instead of burning five attempts.
- Workers claim jobs with `SELECT ... FOR UPDATE SKIP LOCKED`, so several can
  run side by side without ever handing the same job out twice.

---

## Connecting a real channel

The whole point of the adapter layer: adding a provider is **one file plus one
line**, and nothing else in the platform changes.

1. Write `server/src/channels/<provider>.js` extending `ChannelAdapter`.
2. Add it to `ADAPTERS` in `registry.js`.

`adapter.js` documents the contract. The three things that differ between
providers, and where each is declared:

| Question | Where it is answered |
|---|---|
| Do reservations arrive by webhook, or must we poll? | `capabilities.reservations` — implement `parseWebhook()` or `fetchReservations()` |
| Can we send one date, or must we resend a whole range? | `capabilities.deltaUpdates` — when false the engine widens every job automatically |
| Are rates per room or per occupancy? | the rate plan's `pricing_mode`; the adapter shapes the payload |

`mock.js` is a working reference implementation. It is deliberately imperfect —
it is slow, it fails a configurable share of requests, and it rejects
individual dates — because a sync engine only ever tested against a perfect
channel falls over on the first real timeout.

---

## What is not built yet

Phase 1 is the distribution layer. Still to come, in the order I would build
them:

- **PMS** — reservations UI, check in/out, room assignment, guest profiles
- **Housekeeping** — falls out of the PMS almost for free (room status + tasks)
- **Restaurant POS**
- **Reporting** — occupancy, ADR, RevPAR, channel production, pace

Overbooking is solved entirely in phase 1. Everything after it is convenience.
