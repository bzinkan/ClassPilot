// Build script for server that bundles local file: dependencies
import * as esbuild from 'esbuild';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));

// Get all dependencies except file: dependencies (those get bundled)
const externalDeps = Object.entries(pkg.dependencies || {})
  .filter(([name, version]) => !version.startsWith('file:'))
  .map(([name]) => name);

// Add devDependencies that are used in server code
const devDeps = Object.keys(pkg.devDependencies || {});

await esbuild.build({
  entryPoints: ['server/index.ts'],
  platform: 'node',
  bundle: true,
  format: 'esm',
  outdir: 'dist',
  // Mark npm packages as external, but bundle file: dependencies (like csurf)
  external: [...externalDeps, ...devDeps],
});

console.log('Server build complete');
