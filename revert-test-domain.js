// Run with: node revert-test-domain.js
// Reverts the "All Saints" school domain back to the original after testing

import pg from 'pg';
import { readFileSync, unlinkSync, existsSync } from 'fs';

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

async function revertTestDomain() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const schoolName = 'All Saints';

    // Read original domain from backup file
    if (!existsSync('.original-domain')) {
      console.error('❌ No .original-domain file found. Cannot determine original domain.');
      console.log('   You may need to manually update the school domain in the database.');
      return;
    }

    const originalDomain = readFileSync('.original-domain', 'utf8').trim();

    // Check if school exists
    const existingSchool = await pool.query(
      'SELECT id, domain FROM schools WHERE name = $1',
      [schoolName]
    );

    if (existingSchool.rows.length === 0) {
      console.error(`❌ School "${schoolName}" not found`);
      return;
    }

    const school = existingSchool.rows[0];

    if (school.domain === originalDomain) {
      console.log(`ℹ️  School already has original domain: ${originalDomain}`);
      // Clean up backup file
      unlinkSync('.original-domain');
      return;
    }

    // Revert school domain
    await pool.query(
      'UPDATE schools SET domain = $1 WHERE id = $2',
      [originalDomain, school.id]
    );

    console.log(`✅ Reverted "${schoolName}" domain from ${school.domain} back to ${originalDomain}`);

    // Clean up backup file
    unlinkSync('.original-domain');
    console.log('🗑️  Removed .original-domain backup file');

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

revertTestDomain();
