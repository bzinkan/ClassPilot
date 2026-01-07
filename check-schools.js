import pg from 'pg';
import { readFileSync } from 'fs';

// Load .env
try {
  const envFile = readFileSync('.env', 'utf8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...valueParts] = trimmed.split('=');
      if (key && valueParts.length > 0) {
        process.env[key] = valueParts.join('=');
      }
    }
  }
} catch (e) {}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function check() {
  const result = await pool.query('SELECT id, name, domain FROM schools');
  console.log('Schools in database:');
  result.rows.forEach(r => console.log('  -', r.name, '| domain:', r.domain));
  await pool.end();
}
check();
