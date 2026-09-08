import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, today, addDays } from './api.js';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parts(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return {
    dow: DOW[d.getUTCDay()],
    dayNum: d.getUTCDate(),
    mon: MON[d.getUTCMonth()],
    weekend: d.getUTCDay() === 5 || d.getUTCDay() === 6,
  };
}

/**
 * The rates and availability grid.
 *
 * Design decisions that matter to the person using it all day:
 *  - every cell is an input, so changing a price is one click and a number
 *  - edits are staged locally and saved in one request, so typing across a
 *    row does not fire thirty API calls
 *  - the room-type column and the date header are both sticky, because
 *    scrolling to December and losing the row labels makes it unusable
 *  - the sync marker sits in the cell itself, so nobody has to open a log to
 *    find out whether last night's price change actually reached the channel
 */
export default function Calendar({ property, onToast }) {
  const [from, setFrom] = useState(today());
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState({});      // key -> value
  const [saving, setSaving] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const pollRef = useRef(null);

  const to = addDays(from, days - 1);

  async function load(quiet = false) {
    if (!quiet) setLoading(true);
    try {
      const d = await api(`/properties/${property.id}/calendar?from=${from}&to=${to}`);
      setData(d);
    } catch (err) {
      onToast({ kind: 'bad', message: err.message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [property.id, from, days]);

  // While anything is still syncing, refresh quietly so the markers clear
  // themselves. Stops as soon as everything has settled - no endless polling.
  useEffect(() => {
    clearInterval(pollRef.current);
    if (!data) return;
    const busy = data.roomTypes.some((rt) => rt.days.some((c) => c.syncState === 'pending'));
    if (!busy) return;
    pollRef.current = setInterval(() => {
      if (Object.keys(edits).length === 0) load(true);
    }, 3000);
    return () => clearInterval(pollRef.current);
    /* eslint-disable-next-line */
  }, [data, edits]);

  const dirtyCount = Object.keys(edits).length;

  function setEdit(key, value) {
    setEdits((prev) => {
      const next = { ...prev };
      if (value === '') delete next[key];
      else next[key] = value;
      return next;
    });
  }

  async function save() {
    const changes = [];
    for (const [key, raw] of Object.entries(edits)) {
      const [kind, id, date, extra] = key.split(':');
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      if (kind === 'inv') {
        changes.push({ roomTypeId: Number(id), date, allotment: value });
      } else if (kind === 'rate') {
        changes.push({ roomTypeId: Number(extra), ratePlanId: Number(id), date, rate: value });
      }
    }
    if (!changes.length) return;

    setSaving(true);
    try {
      const res = await api(`/properties/${property.id}/calendar`, {
        method: 'POST',
        body: { changes },
      });
      setEdits({});
      await load(true);
      onToast({
        kind: res.warnings?.length ? 'warn' : 'ok',
        message: `${res.applied} change${res.applied === 1 ? '' : 's'} saved and queued to your channels`,
        details: res.warnings,
      });
    } catch (err) {
      onToast({ kind: 'bad', message: err.message });
    } finally {
      setSaving(false);
    }
  }

  const dateParts = useMemo(() => (data ? data.dates.map(parts) : []), [data]);
  const todayStr = today();

  if (loading && !data) return <div className="empty">Loading calendar…</div>;
  if (!data) return null;

  return (
    <>
      <div className="bar">
        <div className="field">
          <label>From</label>
          <input type="date" className="control" value={from}
                 onChange={(e) => e.target.value && setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label>Show</label>
          <select className="control" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
          </select>
        </div>
        <button className="btn" onClick={() => setFrom(addDays(from, -days))}>← Back</button>
        <button className="btn" onClick={() => setFrom(addDays(from, days))}>Forward →</button>
        <button className="btn" onClick={() => setFrom(todayStr)}>Today</button>

        <div className="spacer" />

        <button className="btn" onClick={() => setBulkOpen((v) => !v)}>
          {bulkOpen ? 'Close bulk edit' : 'Bulk edit…'}
        </button>
        <button className="btn primary" disabled={!dirtyCount || saving} onClick={save}>
          {saving ? 'Saving…' : dirtyCount ? `Save ${dirtyCount} change${dirtyCount === 1 ? '' : 's'}` : 'No changes'}
        </button>
      </div>

      {bulkOpen && (
        <BulkEdit
          property={property}
          roomTypes={data.roomTypes}
          from={from}
          to={to}
          onDone={(res) => {
            setBulkOpen(false);
            load(true);
            onToast({
              kind: res.warnings?.length ? 'warn' : 'ok',
              message: `Bulk edit applied to ${res.datesAffected} dates`,
              details: res.warnings,
            });
          }}
          onError={(msg) => onToast({ kind: 'bad', message: msg })}
        />
      )}

      <div className="cal-wrap">
        <table className="cal">
          <thead>
            <tr>
              <th className="rowhead">Room type / rate plan</th>
              {data.dates.map((d, i) => (
                <th key={d}
                    className={`day${dateParts[i].weekend ? ' weekend' : ''}${d === todayStr ? ' today' : ''}`}>
                  <span className="dow">{dateParts[i].dow}</span>
                  <span className="dnum">{dateParts[i].dayNum}</span>
                  <span className="mon">{dateParts[i].mon}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.roomTypes.map((rt) => (
              <React.Fragment key={rt.id}>
                <tr className="rt-row">
                  <td className="rowhead">
                    <span className="rt-name">{rt.name}</span>
                    <span className="rt-sub">{rt.totalRooms} rooms · available to sell</span>
                  </td>
                  {rt.days.map((cell, i) => {
                    const key = `inv:${rt.id}:${cell.date}`;
                    const edited = edits[key] !== undefined;
                    const shown = edited ? edits[key] : cell.available;
                    return (
                      <td key={cell.date} className={`cellbox${dateParts[i].weekend ? ' weekend' : ''}`}>
                        <input
                          className={`cell${edited ? ' dirty' : ''}${Number(shown) === 0 ? ' zero' : ''}${cell.stopSell ? ' stop' : ''}`}
                          value={shown}
                          inputMode="numeric"
                          title={`${cell.allotment} allotted, ${cell.booked} booked${cell.stopSell ? ' — stop sell' : ''}`}
                          onChange={(e) => setEdit(key, e.target.value.replace(/[^\d]/g, ''))}
                          onFocus={(e) => e.target.select()}
                        />
                        <span className={`dot ${cell.syncState}`} title={`Sync: ${cell.syncState}`} />
                        {cell.booked > 0 && <span className="booked-strip" />}
                      </td>
                    );
                  })}
                </tr>

                {rt.ratePlans.map((rp) => (
                  <tr className="rp-row" key={rp.id}>
                    <td className="rowhead">{rp.name}</td>
                    {rp.days.map((cell, i) => {
                      const key = `rate:${rp.id}:${cell.date}:${rt.id}`;
                      const edited = edits[key] !== undefined;
                      const shown = edited ? edits[key] : (cell.amount ?? '');
                      return (
                        <td key={cell.date} className={dateParts[i].weekend ? 'weekend' : ''}>
                          <input
                            className={`cell rate${edited ? ' dirty' : ''}`}
                            value={shown}
                            inputMode="numeric"
                            placeholder="—"
                            onChange={(e) => setEdit(key, e.target.value.replace(/[^\d.]/g, ''))}
                            onFocus={(e) => e.target.select()}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="legend">
        <span className="k"><span className="swatch" style={{ background: 'var(--warn)' }} />Waiting to reach the channel</span>
        <span className="k"><span className="swatch" style={{ background: 'var(--danger)' }} />Channel rejected it</span>
        <span className="k"><span className="swatch" style={{ background: 'var(--accent)', borderRadius: 2, height: 3, width: 14 }} />Has bookings</span>
        <span className="k muted">Top row of each group is rooms available to sell. Rows below are the nightly rate per plan.</span>
      </div>
    </>
  );
}

/**
 * Bulk edit. "Raise the weekend rate for December" should be one action, not
 * sixty cell edits - this is the single most-used tool in every channel
 * manager I have seen.
 */
function BulkEdit({ property, roomTypes, from, to, onDone, onError }) {
  const [roomTypeIds, setRoomTypeIds] = useState(roomTypes.map((r) => r.id));
  const [ratePlanId, setRatePlanId] = useState('');
  const [weekdays, setWeekdays] = useState([0, 1, 2, 3, 4, 5, 6]);
  const [rate, setRate] = useState('');
  const [allotment, setAllotment] = useState('');
  const [bFrom, setBFrom] = useState(from);
  const [bTo, setBTo] = useState(to);
  const [busy, setBusy] = useState(false);

  const plans = roomTypes
    .filter((rt) => roomTypeIds.includes(rt.id))
    .flatMap((rt) => rt.ratePlans.map((rp) => ({ ...rp, roomTypeName: rt.name })));

  function toggle(list, setList, value) {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  }

  async function apply() {
    if (rate === '' && allotment === '') {
      onError('Enter a rate or an availability number to apply');
      return;
    }
    if (rate !== '' && !ratePlanId) {
      onError('Choose which rate plan the price applies to');
      return;
    }
    setBusy(true);
    try {
      const res = await api(`/properties/${property.id}/calendar/bulk`, {
        method: 'POST',
        body: {
          roomTypeIds, ratePlanId: ratePlanId ? Number(ratePlanId) : null,
          from: bFrom, to: bTo,
          weekdays: weekdays.length === 7 ? null : weekdays,
          rate: rate === '' ? null : Number(rate),
          allotment: allotment === '' ? null : Number(allotment),
        },
      });
      onDone(res);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h3>Bulk edit</h3>

      <div className="bar">
        <div className="field">
          <label>Dates</label>
          <input type="date" className="control" value={bFrom} onChange={(e) => setBFrom(e.target.value)} />
          <span className="muted">to</span>
          <input type="date" className="control" value={bTo} onChange={(e) => setBTo(e.target.value)} />
        </div>
      </div>

      <div className="bar">
        <div className="field"><label>Room types</label></div>
        {roomTypes.map((rt) => (
          <button key={rt.id}
                  className={`btn${roomTypeIds.includes(rt.id) ? ' primary' : ''}`}
                  onClick={() => toggle(roomTypeIds, setRoomTypeIds, rt.id)}>
            {rt.name}
          </button>
        ))}
      </div>

      <div className="bar">
        <div className="field"><label>Days</label></div>
        {DOW.map((d, i) => (
          <button key={d}
                  className={`btn${weekdays.includes(i) ? ' primary' : ''}`}
                  onClick={() => toggle(weekdays, setWeekdays, i)}>
            {d}
          </button>
        ))}
        <button className="btn" onClick={() => setWeekdays([5, 6])}>Weekends only</button>
        <button className="btn" onClick={() => setWeekdays([0, 1, 2, 3, 4, 5, 6])}>All days</button>
      </div>

      <div className="bar">
        <div className="field">
          <label>Availability</label>
          <input className="control" style={{ width: 90 }} value={allotment} placeholder="leave blank"
                 onChange={(e) => setAllotment(e.target.value.replace(/[^\d]/g, ''))} />
        </div>
        <div className="field">
          <label>Rate</label>
          <input className="control" style={{ width: 110 }} value={rate} placeholder="leave blank"
                 onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ''))} />
          <select className="control" value={ratePlanId} onChange={(e) => setRatePlanId(e.target.value)}>
            <option value="">Which rate plan?</option>
            {plans.map((rp) => (
              <option key={rp.id} value={rp.id}>{rp.name}</option>
            ))}
          </select>
        </div>
        <div className="spacer" />
        <button className="btn primary" onClick={apply} disabled={busy}>
          {busy ? 'Applying…' : 'Apply to selected dates'}
        </button>
      </div>
    </div>
  );
}
