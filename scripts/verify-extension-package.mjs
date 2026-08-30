import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const sourceRoot = resolve(repoRoot, 'extension');
const manifest = JSON.parse(readFileSync(resolve(sourceRoot, 'manifest.json'), 'utf8'));
const expectedPreparedReleaseVersion = '2.7.8';
assert.equal(
  manifest.version,
  expectedPreparedReleaseVersion,
  'Prepared ClassPilot release guard must be bumped together with manifest.json',
);
const archivePath = resolve(
  repoRoot,
  process.argv[2] || `dist/ClassPilot-v${manifest.version}.zip`,
);
const verifyOnly = process.argv.includes('--verify-only');
const unpackRoot = mkdtempSync(join(tmpdir(), 'classpilot-release-package-'));

const excludedExact = new Set([
  'README.md',
  'COMPLIANCE.md',
  'config.js',
  'config.example.js',
  'create-simple-icons.cjs',
  'icons/generate-icons.js',
  'icons/create_icons.html',
  'icons/README.md',
  'package-extension.sh',
]);

function normalizedRelative(root, path) {
  return relative(root, path).split(sep).join('/');
}

function walkFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const relativePath = normalizedRelative(root, path);
    if (entry.isSymbolicLink()) {
      throw new Error(`Release tree must not contain symbolic links: ${relativePath}`);
    }
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'dist' || entry.name === '__MACOSX') continue;
      files.push(...walkFiles(root, path));
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name === '.DS_Store' || entry.name.endsWith('.sh') || excludedExact.has(relativePath)) {
      continue;
    }
    files.push(relativePath);
  }
  return files.sort();
}

function powershellArchiveEntries() {
  const command = `
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($env:CLASSPILOT_ARCHIVE_PATH)
    try {
      $items = @($archive.Entries | ForEach-Object {
        [pscustomobject]@{ name = $_.FullName; length = $_.Length }
      })
      ConvertTo-Json -InputObject $items -Compress
    } finally {
      $archive.Dispose()
    }
  `;
  const raw = execFileSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', command,
  ], {
    encoding: 'utf8',
    env: { ...process.env, CLASSPILOT_ARCHIVE_PATH: archivePath },
  }).trim();
  const parsed = raw ? JSON.parse(raw) : [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function unzipArchiveEntries() {
  const output = execFileSync('unzip', ['-Z1', archivePath], { encoding: 'utf8' });
  return output.split(/\r?\n/).filter(Boolean).map((name) => ({ name, length: null }));
}

function archiveEntries() {
  return process.platform === 'win32' ? powershellArchiveEntries() : unzipArchiveEntries();
}

function extractArchive() {
  if (process.platform !== 'win32') {
    execFileSync('unzip', ['-q', archivePath, '-d', unpackRoot], { stdio: 'inherit' });
    return;
  }
  const command = `
    Expand-Archive -LiteralPath $env:CLASSPILOT_ARCHIVE_PATH -DestinationPath $env:CLASSPILOT_UNPACK_PATH -Force
  `;
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command', command,
  ], {
    stdio: 'inherit',
    env: {
      ...process.env,
      CLASSPILOT_ARCHIVE_PATH: archivePath,
      CLASSPILOT_UNPACK_PATH: unpackRoot,
    },
  });
}

function validateEntryName(name) {
  const normalized = String(name || '').replace(/\\/g, '/');
  assert(normalized && normalized === name, `Unsafe ZIP entry name: ${name}`);
  assert(!normalized.startsWith('/') && !/^[A-Za-z]:/.test(normalized), `Absolute ZIP entry: ${name}`);
  assert(!normalized.split('/').includes('..'), `Traversing ZIP entry: ${name}`);
  return normalized;
}

function runPackagedTests() {
  const environment = { ...process.env, CLASSPILOT_EXTENSION_PATH: unpackRoot };
  for (const script of [
    'test-extension-resilience.mjs',
    'test-extension-authority-races.mjs',
    'test-extension-2-7-behavior.mjs',
    'test-extension-offscreen-identity.mjs',
    'test-extension-popup-identity.mjs',
    'test-extension-auth-layout.mjs',
    'test-extension-auth-startup.mjs',
  ]) {
    execFileSync(process.execPath, [resolve(scriptDir, script)], {
      cwd: repoRoot,
      env: environment,
      stdio: 'inherit',
    });
  }
}

try {
  assert(existsSync(archivePath), `Release archive is missing: ${archivePath}`);
  const entries = archiveEntries();
  const seen = new Set();
  let totalBytes = 0;
  for (const entry of entries) {
    const name = validateEntryName(entry.name);
    assert(!seen.has(name), `Duplicate ZIP entry: ${name}`);
    seen.add(name);
    if (Number.isFinite(Number(entry.length))) totalBytes += Number(entry.length);
  }
  assert(totalBytes < 64 * 1024 * 1024, 'Release archive expands beyond the 64 MiB budget');

  extractArchive();
  const expectedFiles = walkFiles(sourceRoot);
  const actualFiles = walkFiles(unpackRoot);
  const archiveFiles = [...seen].filter((name) => !name.endsWith('/')).sort();
  assert.deepEqual(archiveFiles, expectedFiles, 'Every ZIP file must match the release source allowlist');
  assert.deepEqual(actualFiles, expectedFiles, 'Unpacked release files must match the release source allowlist');

  for (const relativePath of expectedFiles) {
    const sourcePath = resolve(sourceRoot, relativePath);
    const unpackedPath = resolve(unpackRoot, relativePath);
    assert(!lstatSync(unpackedPath).isSymbolicLink(), `Unpacked release contains a link: ${relativePath}`);
    assert(
      readFileSync(unpackedPath).equals(readFileSync(sourcePath)),
      `Packaged bytes differ from source: ${relativePath}`,
    );
  }

  const packagedManifest = JSON.parse(readFileSync(resolve(unpackRoot, 'manifest.json'), 'utf8'));
  assert.equal(packagedManifest.version, manifest.version, 'Packaged manifest version must match source');
  assert.equal(basename(archivePath), `ClassPilot-v${manifest.version}.zip`, 'Archive name must be versioned');

  const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex');
  writeFileSync(`${archivePath}.sha256`, `${digest}  ${basename(archivePath)}\n`, 'utf8');
  console.log(`Verified ${archiveFiles.length} packaged files byte-for-byte.`);
  console.log(`SHA-256 ${digest}`);

  if (!verifyOnly) runPackagedTests();
  console.log(verifyOnly
    ? 'ClassPilot release package verification passed.'
    : 'ClassPilot unpacked release integration tests passed.');
} finally {
  rmSync(unpackRoot, { recursive: true, force: true });
}
