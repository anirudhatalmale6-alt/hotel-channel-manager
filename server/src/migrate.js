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

await conn.query(fs.readFileSync(path.resolve(__dirname, '../db/schema.sql'), 'utf8'));

// Incremental migrations, applied in filename order. Each is written to be
// safe to re-run so a partial deployment can simply be run again.
const migDir = path.resolve(__dirname, '../db/migrations');
if (fs.existsSync(migDir)) {
  for (const file of fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await conn.query(fs.readFileSync(path.join(migDir, file), 'utf8'));
      console.log(`  applied ${file}`);
    } catch (err) {
      // Already-applied columns/tables are not an error worth stopping for.
      if (/Duplicate column|already exists|Duplicate key name/i.test(err.message)) {
        console.log(`  skipped ${file} (already applied)`);
      } else {
        throw err;
      }
    }
  }
}

const [tables] = await conn.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
  [config.db.database]
);
console.log(`Migrated ${config.db.database}: ${tables.length} tables`);
console.log(tables.map((t) => '  - ' + (t.table_name || t.TABLE_NAME)).join('\n'));
await conn.end();
