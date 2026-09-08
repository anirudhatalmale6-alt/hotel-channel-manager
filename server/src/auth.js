import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { one, query } from './db.js';

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

export function issueToken(user) {
  return jwt.sign(
    { uid: user.id, org: user.org_id, role: user.role },
    config.auth.jwtSecret,
    { expiresIn: config.auth.tokenTtl }
  );
}

/**
 * Populates req.user with { id, orgId, role, propertyIds }.
 *
 * propertyIds is the authoritative list of properties this request may touch.
 * Owners get null, meaning "every property in the org"; everyone else gets an
 * explicit list. Route handlers must use assertProperty() rather than trusting
 * a property id from the request body.
 */
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });

  let payload;
  try {
    payload = jwt.verify(token, config.auth.jwtSecret);
  } catch {
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }

  const user = await one(
    `SELECT id, org_id, email, full_name, role, status FROM users WHERE id = ?`,
    [payload.uid]
  );
  if (!user || user.status !== 'active') {
    return res.status(401).json({ error: 'Account is not active' });
  }

  let propertyIds = null;
  if (user.role !== 'owner') {
    const rows = await query(
      `SELECT up.property_id
         FROM user_properties up
         JOIN properties p ON p.id = up.property_id
        WHERE up.user_id = ? AND p.org_id = ?`,
      [user.id, user.org_id]
    );
    propertyIds = rows.map((r) => Number(r.property_id));
  }

  req.user = {
    id: Number(user.id),
    orgId: Number(user.org_id),
    email: user.email,
    name: user.full_name,
    role: user.role,
    propertyIds,
  };
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }
    next();
  };
}

/**
 * Confirms the property belongs to the caller's org AND is one they may see.
 * Every route that takes a property id must call this - it is the single
 * chokepoint that keeps one hotel group out of another's data.
 */
export async function assertProperty(req, propertyId) {
  const id = Number(propertyId);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('A property must be selected');
    err.status = 400;
    throw err;
  }

  const property = await one(
    `SELECT id, org_id, name, code, timezone, currency
       FROM properties WHERE id = ? AND org_id = ?`,
    [id, req.user.orgId]
  );
  if (!property) {
    // Deliberately the same message as "no permission" so the API cannot be
    // used to discover which property ids exist in other orgs.
    const err = new Error('Property not found');
    err.status = 404;
    throw err;
  }

  if (req.user.propertyIds !== null && !req.user.propertyIds.includes(id)) {
    const err = new Error('Property not found');
    err.status = 404;
    throw err;
  }

  return property;
}
