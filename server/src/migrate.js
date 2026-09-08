import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const conn = await mysql.createConnection({
  host: config.db.host,
  port: config.db.port,
  socketPath: config.db.socketPath || undefined,
  user: config.db.user,
  password: config.db.password,
  multipleStatements: true,
});

await conn.query(
  `CREATE DATABASE IF NOT EXISTS \`${config.db.database}\`
   CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
);
await conn.query(`USE \`${config.db.database}\``);

const sql = fs.readFileSync(path.resolve(__dirname, '../db/schema.sql'), 'utf8');
await conn.query(sql);

const [tables] = await conn.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
  [config.db.database]
);
console.log(`Migrated ${config.db.database}: ${tables.length} tables`);
console.log(tables.map((t) => '  - ' + (t.table_name || t.TABLE_NAME)).join('\n'));
await conn.end();
