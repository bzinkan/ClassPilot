import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { resolve } from 'node:path';

const source = readFileSync(process.env.CLASSPILOT_EXTENSION_PATH
  ? resolve(process.env.CLASSPILOT_EXTENSION_PATH, 'poll-replay-core.js')
  : new URL('../extension/poll-replay-core.js', import.meta.url), 'utf8');
const load = () => { const context = vm.createContext({}); vm.runInContext(source, context); return context.ClassPilotPollReplayCore; };
const start = (core, state, order = 1, pollId = 'poll-a', contextKey = 'class-a') => core.apply(state, {
  action: 'start', contextKey, transientOrder: order, pollId, now: 100,
  poll: { pollId, expiresAt: 1000, receivedAt: 100, response: null },
});

test('duplicate after worker restart preserves first answer and original deadline', () => {
  let core = load();
  let state = start(core, { binding: 'exact-session', poll: null }).state;
  state = core.reserveAnswer(state, 'poll-a', 'class-a', { selectedOption: 1, textResponse: null }, 150);
  core = load();
  const duplicate = start(core, structuredClone(state));
  assert.equal(duplicate.newStart, false);
  assert.equal(duplicate.state.poll.response.selectedOption, 1);
  assert.equal(duplicate.state.poll.response.status, 'pending');
  assert.equal(duplicate.state.poll.expiresAt, 1000);
  const second = core.reserveAnswer(duplicate.state, 'poll-a', 'class-a', { selectedOption: 0 }, 160);
  assert.equal(second.poll.response.selectedOption, 1);
});

test('closed watermark survives expiry and prevents stale starts after restart', () => {
  const core = load();
  const state = start(core, { poll: null }).state;
  const closed = core.apply(state, { action: 'close', contextKey: 'class-a', transientOrder: 2, pollId: 'poll-a', now: 200 }).state;
  const restored = structuredClone({ ...closed, poll: null });
  assert.equal(start(load(), restored).state.poll, null);
  assert.equal(restored.pollCursors['class-a'].status, 'closed');
  assert.equal(start(core, restored, 3, 'poll-b').state.poll.pollId, 'poll-b');
});

test('old close cannot dismiss a newer poll and close matches its exact poll and context', () => {
  const core = load();
  const newer = start(core, start(core, { poll: null }).state, 3, 'poll-b').state;
  assert.equal(core.apply(newer, { action: 'close', contextKey: 'class-a', transientOrder: 2, pollId: 'poll-a', now: 200 }).state.poll.pollId, 'poll-b');
  assert.equal(core.apply(newer, { action: 'close', contextKey: 'class-b', transientOrder: 5, pollId: 'poll-b', now: 200 }).state.poll.pollId, 'poll-b');
  assert.equal(core.apply(newer, { action: 'close', contextKey: 'class-a', transientOrder: 6, pollId: 'poll-c', now: 200 }).state.poll, null,
    'A newer close fences older displayed polls when the intervening start was missed');
});

test('invalid ordering fails closed and an expired poll cannot reserve an answer', () => {
  const core = load();
  for (const order of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => core.apply({ poll: null }, { contextKey: 'class-a', pollId: 'poll-a',
      action: 'start', transientOrder: order }), /ordering metadata/);
  }
  assert.throws(() => core.reserveAnswer(start(core, { poll: null }).state, 'poll-a', 'class-a', {}, 1000), /no longer active/);
  assert.throws(() => core.reserveAnswer(start(core, { poll: null }).state, 'poll-a', 'class-b', {}, 200), /no longer active/);
});
