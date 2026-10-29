import { randomUUID } from 'node:crypto';

// Fixture-only identity bridge. A native policy can replace a tab before
// Playwright receives the old page's close event; URL equality is insufficient.
// This helper never creates tabs, navigates pages, or changes extension policy.
export async function pageForNativeTab(worker, context, tabId, timeout = 15_000) {
  const nonce = randomUUID();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await worker.evaluate(async id => (await chrome.tabs.get(id)).status === 'complete', tabId);
    if (ready) {
      await worker.evaluate(async ({ id, nonce }) => chrome.scripting.executeScript({
        target: { tabId: id }, world: 'MAIN',
        func: value => { globalThis.__classpilotFixtureNativeTabNonce = value; }, args: [nonce],
      }), { id: tabId, nonce });
      for (const page of context.pages()) {
        if (page.isClosed()) continue;
        try {
          if (await page.evaluate(value => globalThis.__classpilotFixtureNativeTabNonce === value, nonce)) return page;
        } catch (error) {
          // Only identity lookup can ignore a vanished document. Callers still
          // fail if a subsequent actual navigation or assertion closes/errors.
          if (page.isClosed() || /Execution context was destroyed|Cannot find context with specified id/.test(String(error))) continue;
          throw error;
        }
      }
    }
    await new Promise(done => setTimeout(done, 80));
  }
  throw new Error(`Native tab ${tabId} did not reach its Playwright page`);
}
