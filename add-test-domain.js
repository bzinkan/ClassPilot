// Run with: node add-test-domain.js
// Temporarily changes the "All Saints" school domain to gmail.com for testing
// Run revert-test-domain.js to restore the original domain

import pg from 'pg';
import { readFileSync, writeFileSync } from 'fs';

// Simple .env parser
function loadEnv() {
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
  } catch (e) {
    // .env file not found, use existing env vars
  }
}

loadEnv();

const { Pool } = pg;

async function addTestDomain() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const schoolName = 'All Saints';
    const originalDomain = 'ascs.net';
    const testDomain = 'gmail.com';

    // Check if school exists with original domain
    const existingSchool = await pool.query(
      'SELECT id, domain FROM schools WHERE name = $1',
      [schoolName]
    );

    if (existingSchool.rows.length === 0) {
      console.error(`❌ School "${schoolName}" not found`);
      return;
    }

    const school = existingSchool.rows[0];

    // Save original domain for reverting
    writeFileSync('.original-domain', school.domain);
    console.log(`📝 Saved original domain (${school.domain}) to .original-domain file`);

    if (school.domain === testDomain) {
      console.log(`ℹ️  School already has domain: ${testDomain}`);
      return;
    }

    // Update school domain to test domain
    await pool.query(
      'UPDATE schools SET domain = $1 WHERE id = $2',
      [testDomain, school.id]
    );

    console.log(`✅ Changed "${schoolName}" domain from ${school.domain} to ${testDomain}`);
    console.log('');
    console.log('You can now test the extension with a Gmail account.');
    console.log('Run "node revert-test-domain.js" when finished testing to restore the original domain.');

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

addTestDomain();
