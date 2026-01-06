// Run with: node seed-test-user.js
// Creates or updates admin@ascs.net with password admin123, linked to "All Saints" school

import pg from 'pg';
import bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';

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

async function seedTestUser() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const schoolName = 'All Saints';
    const schoolDomain = 'ascs.net';
    const email = 'admin@ascs.net';
    const password = 'admin123';
    const hashedPassword = await bcrypt.hash(password, 10);

    // Step 1: Check if school exists, create if not
    let schoolId;
    const existingSchool = await pool.query(
      'SELECT id FROM schools WHERE domain = $1',
      [schoolDomain]
    );

    if (existingSchool.rows.length > 0) {
      schoolId = existingSchool.rows[0].id;
      console.log(`✅ Found existing school: ${schoolName} (${schoolId})`);
    } else {
      schoolId = randomUUID();
      await pool.query(
        `INSERT INTO schools (id, name, domain, status, is_active, plan_tier, plan_status, created_at)
         VALUES ($1, $2, $3, 'active', true, 'pro', 'active', NOW())`,
        [schoolId, schoolName, schoolDomain]
      );
      console.log(`✅ Created school: ${schoolName} (${schoolId})`);
    }

    // Step 2: Check if user exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email]
    );

    if (existingUser.rows.length > 0) {
      // Update existing user's password and school
      await pool.query(
        'UPDATE users SET password = $1, school_id = $2, role = $3 WHERE email = $4',
        [hashedPassword, schoolId, 'admin', email]
      );
      console.log(`✅ Updated user: ${email}`);
    } else {
      // Create new user
      const userId = randomUUID();
      await pool.query(
        `INSERT INTO users (id, email, password, role, school_id, display_name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [userId, email, hashedPassword, 'admin', schoolId, 'Admin']
      );
      console.log(`✅ Created new admin user: ${email}`);
    }

    console.log('');
    console.log('Login credentials:');
    console.log(`   Email: ${email}`);
    console.log(`   Password: ${password}`);
    console.log(`   School: ${schoolName}`);

  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

seedTestUser();
