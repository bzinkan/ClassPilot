// Windows transport only. The Chromebook build never enables this adapter.
(function (root) {
  'use strict';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const PREFIX = '/api/classpilot/windows/browser/';
  const RESPONSE_BYTES = 2 * 1024 * 1024;
  const ROUTES = [
    [/^\/api\/(?:device|classpilot\/device)\/heartbeat$/, 'heartbeat'],
    [/^\/api\/(?:extension|device|classpilot\/device)\/screenshot$/, 'screenshot'],
    [/^\/api\/(?:extension|classpilot\/device)\/command-acks$/, 'command-acks'],
  ];
  function refused(code = 'WINDOWS_AUTH_REQUIRED') { return Object.assign(new Error(code), { code }); }
  function deadline(expiresAt, serverTime, started, received, maximum = 45000) {
    const duration = Date.parse(expiresAt) - Date.parse(serverTime);
    return received + Math.max(0, Math.min(maximum, Number.isFinite(duration) ? duration : 0) - Math.max(0, received - started));
  }
  function route(path) {
    for (const [pattern, operation] of ROUTES) if (pattern.test(path)) return operation;
    return null;
  }
  function aborted(signal) { return signal.reason instanceof Error ? signal.reason : refused('WINDOWS_REQUEST_CANCELLED'); }
  function cancellable(promise, signal, late = () => {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const abort = () => { if (!settled) { settled = true; reject(aborted(signal)); } };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      Promise.resolve(promise).then(value => {
        signal.removeEventListener('abort', abort);
        if (settled) { late(value); return; }
        settled = true; resolve(value);
      }, error => {
        signal.removeEventListener('abort', abort);
        if (!settled) { settled = true; reject(error); }
      });
    });
  }
  function cancelBody(response) { void response?.body?.cancel().catch(() => {}); }
  /** Consume the entire decoded JSON body while the caller's HTTP deadline is
   * still armed. Return a local Response so worker json()/clone() never waits on
   * a network stream after headers have arrived. */
  async function boundedJson(response, signal, copyResponse = true) {
    let reader, bytes;
    const chunks = [];
    try {
      const length = response.headers.get('Content-Length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > RESPONSE_BYTES)) throw refused('WINDOWS_RESPONSE_TOO_LARGE');
      let size = 0;
      if (response.body) {
        reader = response.body.getReader();
        while (true) {
          const item = await cancellable(reader.read(), signal, late => late.value?.fill(0));
          if (item.done) break;
          size += item.value.byteLength;
          if (size > RESPONSE_BYTES) { item.value.fill(0); throw refused('WINDOWS_RESPONSE_TOO_LARGE'); }
          chunks.push(item.value);
        }
      }
      if (signal.aborted) throw aborted(signal);
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const empty = [204, 205, 304].includes(response.status);
      let value;
      if (!empty) {
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw refused('WINDOWS_RESPONSE_INVALID'); }
      }
      return { value, response: copyResponse ? new Response(empty ? null : bytes,
        { status: response.status, statusText: response.statusText, headers: response.headers }) : undefined };
    } finally {
      for (const chunk of chunks) chunk.fill(0);
      bytes?.fill(0);
      if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); }
      else cancelBody(response);
    }
  }
  function create(options) {
    const { runtime, storage, fetch: send, origin, browserFamily, capabilities, adopt, invalidate, frame } = options;
    const now = options.now || (() => performance.now());
    const timers = options.timers || { setTimeout: (fn,ms) => setTimeout(fn,ms), clearTimeout: id => clearTimeout(id) };
    if (!['chrome', 'edge'].includes(browserFamily)) throw refused('WINDOWS_BROWSER_UNSUPPORTED');
    let generation = 0, port = null, session = null, pending = new Map(), starting = null, expiry = null;
    let guardEpoch = '', guardEnd = 0, blockedEpoch = '', activeProfileId = '';
    const requests = new Set();
    let queuedFrames = [];
    function reset(reason, notify = true, disconnect = true) {
      if (session) session.studentToken = '';
      generation++; session = null; guardEpoch = ''; guardEnd = 0; queuedFrames = []; starting = null;
      activeProfileId = '';
      timers.clearTimeout(expiry);
      for (const entry of pending.values()) { timers.clearTimeout(entry.timer); entry.reject(refused(reason)); }
      pending.clear();
      for (const controller of requests) controller.abort(refused(reason));
      requests.clear();
      const retired = port; port = null;
      try { if(disconnect)retired?.disconnect(); } catch {}
      if (notify) void Promise.resolve(invalidate(reason)).catch(() => {});
    }
    function active(mine = generation) {
      let currentOrigin;
      try { currentOrigin = origin(); } catch { if (mine === generation && session) reset('WINDOWS_AUTH_REQUIRED'); throw refused(); }
      if (mine !== generation || !session || session.origin !== currentOrigin || !port || now() >= guardEnd || now() >= session.deadline) {
        if (mine === generation && session) reset('WINDOWS_AUTH_REQUIRED');
        throw refused();
      }
      return session;
    }
    function arm() {
      timers.clearTimeout(expiry);
      const end = Math.min(guardEnd, session?.deadline ?? guardEnd);
      expiry = timers.setTimeout(() => reset('WINDOWS_GUARD_EXPIRED'), Math.max(0, end - now()));
    }
    function status(value) {
      if (value.protocolVersion !== 1 || value.authorized !== true || !UUID.test(value.guardEpoch)
        || value.browserFamily !== browserFamily || !Number.isFinite(value.expiresInSeconds)
        || value.expiresInSeconds <= 0 || value.expiresInSeconds > 45) {
        reset('WINDOWS_GUARD_UNAVAILABLE'); return;
      }
      if (value.guardEpoch === blockedEpoch) { reset('WINDOWS_FRESH_PIN_REQUIRED'); return; }
      if (guardEpoch && value.guardEpoch !== guardEpoch) { reset('WINDOWS_GUARD_CHANGED'); return; }
      guardEpoch = value.guardEpoch; guardEnd = now() + value.expiresInSeconds * 1000;
      arm();
    }
    function native(type, data = {}) {
      if (!port) return Promise.reject(refused());
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = timers.setTimeout(() => { pending.delete(id); reject(refused('WINDOWS_HOST_TIMEOUT')); }, 5000);
        pending.set(id, { resolve, reject, timer });
        port.postMessage({ id, type, ...data });
      });
    }
    async function begin() {
      if (session) { active(); return session; }
      const mine = generation, pairedOrigin = origin();
      const stored = await storage.get(['windowsProfileId', 'windowsRetiredGuardEpoch']);
      if (mine !== generation || pairedOrigin !== origin()) throw refused();
      blockedEpoch = UUID.test(stored.windowsRetiredGuardEpoch) ? stored.windowsRetiredGuardEpoch : blockedEpoch;
      port = runtime.connectNative('net.classpilot.guard');
      const connected = port;
      port.onDisconnect.addListener(() => { void runtime.lastError; if (port === connected) reset('WINDOWS_HOST_DISCONNECTED'); });
      port.onMessage.addListener(value => {
        if (port !== connected || !value || typeof value !== 'object') return;
        const entry = pending.get(value.id);
        if (entry) { pending.delete(value.id); timers.clearTimeout(entry.timer); entry.resolve(value); }
        else if (value.type === 'status') status(value);
      });
      status(await native('status'));
      if (mine !== generation || !port) throw refused();
      const profileId = UUID.test(stored.windowsProfileId) ? stored.windowsProfileId : crypto.randomUUID();
      activeProfileId=profileId;
      if (profileId !== stored.windowsProfileId) await storage.set({ windowsProfileId: profileId });
      const challenge = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
      const proof = await native('pair', { profileId, challenge });
      if (mine !== generation || pairedOrigin !== origin() || !proof.proof || proof.browserFamily !== browserFamily) { proof.proof = ''; throw refused(); }
      const started = now();
      const controller = new AbortController(); requests.add(controller);
      const pairTimeout = timers.setTimeout(() => controller.abort(refused('WINDOWS_REQUEST_TIMEOUT')), 5000);
      let response, result;
      try { response = await cancellable(send(`${pairedOrigin}${PREFIX}pair`, { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proof: proof.proof, browserFamily, profileId, challenge,
          clientProtocolVersion: 3, capabilities: capabilities(), extensionVersion: runtime.getManifest().version }), signal: controller.signal }), controller.signal, cancelBody);
      result = (await boundedJson(response, controller.signal, false)).value;
      if (now() - started >= 5000) throw refused('WINDOWS_REQUEST_TIMEOUT');
      if (!response.ok) throw refused('WINDOWS_PAIR_REFUSED');
      if (mine !== generation || pairedOrigin !== origin() || !port || now() >= guardEnd || !result || !UUID.test(result.sourceRef)
        || !Number.isSafeInteger(result.bindingRevision) || result.bindingRevision <= 0
        || typeof result.studentToken !== 'string' || !result.studentToken.startsWith('cpw1.browser.')
        || result.browserFamily !== browserFamily || !Array.isArray(result.acceptedCapabilities)) throw refused('WINDOWS_PAIR_INVALID');
      session = Object.assign(result, { origin: pairedOrigin, profileId, guardEpoch, deadline: deadline(result.guardExpiresAt, result.serverTime, started, now()),
        absoluteDeadline: deadline(result.absoluteExpiresAt, result.serverTime, started, now(), 8 * 3600000) });
      } finally { proof.proof = ''; if (result && result !== session && typeof result === 'object') result.studentToken = '';
        timers.clearTimeout(pairTimeout); requests.delete(controller); }
      active(mine); await adopt(result, () => active(mine)); active(mine); arm();
      await options.ready?.(); active(mine);
      return session;
    }
    function start() {
      if (starting) return starting;
      if (session) { try { return Promise.resolve(active()); } catch (error) { return Promise.reject(error); } }
      if (!starting) {
        const mine = generation;
        const attempt = begin().catch(error => { if (mine === generation) reset(error.code || 'WINDOWS_PAIR_FAILED'); throw error; }).finally(() => { if (starting === attempt) starting = null; });
        starting = attempt;
      }
      return starting;
    }
    async function request(operation, init = {}) {
      if (!['heartbeat', 'screenshot', 'command-acks', 'action'].includes(operation)) throw refused('WINDOWS_OPERATION_UNSUPPORTED');
      if (!session) await start(); const current = active(), mine = generation;
      const controller = new AbortController(); requests.add(controller);
      const abort = () => controller.abort(refused('WINDOWS_REQUEST_CANCELLED')); init.signal?.addEventListener('abort', abort, { once: true });
      if (init.signal?.aborted) abort();
      const timeout = timers.setTimeout(() => controller.abort(refused('WINDOWS_REQUEST_TIMEOUT')), 5000), started = now();
      try {
        const input = init.body ? JSON.parse(init.body) : {};
        const remote = await cancellable(send(`${current.origin}${PREFIX}${operation}`, { ...init, method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
          signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${current.studentToken}` },
          body: JSON.stringify({ ...input, sourceRef: current.sourceRef, bindingRevision: current.bindingRevision }) }), controller.signal, cancelBody);
        const { response, value: result } = await boundedJson(remote, controller.signal);
        if (now() - started >= 5000) throw refused('WINDOWS_REQUEST_TIMEOUT');
        active(mine);
        if ([401, 403, 409].includes(response.status)) { reset('WINDOWS_BINDING_REFUSED'); return response; }
        if (operation === 'heartbeat' && response.ok) {
          active(mine);
          if (!result || typeof result !== 'object' || (result.messages !== undefined && !Array.isArray(result.messages))) throw refused('WINDOWS_RESPONSE_INVALID');
          const end = deadline(result.guardExpiresAt, result.serverTime, started, now());
          if (end <= now()) throw refused('WINDOWS_GUARD_EXPIRED');
          current.deadline = Math.min(end, current.absoluteDeadline); arm();
          for (const message of result.messages || []) queuedFrames.push({ message, generation: mine });
        }
        return response;
      } catch (error) {
        if (mine === generation && ['WINDOWS_RESPONSE_INVALID', 'WINDOWS_RESPONSE_TOO_LARGE', 'WINDOWS_REQUEST_TIMEOUT'].includes(error.code)) reset(error.code);
        throw error;
      } finally { timers.clearTimeout(timeout); requests.delete(controller); init.signal?.removeEventListener('abort', abort); }
    }
    function retire(reason, { suppressPairing = false, notifyBackend = false } = {}) {
      const current = session ? { origin: session.origin, studentToken: session.studentToken, sourceRef: session.sourceRef, bindingRevision: session.bindingRevision,
        profileId: session.profileId, guardEpoch: session.guardEpoch } : null;
      const profileId=current?.profileId||activeProfileId, epoch=current?.guardEpoch||guardEpoch;
      if (suppressPairing && guardEpoch) {
        blockedEpoch=guardEpoch;
        void storage.set({windowsRetiredGuardEpoch:guardEpoch}).catch(()=>{});
      }
      // The host clears its local guard before any server response is needed.
      let retained=false;
      if(suppressPairing && port && UUID.test(profileId) && UUID.test(epoch)) {
        const closing=port,id=crypto.randomUUID();
        const finish=()=>{try{closing.disconnect();}catch{}};
        const timeout=timers.setTimeout(finish,1000);
        closing.onMessage.addListener(value=>{if(value?.id===id){timers.clearTimeout(timeout);finish();}});
        try { closing.postMessage({id,type:'sign-out',profileId,expectedEpoch:epoch});retained=true; } catch {}
      }
      reset(reason,false,!retained);
      if(!notifyBackend || !current){if(current)current.studentToken='';return Promise.resolve(false);}
      const controller=new AbortController(),started=now(),timeout=timers.setTimeout(()=>controller.abort(refused('WINDOWS_REQUEST_TIMEOUT')),5000);
      requests.add(controller);
      return cancellable(send(`${current.origin}${PREFIX}action`,{method:'POST',credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal,
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${current.studentToken}`},
        body:JSON.stringify({operation:'sign-out',payload:{},sourceRef:current.sourceRef,bindingRevision:current.bindingRevision})}),controller.signal,cancelBody)
        .then(async response=>{await boundedJson(response,controller.signal,false);return now()-started<5000&&response.ok;}).catch(()=>false)
        .finally(()=>{current.studentToken='';requests.delete(controller);timers.clearTimeout(timeout);});
    }
    async function drain() {
      const frames = queuedFrames; queuedFrames = [];
      for (const entry of frames) { active(entry.generation); await frame(entry.message); }
    }
    return Object.freeze({ start, request, reset, retire, active, route, drain, capabilities: () => [...capabilities()], browserFamily });
  }
  root.ClassPilotWindowsChannel = Object.freeze({ create, deadline, route });
})(globalThis);
