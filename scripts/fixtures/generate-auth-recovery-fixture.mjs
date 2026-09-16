// Reproducible generator for scripts/fixtures/auth-recovery-<version>.json(.gz).
//
//   node scripts/fixtures/generate-auth-recovery-fixture.mjs <git-ref> [repo-path] [--verify-only]
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
const ref = args[0];
if (!ref) {
  console.error('usage: generate-auth-recovery-fixture.mjs <git-ref> [repo-path] [--verify-only]');
  process.exit(2);
}
const repo = resolve(args[1] || repoRoot);
const git = (...gitArgs) => execFileSync('git', ['-C', repo, ...gitArgs], { maxBuffer: 64 * 1024 * 1024 });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const sourceCommit = git('rev-parse', `${ref}^{commit}`).toString('utf8').trim();
const files = {};
for (const name of FILES) {
  files[name] = git('show', `${sourceCommit}:extension/${name}`).toString('utf8').replace(/\r?\n/g, '\r\n');
}
const extensionVersion = JSON.parse(files['manifest.json']).version;
const archive = gzipSync(JSON.stringify({ files }), { level: 9 });
const receipt = {
  sourceCommit,
  extensionVersion,
  description: `Immutable ${extensionVersion} runtime scripts and manifest for same-ID cooperative-controller upgrade acceptance and red-on-old startup-recovery gating. Candidate supplies unchanged images/styles and a synthetic managed API fixture; no configuration or credentials included.`,
  files: Object.fromEntries(FILES.map((name) => [name, sha256(files[name])])),
  archiveSha256: sha256(archive),
};
const receiptPath = join(fixturesDir, `auth-recovery-${extensionVersion}.json`);
const archivePath = join(fixturesDir, `auth-recovery-${extensionVersion}.json.gz`);

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

writeFileSync(archivePath, archive);
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ extensionVersion, sourceCommit, archiveSha256: receipt.archiveSha256, receiptPath, archivePath }));
