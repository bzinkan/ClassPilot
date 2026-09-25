// Older Chromium can publish the CDP worker target before evaluating its entry
// script. Target presence (or chrome.runtime.id) does not prove that production
// lexical declarations exist yet. This waits for declarations, not for restore
// completion, so startup and held-operation tests retain their real ordering.
export async function extensionWorkerDeclarationsReady(worker) {
  return worker.evaluate(() => {
    try {
      return typeof authStateRestorePromise?.then === 'function'
        && typeof classroomStateRestorePromise?.then === 'function';
    } catch { return false; }
  }).catch(() => false);
}

export async function waitForExtensionWorkerDeclarations(worker, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await extensionWorkerDeclarationsReady(worker)) return worker;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('The extension worker entry script did not initialize its restore declarations');
}
