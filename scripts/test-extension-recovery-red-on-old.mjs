// Red-on-old gate for the startup-recovery browser cases.
//
// Every case tagged `expectedRedOnBase` in
// scripts/test-extension-auth-recovery-browser.mjs is run against UNMODIFIED
// released sources and must exit NON-ZERO. `true` selects the immutable v2.8.9
// snapshot (the 2.9.0 correction); a version string selects that released
// snapshot (the 2.9.4 wake-recovery cases trip on v2.9.3). Each snapshot
// (scripts/fixtures/auth-recovery-<version>.json.gz, verified by its receipt)
// is laid over the candidate's non-script assets. Unless `--old-only` is
// passed, the same case then runs against the candidate
// (CLASSPILOT_EXTENSION_PATH unset) and must exit zero. A case that cannot trip
// on the old worker is not a regression test, so this gate refuses to pass on
// a green candidate alone.
//
//   node scripts/test-extension-recovery-red-on-old.mjs [--old-only] [--case <name>]...
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const harness = join(repoRoot, 'scripts', 'test-extension-auth-recovery-browser.mjs');
const BASE_VERSION = '2.8.9';
const args = process.argv.slice(2);
const oldOnly = args.includes('--old-only');
const onlyCases = args.flatMap((value, index) => (value === '--case' && args[index + 1] ? [args[index + 1]] : []));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function loadCaseTable() {
  const listed = spawnSync(process.execPath, [harness, '--list-cases'], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, CLASSPILOT_EXTENSION_PATH: '' } });
  assert.equal(listed.status, 0, `could not list harness cases: ${listed.stderr}`);
  return JSON.parse(listed.stdout.trim().split('\n').at(-1));
}

function materializeBase(version) {
  // Immutable released sources, verified against the committed receipt, over a
  // copy of the candidate's extension directory (icons/styles/vendor only; every
  // runtime script, the manifest and the frame document come from the snapshot).
  const receipt = JSON.parse(readFileSync(join(repoRoot, `scripts/fixtures/auth-recovery-${version}.json`), 'utf8'));
  const bytes = readFileSync(join(repoRoot, `scripts/fixtures/auth-recovery-${version}.json.gz`));
  assert.equal(sha256(bytes), receipt.archiveSha256, `auth-recovery-${version}.json.gz does not match its receipt`);
  const snapshot = JSON.parse(gunzipSync(bytes));
  const root = mkdtempSync(join(tmpdir(), 'classpilot-red-on-old-'));
  const extensionPath = join(root, 'extension');
  cpSync(join(repoRoot, 'extension'), extensionPath, { recursive: true });
  for (const [name, contents] of Object.entries(snapshot.files)) {
    assert.equal(sha256(contents), receipt.files[name], `snapshot file ${name} does not match its receipt`);
    writeFileSync(join(extensionPath, name), contents);
  }
  rmSync(join(extensionPath, 'config.js'), { force: true });
  const manifest = JSON.parse(readFileSync(join(extensionPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, version);
  return { version, root, extensionPath, sourceCommit: receipt.sourceCommit, archiveSha256: receipt.archiveSha256 };
}

function runCase(caseName, extensionPath) {
  const startedAt = Date.now();
  const env = { ...process.env, CLASSPILOT_AUTH_RECOVERY_CASE: caseName };
  if (extensionPath) env.CLASSPILOT_EXTENSION_PATH = extensionPath; else delete env.CLASSPILOT_EXTENSION_PATH;
  const result = spawnSync(process.execPath, [harness], { cwd: repoRoot, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 240_000 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const trip = output.match(/^(?:AssertionError(?: \[ERR_ASSERTION\])?|Error|TypeError|RangeError): (.+)$/m)?.[1]
    || output.match(/^\s*(?:code|message): '?(.+?)'?,?$/m)?.[1]
    || (result.signal ? `terminated by ${result.signal}` : null)
    || (result.error ? String(result.error.message) : null);
  const passLine = output.match(/^PASS .*$/m)?.[0] || null;
  return { status: result.status, signal: result.signal, ms: Date.now() - startedAt, trip: trip ? trip.slice(0, 220) : null, passLine, output };
}

const table = loadCaseTable();
const redCases = Object.entries(table)
  .filter(([name, spec]) => spec.expectedRedOnBase && (onlyCases.length === 0 || onlyCases.includes(name)))
  .map(([name, spec]) => ({ name, base: spec.expectedRedOnBase === true ? BASE_VERSION : String(spec.expectedRedOnBase) }));
assert.ok(redCases.length > 0, 'no expectedRedOnBase cases selected');
const bases = new Map();
for (const version of new Set(redCases.map((entry) => entry.base))) bases.set(version, materializeBase(version));
const describeBase = (version) => {
  const base = bases.get(version);
  return `${version} (${base.sourceCommit.slice(0, 12)}, archive ${base.archiveSha256.slice(0, 12)})`;
};
console.log(`Red-on-old: ${redCases.length} case(s) against immutable ${[...bases.keys()].map(describeBase).join(', ')}${oldOnly ? ' [old only]' : ''}`);
const rows = [];
let failures = 0;
const suiteStarted = Date.now();
try {
  for (const { name: caseName, base: baseVersion } of redCases) {
    const base = bases.get(baseVersion);
    const old = runCase(caseName, base.extensionPath);
    const oldOk = old.status !== 0;
    const row = { case: caseName, base: baseVersion, old: oldOk ? 'RED (expected)' : 'GREEN (UNEXPECTED)', oldMs: old.ms, oldTrip: old.trip, candidate: 'skipped', candidateMs: null, candidateTrip: null };
    if (!oldOk) {
      failures += 1;
      console.log(`--- ${caseName}: unexpectedly GREEN on ${baseVersion}; last output lines:\n${old.output.trim().split('\n').slice(-25).join('\n')}`);
    } else if (!old.trip) {
      console.log(`--- ${caseName}: red on ${baseVersion} but no assertion message found; last output lines:\n${old.output.trim().split('\n').slice(-25).join('\n')}`);
    }
    if (!oldOnly) {
      const candidate = runCase(caseName, null);
      const candidateOk = candidate.status === 0;
      row.candidate = candidateOk ? 'PASS' : 'FAIL';
      row.candidateMs = candidate.ms;
      row.candidateTrip = candidateOk ? null : candidate.trip;
      if (!candidateOk) {
        failures += 1;
        console.log(`--- ${caseName}: FAILED on candidate; last output lines:\n${candidate.output.trim().split('\n').slice(-40).join('\n')}`);
      }
    }
    rows.push(row);
    console.log(`${caseName.padEnd(34)} ${baseVersion.padEnd(6)} old: ${row.old.padEnd(19)} ${String(row.oldMs).padStart(6)}ms  ${row.candidate.padEnd(7)} ${row.candidateMs === null ? '' : `${String(row.candidateMs).padStart(6)}ms`}`);
    if (row.oldTrip) console.log(`${''.padEnd(34)}   tripped on ${baseVersion}: ${row.oldTrip}`);
    if (row.candidateTrip) console.log(`${''.padEnd(34)}   candidate failure: ${row.candidateTrip}`);
  }
} finally {
  for (const base of bases.values()) {
    const target = resolve(base.root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('classpilot-red-on-old-'));
    rmSync(target, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({
  bases: [...bases.values()].map(({ version, sourceCommit, archiveSha256 }) => ({ version, sourceCommit, archiveSha256 })),
  oldOnly, totalMs: Date.now() - suiteStarted, rows,
}));
if (failures > 0) {
  console.error(`Red-on-old gate FAILED: ${failures} case(s) did not behave as expected.`);
  process.exit(1);
}
console.log(`Red-on-old gate passed: every expected-red case trips on its released base${oldOnly ? '' : ' and passes on the candidate'}.`);
