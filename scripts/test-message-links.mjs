import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const extension = process.env.CLASSPILOT_EXTENSION_PATH ? resolve(process.env.CLASSPILOT_EXTENSION_PATH)
  : fileURLToPath(new URL('../extension/', import.meta.url));
const helperUrl = join(extension, 'message-links.js');
const context = vm.createContext({ URL });
if (existsSync(helperUrl)) vm.runInContext(readFileSync(helperUrl, 'utf8'), context);
const cases = JSON.parse(readFileSync(new URL('./fixtures/message-links.json', import.meta.url), 'utf8'));

test('message links implement the shared literal parsing contract without changing visible text', () => {
  const split = context.ClassPilotMessageLinks?.splitMessageLinks;
  assert.equal(typeof split, 'function', 'student messages need a safe shared URL tokenizer');
  for (const example of cases) {
    const parts = JSON.parse(JSON.stringify(split(example.text)));
    assert.equal(parts.map(part => part.text).join(''), example.text, example.name);
    assert.deepEqual(parts.filter(part => part.href !== null), example.links, example.name);
    assert.ok(parts.every(part => typeof part.text === 'string' && (part.href === null || typeof part.href === 'string')), example.name);
  }
});

test('missing and non-string values are empty while literal markup remains text', () => {
  const split = context.ClassPilotMessageLinks?.splitMessageLinks;
  assert.equal(typeof split, 'function', 'student messages need a safe shared URL tokenizer');
  for (const [value, expected] of [[null, ''], [undefined, ''], [27, ''], ['<script>alert(1)</script>', '<script>alert(1)</script>']]) {
    assert.equal(JSON.parse(JSON.stringify(split(value))).map(part => part.text).join(''), expected);
  }
});

test('message helper precedes content and popup consumers in normal and recovery injection', () => {
  const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
  const idle = manifest.content_scripts.find(entry => entry.js.includes('content.js')).js;
  assert.ok(idle.includes('message-links.js') && idle.indexOf('message-links.js') < idle.indexOf('content.js'));
  const worker = readFileSync(join(extension, 'service-worker.js'), 'utf8');
  const recovery = worker.match(/const PAGE_RECOVERY_FILES = Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1];
  assert.ok(recovery?.includes("'message-links.js'") && recovery.indexOf("'message-links.js'") < recovery.indexOf("'content.js'"));
  const popup = readFileSync(join(extension, 'popup.html'), 'utf8');
  assert.ok(popup.includes('src="message-links.js"') && popup.indexOf('src="message-links.js"') < popup.indexOf('src="popup.js"'));
});
