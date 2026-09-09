/**
 * A stand-in for Aiosell's API, built strictly from apidocs.aiosell.com.
 *
 * Lets the adapter be exercised end to end before partner credentials exist:
 * it validates Basic Auth, enforces the documented 40 requests/minute, checks
 * the payload shape, and records every request so a test can assert how many
 * calls a push actually made.
 *
 * When the real credentials arrive, point the channel's baseUrl at Aiosell
 * instead of this and nothing else changes.
 */
import http from 'node:http';

const USER = 'test-partner';
const PASS = 'test-secret';

export function startFakeAiosell(port = 0) {
  const state = {
    requests: [],
    inventory: new Map(),   // `${hotelCode}|${roomCode}|${date}` -> available
    rates: new Map(),       // `${hotelCode}|${roomCode}|${rateplan}|${date}` -> rate
    restrictions: new Map(),
    windowStart: Date.now(),
    windowCount: 0,
    enforceRateLimit: true,
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code, obj) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      // --- auth ---
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Basic ')) {
        return send(401, { success: false, message: 'Missing Basic Auth' });
      }
      const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString('utf8').split(':');
      if (user !== USER || pass !== PASS) {
        return send(401, { success: false, message: 'Bad credentials' });
      }

      // --- documented rate limit: 40 requests per minute per partner ---
      const now = Date.now();
      if (now - state.windowStart > 60000) {
        state.windowStart = now;
        state.windowCount = 0;
      }
      state.windowCount++;
      if (state.enforceRateLimit && state.windowCount > 40) {
        return send(429, { success: false, message: 'Too Many Requests' });
      }

      const url = new URL(req.url, 'http://localhost');
      const parsed = body ? JSON.parse(body) : null;
      state.requests.push({ method: req.method, path: url.pathname, body: parsed });

      // --- GET /property_details/{hotelCode}?partnerId=... ---
      if (req.method === 'GET' && url.pathname.includes('/property_details/')) {
        if (!url.searchParams.get('partnerId')) {
          return send(400, { success: false, message: 'partnerId is required' });
        }
        return send(200, {
          currency: 'INR',
          timezone: 'Asia/Kolkata',
          address: { line: 'India, Bangalore', city: 'Bangalore', state: 'Karnataka', country_code: 'IN' },
          rooms: [
            {
              room_id: 'executive', room_name: 'EXECUTIVE', count: 25,
              active: true, type: 'primary', min_occ: 1, max_occ: 2,
              rateplans: [
                { rateplan_id: 'executive-s-ep', rateplan_name: 'Room Only', occupancy: 1, no_of_meals: 0, extra_adult: 500 },
                { rateplan_id: 'executive-d-ep', rateplan_name: 'Room Only', occupancy: 2, no_of_meals: 0, extra_adult: 500 },
                { rateplan_id: 'executive-s-cp', rateplan_name: 'Breakfast', occupancy: 1, no_of_meals: 1, extra_adult: 500 },
                { rateplan_id: 'executive-d-cp', rateplan_name: 'Breakfast', occupancy: 2, no_of_meals: 2, extra_adult: 500 },
              ],
            },
            {
              room_id: 'suite', room_name: 'SUITE', count: 5,
              active: true, type: 'primary', min_occ: 1, max_occ: 4,
              rateplans: [
                { rateplan_id: 'suite-d-cp', rateplan_name: 'Breakfast', occupancy: 2, no_of_meals: 2, extra_adult: 800 },
              ],
            },
          ],
        });
      }

      // --- POST /update/{pms} : inventory OR inventory restrictions ---
      if (req.method === 'POST' && url.pathname.startsWith('/update/')) {
        if (!parsed?.hotelCode) return send(400, { success: false, message: 'hotelCode is required' });
        if (!Array.isArray(parsed.updates)) return send(400, { success: false, message: 'updates is required' });

        const isRestriction = parsed.updates.some((u) =>
          (u.rooms || []).some((r) => r.restrictions !== undefined));

        if (isRestriction) {
          // toChannels is documented as required and non-empty.
          if (!Array.isArray(parsed.toChannels) || parsed.toChannels.length === 0) {
            return send(400, { success: false, message: 'toChannels is required for restrictions' });
          }
          for (const u of parsed.updates) {
            for (const room of u.rooms || []) {
              for (const d of expand(u.startDate, u.endDate)) {
                state.restrictions.set(`${parsed.hotelCode}|${room.roomCode}|${d}`, room.restrictions);
              }
            }
          }
          return send(200, { success: true, message: 'Inventory Updated Successfully' });
        }

        for (const u of parsed.updates) {
          if (!u.startDate || !u.endDate) {
            return send(400, { success: false, message: 'startDate and endDate are required' });
          }
          for (const room of u.rooms || []) {
            if (typeof room.available !== 'number' || room.available < 0) {
              return send(400, { success: false, message: 'available must be a non-negative integer' });
            }
            for (const d of expand(u.startDate, u.endDate)) {
              state.inventory.set(`${parsed.hotelCode}|${room.roomCode}|${d}`, room.available);
            }
          }
        }
        return send(200, { success: true, message: 'Inventory Updated Successfully' });
      }

      // --- POST /update-rates/{pms} : rates OR rate restrictions ---
      if (req.method === 'POST' && url.pathname.startsWith('/update-rates/')) {
        if (!parsed?.hotelCode) return send(400, { success: false, message: 'hotelCode is required' });
        for (const u of parsed.updates || []) {
          for (const r of u.rates || []) {
            if (r.restrictions) continue;
            if (typeof r.rate !== 'number') {
              return send(400, { success: false, message: 'rate must be a number' });
            }
            for (const d of expand(u.startDate, u.endDate)) {
              state.rates.set(`${parsed.hotelCode}|${r.roomCode}|${r.rateplanCode}|${d}`, r.rate);
            }
          }
        }
        return send(200, { success: true, message: 'Rates Updated Successfully' });
      }

      // --- POST /data/{pms} : fetch inventory / rates / reservations ---
      if (req.method === 'POST' && url.pathname.startsWith('/data/')) {
        if (parsed?.type === 'reservation') return send(200, []);
        return send(200, {});
      }

      if (req.method === 'POST' && url.pathname.startsWith('/marknoshow/')) {
        return send(200, { success: true, message: 'Noshow Marked Successfully' });
      }

      if (req.method === 'POST' && url.pathname.startsWith('/channel_multiplier/')) {
        if (!Array.isArray(parsed?.channels) || parsed.channels.length === 0) {
          return send(400, { status: false, message: 'channels cannot be empty' });
        }
        return send(200, { status: true, message: 'Multiplier updated successfully' });
      }

      send(404, { success: false, message: 'Unknown endpoint' });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        state,
        port: server.address().port,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        credentials: { username: USER, password: PASS },
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function expand(from, to) {
  const out = [];
  let cur = from;
  for (let i = 0; i < 800 && cur <= to; i++) {
    out.push(cur);
    const d = new Date(cur + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    cur = d.toISOString().slice(0, 10);
  }
  return out;
}
