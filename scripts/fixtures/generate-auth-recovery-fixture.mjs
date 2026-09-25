// Reproducible generator for scripts/fixtures/auth-recovery-<version>.json(.gz).
//
//   node scripts/fixtures/generate-auth-recovery-fixture.mjs <git-ref> [repo-path] [--verify-only] [--fixture-key=<key>]
//
// The archive is the exact byte recipe used by the existing 2.8.7 fixture:
//   files    = `git show <ref>:extension/<name>` for FILES (sorted), with every
//              line ending normalised to CRLF (matching a Windows checkout)
//   archive  = gzipSync(JSON.stringify({ files }), { level: 9 })
//   receipt  = { sourceCommit, extensionVersion, description, files: sha256 per
//              file string, archiveSha256 }
// `--verify-only` regenerates in memory and compares against the committed
// receipt/archive instead of writing (use it to prove the recipe on 2.8.7).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const fixturesDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(fixturesDir, '..', '..');
const FILES = Object.freeze([
  'auth-gate-bootstrap.js', 'auth-gate-frame.html', 'auth-gate-frame.js', 'auth-gate-transport.js',
  'auth-recovery-diagnostics.js', 'classroom-runtime-core.js', 'config.example.js', 'content-injection.js',
  'content.js', 'manifest.json', 'offscreen.js', 'page-lifecycle.js', 'popup.js', 'school-website-policy.js',
  'service-worker.js',
]);
const args = process.argv.slice(2).filter((value) => !value.startsWith('--'));
const verifyOnly = process.argv.includes('--verify-only');
const fixtureKeyArgument = process.argv.find((value) => value.startsWith('--fixture-key='))?.slice('--fixture-key='.length);
if (fixtureKeyArgument && !/^[a-z0-9][a-z0-9.-]*$/.test(fixtureKeyArgument)) {
  throw new Error('Invalid immutable fixture key');
}
const ref = args[0];
if (!ref) {
  console.error('usage: generate-auth-recovery-fixture.mjs <git-ref> [repo-path] [--verify-only]');
  process.exit(2);
}
const repo = resolve(args[1] || repoRoot);
const git = (...gitArgs) => execFileSync('git', ['-C', repo, ...gitArgs], { maxBuffer: 64 * 1024 * 1024 });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const sourceCommit = git('rev-parse', `${ref}^{commit}`).toString('utf8').trim();
// Keep old receipts byte-identical while capturing the private store in newer
// immutable fixtures. An old worker does not import this later module.
const sourceFiles = git('ls-tree', '--name-only', `${sourceCommit}:extension`).toString('utf8').split(/\r?\n/);
const runtimeFiles = [...FILES, ...(sourceFiles.includes('private-recovery-store.js') ? ['private-recovery-store.js'] : [])].sort();
const files = {};
for (const name of runtimeFiles) {
  files[name] = git('show', `${sourceCommit}:extension/${name}`).toString('utf8').replace(/\r?\n/g, '\r\n');
}
const extensionVersion = JSON.parse(files['manifest.json']).version;
const fixtureKey = fixtureKeyArgument || extensionVersion;
const archive = gzipSync(JSON.stringify({ files }), { level: 9 });
const receipt = {
  sourceCommit,
  extensionVersion,
  description: fixtureKeyArgument
    ? `Immutable unsubmitted PR candidate ${fixtureKey} (manifest ${extensionVersion}), not a published release. Baseline for startup-recovery review regressions. Candidate supplies images/styles and a synthetic managed API fixture; no configuration or credentials included.`
    : `Immutable ${extensionVersion} runtime scripts and manifest for same-ID cooperative-controller upgrade acceptance and red-on-old startup-recovery gating. Candidate supplies unchanged images/styles and a synthetic managed API fixture; no configuration or credentials included.`,
  files: Object.fromEntries(runtimeFiles.map((name) => [name, sha256(files[name])])),
  archiveSha256: sha256(archive),
};
const receiptPath = join(fixturesDir, `auth-recovery-${fixtureKey}.json`);
const archivePath = join(fixturesDir, `auth-recovery-${fixtureKey}.json.gz`);

if (verifyOnly) {
  if (!existsSync(receiptPath) || !existsSync(archivePath)) {
    console.error(`no committed fixture for ${extensionVersion} to verify against`);
    process.exit(1);
  }
  const committed = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const committedArchiveSha = sha256(readFileSync(archivePath));
  const matches = committed.archiveSha256 === receipt.archiveSha256
    && committedArchiveSha === receipt.archiveSha256
    && committed.sourceCommit === sourceCommit
    && JSON.stringify(committed.files) === JSON.stringify(receipt.files);
  console.log(JSON.stringify({ extensionVersion, sourceCommit, archiveSha256: receipt.archiveSha256, committedArchiveSha256: committedArchiveSha, matches }));
  process.exit(matches ? 0 : 1);
}

if (existsSync(receiptPath)) {
  const existing = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (existing.sourceCommit !== sourceCommit || existing.archiveSha256 !== receipt.archiveSha256) {
    throw new Error(`Refusing to replace immutable fixture ${fixtureKey}; choose a new key`);
  }
}
writeFileSync(archivePath, archive);
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ extensionVersion, sourceCommit, archiveSha256: receipt.archiveSha256, receiptPath, archivePath }));
