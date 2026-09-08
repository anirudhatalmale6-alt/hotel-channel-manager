import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  socketPath: config.db.socketPath || undefined,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  timezone: 'Z',
  // Money must not arrive as a float. DECIMAL columns come back as strings
  // and we convert deliberately where we need a number.
  decimalNumbers: false,
  dateStrings: ['DATE'],
});

export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

export async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

/**
 * Run a function inside a transaction. Anything that touches inventory goes
 * through here - the overbooking guard is only meaningful if the read of
 * current availability and the write that consumes it are in one transaction.
 */
export async function transaction(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try { await conn.rollback(); } catch { /* connection already gone */ }
    throw err;
  } finally {
    conn.release();
  }
}
