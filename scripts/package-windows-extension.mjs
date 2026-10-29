import { createHash, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const development = process.argv.includes('--development');
const value = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const keyFile = value('public-keys');
if (!development && !keyFile) throw new Error('Release packaging requires approved Chrome and Edge public keys; development keys are not release identities.');
const keys = JSON.parse(readFileSync(keyFile ? resolve(keyFile) : join(root, 'fixtures/windows-extension-public-keys.json'), 'utf8'));
const version = value('version') || '3.0.3.1';
if (!/^\d+(?:\.\d+){0,3}$/.test(version)) throw new Error('Invalid extension version');
const output = resolve(root, 'artifacts', `windows-${development ? 'development' : 'candidate'}-${Date.now()}`);
const sourceDirty=Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim());
if(!development&&sourceDirty)throw new Error('Release candidate packaging requires a clean reviewed commit');
const base = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8'));
const tracked = execFileSync('git', ['ls-files', 'extension'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/);
const extra = ['windows-browser-channel.js', 'windows-worker-bridge.js'];
const files = [...new Set([...tracked, ...extra.map(file => `extension/${file}`)])];
const products = [];
for (const browserFamily of ['chrome', 'edge']) {
  const der = Buffer.from(keys[browserFamily] || '', 'base64');
  if (der.length < 100) throw new Error('Approved public key missing');
  const publicKey=createPublicKey({key:der,format:'der',type:'spki'});
  if(publicKey.asymmetricKeyType!=='rsa'||publicKey.asymmetricKeyDetails.modulusLength<2048)throw new Error('RSA2048+ public extension keys required');
  const digest = createHash('sha256').update(der).digest('hex').slice(0, 32);
  const extensionId = [...digest].map(hex => String.fromCharCode(97 + parseInt(hex, 16))).join('');
  const directory = join(output, browserFamily);
  mkdirSync(directory, { recursive: true });
  for (const file of files) {
    const name = relative(join(root, 'extension'), join(root, file));
    if (name.startsWith('..') || /(?:^|\/)(?:\.env|config\.js)$/.test(name.replaceAll('\\', '/'))) continue;
    const target = join(directory, name); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(root, file), target);
  }
  const manifest = { ...base, name: 'ClassPilot for Windows', version,
    description: 'School-managed Windows classroom monitoring. Requires the ClassPilot Windows session guard.', key: keys[browserFamily],
    permissions: [...new Set([...base.permissions.filter(p => !p.startsWith('enterprise.') && !['identity', 'identity.email'].includes(p)), 'nativeMessaging'])],
    incognito: 'not_allowed', action: { ...base.action, default_state: 'enabled', default_popup: 'windows-popup.html' } };
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const worker = readFileSync(join(directory, 'service-worker.js'), 'utf8');
  writeFileSync(join(directory, 'service-worker.js'), `globalThis.CLASSPILOT_WINDOWS_BUILD = Object.freeze(${JSON.stringify({ browserFamily, development, protocolVersion: 1 })});\n` + worker);
  writeFileSync(join(directory, 'windows-popup.html'), '<!doctype html><html><head><meta charset="utf-8"><title>ClassPilot Windows</title></head><body><h1>ClassPilot Windows</h1><p id="status">Checking the student session…</p><p>Sign in with your SchoolPilot PIN in the ClassPilot Windows app.</p><script src="windows-popup.js"></script></body></html>');
  writeFileSync(join(directory, 'windows-popup.js'), "chrome.runtime.sendMessage({type:'windows-browser-status'}).then(s=>{document.getElementById('status').textContent=s?.authorized?'Browser monitoring is connected.':'Browser monitoring needs Windows sign-in.';}).catch(()=>{document.getElementById('status').textContent='ClassPilot session guard is unavailable.';});\n");
  const names = readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => relative(directory, join(entry.parentPath, entry.name))).sort();
  const hashes = names.map(name => {
    return { path: name.replaceAll('\\', '/'), sha256: createHash('sha256').update(readFileSync(join(directory, name))).digest('hex') };
  });
  const zipPath = join(output, `${browserFamily}-${version}.zip`);
  if (process.platform === 'win32') {
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path ${quote(directory+'\\*')} -DestinationPath ${quote(zipPath)} -CompressionLevel Optimal`], { stdio: 'pipe' });
  }
  if(process.platform!=='win32')execFileSync('zip',['-q','-r',zipPath,'.'],{cwd:directory,stdio:'pipe'});
  products.push({ browserFamily, extensionId, origin: `chrome-extension://${extensionId}/`, directory, hashes, ...(existsSync(zipPath)?{zipPath,zipSha256:createHash('sha256').update(readFileSync(zipPath)).digest('hex')}:{}) });
}
const result = { schemaVersion: 1, version, development, pilotReady: false,
  blockers: development ? ['Development public keys; not an approved Store identity', 'Signing and managed-device installation not verified'] : ['Store publication and managed-device acceptance require separate authorization'],
  sourceDirty, sourceDigest: createHash('sha256').update(files.filter(file=>existsSync(join(root,file))).map(file=>file+'\0'+createHash('sha256').update(readFileSync(join(root,file))).digest('hex')).sort().join('\n')).digest('hex'),
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), products };
writeFileSync(join(output, 'package-manifest.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, version, development, products: products.map(({ browserFamily, extensionId, origin }) => ({ browserFamily, extensionId, origin })) }));
