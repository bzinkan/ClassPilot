import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync,readdirSync } from 'node:fs';
import { resolve,join,relative } from 'node:path';
const directory=resolve(process.argv.find(x=>x.startsWith('--artifact='))?.slice(11)||'');
const report=JSON.parse(readFileSync(join(directory,'package-manifest.json'),'utf8'));
assert.equal(report.schemaVersion,1);assert.equal(report.pilotReady,false);assert.match(report.sourceDigest,/^[a-f0-9]{64}$/);
assert.deepEqual(report.products.map(p=>p.browserFamily),['chrome','edge']);
for(const product of report.products){
  const root=join(directory,product.browserFamily),manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8'));
  assert.equal(manifest.version,report.version);assert.equal(manifest.incognito,'not_allowed');
  assert.ok(manifest.permissions.includes('nativeMessaging'));
  assert.ok(!manifest.permissions.some(p=>p.startsWith('enterprise.')||p.startsWith('identity')));
  assert.equal(manifest.action.default_popup,'windows-popup.html');
  const actual=readdirSync(root,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>relative(root,join(e.parentPath,e.name)).replaceAll('\\','/')).sort();
  assert.deepEqual(actual,product.hashes.map(h=>h.path).sort());
  for(const entry of product.hashes){
    assert.ok(!entry.path.startsWith('/')&&!entry.path.split('/').includes('..'));
    assert.ok(!/(?:^|\/)(?:config\.js|\.env(?:\..*)?)$|\.(?:pfx|p12|key)$/i.test(entry.path));
    assert.equal(createHash('sha256').update(readFileSync(join(root,entry.path))).digest('hex'),entry.sha256);
  }
  assert.equal(createHash('sha256').update(readFileSync(product.zipPath)).digest('hex'),product.zipSha256);
  const worker=readFileSync(join(root,'service-worker.js'),'utf8');
  assert.ok(worker.startsWith('globalThis.CLASSPILOT_WINDOWS_BUILD = Object.freeze('));
  assert.ok(worker.includes(`"browserFamily":"${product.browserFamily}"`));
  assert.ok(worker.includes('if (globalThis.CLASSPILOT_WINDOWS_BUILD)'));
}
console.log(`Windows package verification passed: ${report.products.length} browser ZIPs with complete file inventories; pilotReady=false`);
