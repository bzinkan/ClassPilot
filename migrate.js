#!/usr/bin/env node
// Simple migration script that runs drizzle-kit push
import { execSync } from 'child_process';

console.log('🚀 Running database migrations...');
try {
  execSync('npx drizzle-kit push --force', {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production' }
  });
  console.log('✅ Migrations completed successfully');
  process.exit(0);
} catch (error) {
  console.error('❌ Migration failed:', error);
  process.exit(1);
}
