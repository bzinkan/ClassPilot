import assert from 'node:assert/strict';
import { test } from 'node:test';
await import('../extension/school-website-policy.js');
const { matches, enforceExistingTabs } = globalThis.ClassPilotSchoolWebsitePolicy;

test('school website matching respects hostname boundaries', () => {
  assert.equal(matches('https://sub.example.com/page', ['example.com']), true);
  assert.equal(matches('https://example.com.evil.test', ['example.com']), false);
  assert.equal(matches('https://notexample.com', ['example.com']), false);
  assert.equal(matches('chrome://settings', ['example.com']), false);
});

test('existing blocked tabs close individually after a fresh URL read; unrelated navigation survives', async () => {
  const closed = [];
  const result = await enforceExistingTabs({
    rules: ['example.com'], assertCurrent() {},
    queryTabs: async () => [{ id: 1, url: 'https://example.com/a' }, { id: 2, url: 'https://example.com/a' }, { id: 3, url: 'https://safe.org' }],
    getTab: async (id) => ({ id, url: id === 2 ? 'https://safe.org' : 'https://example.com/a' }),
    closeTab: async (id) => { closed.push(id); },
  });
  assert.deepEqual(closed, [1]);
  assert.deepEqual(result, { status: 'applied', closedTabCount: 1 });
});

test('identity or policy loss between query and close prevents the side effect', async () => {
  let revoked = false;
  let closed = false;
  await assert.rejects(enforceExistingTabs({
    rules: ['example.com'],
    assertCurrent() { if (revoked) throw new Error('authority lost'); },
    queryTabs: async () => [{ id: 1, url: 'https://example.com' }],
    getTab: async () => { revoked = true; return { id: 1, url: 'https://example.com' }; },
    closeTab: async () => { closed = true; },
  }), /authority lost/);
  assert.equal(closed, false);
});

test('a failed existing-tab closure is reported as partial failure', async () => {
  const result = await enforceExistingTabs({
    rules: ['example.com'], assertCurrent() {},
    queryTabs: async () => [{ id: 1, url: 'https://example.com' }, { id: 2, url: 'https://example.com' }],
    getTab: async (id) => ({ id, url: 'https://example.com' }),
    closeTab: async (id) => { if (id === 2) throw new Error('Chrome rejected closure'); },
  });
  assert.deepEqual(result, { status: 'failed', closedTabCount: 1, errorCode: 'TAB_ENFORCEMENT_FAILED' });
});
