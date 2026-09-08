import React, { useEffect, useState } from 'react';
import { api, getToken, setToken, money, today, addDays } from './api.js';
import Calendar from './Calendar.jsx';

export default function App() {
  const [user, setUser] = useState(null);
  const [booting, setBooting] = useState(true);
  const [properties, setProperties] = useState([]);
  const [property, setProperty] = useState(null);
  const [tab, setTab] = useState('calendar');
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (!getToken()) { setBooting(false); return; }
    api('/auth/me')
      .then((d) => setUser(d.user))
      .catch(() => setToken(null))
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    api('/properties').then((d) => {
      setProperties(d.properties);
      setProperty((cur) => cur || d.properties[0] || null);
    }).catch((err) => showToast({ kind: 'bad', message: err.message }));
  }, [user]);

  function showToast(t) {
    setToast(t);
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => setToast(null), t.details?.length ? 12000 : 5000);
  }

  if (booting) return <div className="empty">Loading…</div>;
  if (!user) return <Login onDone={setUser} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">CM</span>
          <span>
            Channel Manager
            <span className="brand-org"> · {user.org?.name}</span>
          </span>
        </div>

        {properties.length > 0 && (
          <select
            className="control"
            value={property?.id || ''}
            onChange={(e) => setProperty(properties.find((p) => p.id === Number(e.target.value)))}
          >
            {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}

        <nav className="nav">
          {[
            ['calendar', 'Rates & Availability'],
            ['dashboard', 'Overview'],
            ['reservations', 'Reservations'],
            ['channels', 'Channels'],
          ].map(([key, label]) => (
            <button key={key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </nav>

        <div className="spacer" />

        <div className="who">
          <span>{user.name || user.email}</span>
          <span className="pill">{user.role}</span>
          <button className="btn" onClick={() => { setToken(null); window.location.reload(); }}>
            Sign out
          </button>
        </div>
      </header>

      <main className="body">
        {!property ? (
          <div className="empty">No properties available for your account.</div>
        ) : tab === 'calendar' ? (
          <Calendar property={property} onToast={showToast} />
        ) : tab === 'dashboard' ? (
          <Dashboard property={property} onToast={showToast} />
        ) : tab === 'reservations' ? (
          <Reservations property={property} onToast={showToast} />
        ) : (
          <Channels property={property} onToast={showToast} />
        )}
      </main>

      {toast && (
        <div className={`toast ${toast.kind}`}>
          <div>{toast.message}</div>
          {toast.details?.length > 0 && (
            <ul>{toast.details.slice(0, 12).map((d, i) => <li key={i}>{d}</li>)}</ul>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Login({ onDone }) {
  const [email, setEmail] = useState('owner@demo.com');
  const [password, setPassword] = useState('demo1234');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const d = await api('/auth/login', { method: 'POST', body: { email, password } });
      setToken(d.token);
      onDone(d.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login" onSubmit={submit}>
        <span className="brand-mark">CM</span>
        <h1>Channel Manager</h1>
        <p>Rates, availability and bookings in one place.</p>

        {error && <div className="err">{error}</div>}

        <input className="control" type="email" value={email} placeholder="Email"
               onChange={(e) => setEmail(e.target.value)} />
        <input className="control" type="password" value={password} placeholder="Password"
               onChange={(e) => setPassword(e.target.value)} />
        <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>

        <div className="hint">
          Demo accounts:<br />
          <code>owner@demo.com</code> · sees the whole group<br />
          <code>manager@demo.com</code> · sees Colombo only<br />
          Password <code>demo1234</code>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Dashboard({ property, onToast }) {
  const [d, setD] = useState(null);

  useEffect(() => {
    api(`/properties/${property.id}/dashboard`)
      .then(setD)
      .catch((err) => onToast({ kind: 'bad', message: err.message }));
  }, [property.id]);

  if (!d) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="cards">
        <div className="card">
          <div className="k">Occupancy · next 30 days</div>
          <div className="v">{d.next30Days.occupancyPct}%</div>
          <div className="sub">
            {d.next30Days.roomNightsSold.toLocaleString()} of {d.next30Days.roomNightsAvailable.toLocaleString()} room nights
          </div>
        </div>
        <div className="card">
          <div className="k">Booked revenue · next 30 days</div>
          <div className="v small">{d.next30Days.currency} {money(d.next30Days.revenue)}</div>
          <div className="sub">confirmed bookings only</div>
        </div>
        <div className="card">
          <div className="k">Arrivals today</div>
          <div className="v">{d.today.arrivals}</div>
          <div className="sub">{d.today.departures} departures</div>
        </div>
        <div className="card">
          <div className="k">Channel sync</div>
          <div className={`v ${d.sync.failedCells ? 'bad' : 'ok'}`}>
            {d.sync.failedCells ? `${d.sync.failedCells} failed` : 'Healthy'}
          </div>
          <div className="sub">
            {d.sync.pendingCells > 0 ? `${d.sync.pendingCells} dates still sending` : 'everything up to date'}
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>What this screen is for</h3>
        <p className="muted" style={{ margin: 0, maxWidth: 720 }}>
          Occupancy and revenue answer "how are we doing". The sync card answers the question that
          costs money: is what the hotel decided actually live on the channels? A failure here means
          a channel is still selling yesterday's price or yesterday's availability.
        </p>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function Reservations({ property, onToast }) {
  const [rows, setRows] = useState(null);

  function load() {
    api(`/properties/${property.id}/reservations`)
      .then((d) => setRows(d.reservations))
      .catch((err) => onToast({ kind: 'bad', message: err.message }));
  }
  useEffect(load, [property.id]);

  if (!rows) return <div className="empty">Loading…</div>;
  if (!rows.length) {
    return (
      <div className="panel">
        <h3>Reservations</h3>
        <p className="muted" style={{ margin: 0 }}>
          Nothing yet. Bookings appear here as the channels send them — go to Channels and use
          "Simulate a booking" to watch one arrive and take availability off the calendar.
        </p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h3>Reservations</h3>
      <table className="list">
        <thead>
          <tr>
            <th>Reference</th><th>Guest</th><th>Room</th><th>Channel</th>
            <th>Check in</th><th>Check out</th><th>Rooms</th><th>Value</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{r.remote_ref}</td>
              <td>{r.guest_name || <span className="muted">—</span>}</td>
              <td>{r.room_type_name}</td>
              <td className="muted">{r.channel_name || '—'}</td>
              <td>{r.check_in}</td>
              <td>{r.check_out}</td>
              <td>{r.rooms}</td>
              <td>{r.currency} {money(r.total_amount)}</td>
              <td>
                <span className={`tag ${r.status === 'confirmed' ? 'ok' : r.status === 'cancelled' ? 'bad' : 'dim'}`}>
                  {r.status}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Channels({ property, onToast }) {
  const [channels, setChannels] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [busy, setBusy] = useState('');

  function load() {
    api(`/properties/${property.id}/channels`)
      .then((d) => setChannels(d.channels))
      .catch((err) => onToast({ kind: 'bad', message: err.message }));
    api(`/properties/${property.id}/sync-jobs`)
      .then((d) => setJobs(d.jobs))
      .catch(() => {});
  }
  useEffect(load, [property.id]);

  async function test(ch) {
    setBusy(`test-${ch.id}`);
    try {
      const r = await api(`/channels/${ch.id}/test`, { method: 'POST' });
      onToast({ kind: 'ok', message: r.message || 'Connection OK' });
    } catch (err) {
      onToast({ kind: 'bad', message: err.message });
    } finally { setBusy(''); load(); }
  }

  async function resync(ch) {
    setBusy(`resync-${ch.id}`);
    try {
      const r = await api(`/channels/${ch.id}/resync`, {
        method: 'POST',
        body: { from: today(), to: addDays(today(), 29) },
      });
      onToast({ kind: 'ok', message: `Queued ${r.queued} dates to resend to ${ch.name}` });
    } catch (err) {
      onToast({ kind: 'bad', message: err.message });
    } finally { setBusy(''); setTimeout(load, 1200); }
  }

  async function simulate(ch) {
    setBusy(`sim-${ch.id}`);
    try {
      const remote = await api(`/channels/${ch.id}/remote-inventory`);
      const roomMapping = remote.mappings.find((m) => m.entity_type === 'room_type');
      if (!roomMapping) throw new Error('Map a room type to this channel first');

      const checkIn = addDays(today(), 2 + Math.floor(Math.random() * 20));
      await api(`/channels/${ch.id}/demo-reservation`, {
        method: 'POST',
        body: {
          remoteRef: `SIM-${Date.now()}`,
          remoteRoomTypeId: roomMapping.remote_id,
          guestName: 'Simulated Guest',
          checkIn,
          checkOut: addDays(checkIn, 2),
          rooms: 1 + Math.floor(Math.random() * 3),
          totalAmount: 45000,
          currency: property.currency,
        },
      });
      onToast({
        kind: 'ok',
        message: `Booking received from ${ch.name} for ${checkIn}. Availability has dropped and the change is queued to every other channel.`,
      });
    } catch (err) {
      onToast({ kind: 'bad', message: err.message });
    } finally { setBusy(''); setTimeout(load, 1200); }
  }

  if (!channels) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="panel">
        <h3>Connected channels</h3>
        <table className="list">
          <thead>
            <tr>
              <th>Channel</th><th>Status</th><th>Dates in sync</th>
              <th>Queue</th><th>Last sync</th><th></th>
            </tr>
          </thead>
          <tbody>
            {channels.map((ch) => (
              <tr key={ch.id}>
                <td>
                  <div>{ch.name}</div>
                  <div className="muted" style={{ fontSize: 12 }}>adapter: {ch.adapter}</div>
                </td>
                <td>
                  {ch.last_error
                    ? <span className="tag bad" title={ch.last_error}>error</span>
                    : ch.enabled ? <span className="tag ok">connected</span>
                                 : <span className="tag dim">disabled</span>}
                </td>
                <td>
                  <span className="tag ok">{ch.cells.synced} ok</span>{' '}
                  {ch.cells.pending > 0 && <span className="tag warn">{ch.cells.pending} sending</span>}{' '}
                  {ch.cells.failed > 0 && <span className="tag bad">{ch.cells.failed} failed</span>}
                </td>
                <td className="muted">
                  {Number(ch.jobs.queued) || 0} queued · {Number(ch.jobs.failed) || 0} failed
                </td>
                <td className="muted">
                  {ch.last_sync_at ? new Date(ch.last_sync_at).toLocaleString() : 'never'}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn" disabled={busy === `test-${ch.id}`} onClick={() => test(ch)}>Test</button>{' '}
                  <button className="btn" disabled={busy === `resync-${ch.id}`} onClick={() => resync(ch)}>Resync 30 days</button>{' '}
                  <button className="btn" disabled={busy === `sim-${ch.id}`} onClick={() => simulate(ch)}>Simulate a booking</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h3>Sync activity</h3>
        {jobs.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>Nothing has needed syncing yet.</p>
        ) : (
          <table className="list">
            <thead>
              <tr><th>#</th><th>Channel</th><th>Type</th><th>Status</th><th>Attempts</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {jobs.slice(0, 15).map((j) => (
                <tr key={j.id}>
                  <td className="muted">{j.id}</td>
                  <td>{j.channel_name || '—'}</td>
                  <td className="muted">{j.job_type}</td>
                  <td>
                    <span className={`tag ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : j.status === 'running' ? 'warn' : 'dim'}`}>
                      {j.status}
                    </span>
                  </td>
                  <td className="muted">{j.attempts}/{j.max_attempts}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{j.last_error || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
