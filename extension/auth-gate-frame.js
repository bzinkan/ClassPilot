// ClassPilot secure student auth frame
//
// This extension-origin document owns every credential-bearing control. It is
// embedded under a closed shadow root on eligible pages, so host-page scripts
// cannot inspect form values or observe form input/key events. It accepts no
// auth state or credential data from the embedding page: all authoritative
// state, roster, and sign-in operations go directly through chrome.runtime.

(() => {
  'use strict';

  const root = document.getElementById('classpilot-auth-gate');
  if (!root) return;

  const AUTH_GATE_PHASES = new Set([
    'authenticated',
    'loading',
    'ready',
    'setup_required',
    'unavailable',
  ]);
  const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];
  const LOADING_POLL_MS = 500;
  const ROSTER_REFRESH_MIN_MS = 25_000;
  const ROSTER_REFRESH_MAX_MS = 35_000;
  const ROSTER_REFRESH_BACKOFF_MAX_MS = 5 * 60_000;
  const INSTANCE_NONCE = decodeURIComponent(window.location.hash.slice(1));

  let currentState = null;
  let latestRevision = -1;
  let stateRequestGeneration = 0;
  let rosterRequestGeneration = 0;
  let retryTimer = null;
  let loadingPollTimer = null;
  let authCommitPollTimer = null;
  let rosterRefreshTimer = null;
  let loginConfirmationGeneration = 0;
  let retryFallbackIndex = 0;
  let liveRosterLoaded = false;
  let rosterSnapshot = null;
  let lastFocusedControlId = '';
  let initialized = false;
  const embeddingOrigin = (() => {
    const ancestorOrigin = window.location.ancestorOrigins?.[0];
    if (typeof ancestorOrigin === 'string' && ancestorOrigin) return ancestorOrigin;
    try {
      return document.referrer ? new URL(document.referrer).origin : null;
    } catch (_error) {
      return null;
    }
  })();

  function notifyParent(type, details = {}) {
    if (!initialized || !embeddingOrigin || !/^[a-f0-9]{64}$/.test(INSTANCE_NONCE)) return;
    window.parent.postMessage({
      type,
      nonce: INSTANCE_NONCE,
      ...details,
    }, embeddingOrigin);
  }

  function authGatePhase(state = {}) {
    if (AUTH_GATE_PHASES.has(state.phase)) return state.phase;
    if (state.authRequired === false) return 'authenticated';
    if (state.setupRequired === true) return 'setup_required';
    return state.loginMethod === 'email_id' || state.loginMethod === 'name_pin'
      ? 'ready'
      : 'loading';
  }

  function authGateRevision(state = {}) {
    const revision = Number(state.revision);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
  }

  function rosterContextGeneration(state = {}) {
    const generation = Number(state.rosterContextGeneration);
    return Number.isSafeInteger(generation) && generation >= 0 ? generation : null;
  }

  function clearTimers() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    if (loadingPollTimer !== null) {
      clearTimeout(loadingPollTimer);
      loadingPollTimer = null;
    }
    if (authCommitPollTimer !== null) {
      clearTimeout(authCommitPollTimer);
      authCommitPollTimer = null;
    }
    clearRosterRefreshTimer();
  }

  function clearRosterRefreshTimer() {
    if (rosterRefreshTimer !== null) {
      clearTimeout(rosterRefreshTimer);
      rosterRefreshTimer = null;
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function icon(name) {
    const paths = {
      plane: '<path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path>',
      shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"></path><path d="m9 12 2 2 4-4"></path>',
      mail: '<rect width="20" height="16" x="2" y="4" rx="2"></rect><path d="m22 7-10 6L2 7"></path>',
      badge: '<rect width="18" height="18" x="3" y="3" rx="3"></rect><path d="M8 9h8M8 13h5"></path>',
      graduation: '<path d="m2 10 10-5 10 5-10 5Z"></path><path d="M6 12v5c3 2 9 2 12 0v-5"></path>',
      user: '<circle cx="12" cy="8" r="4"></circle><path d="M4 22a8 8 0 0 1 16 0"></path>',
      lock: '<rect width="18" height="12" x="3" y="10" rx="2"></rect><path d="M7 10V7a5 5 0 0 1 10 0v3"></path>',
    };
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.shield}</svg>`;
  }

  function shell(title, subtitle, body, options = {}) {
    return `
      <section class="classpilot-auth-panel" role="dialog" aria-modal="true" aria-labelledby="classpilot-auth-title" aria-describedby="classpilot-auth-subtitle" ${options.busy ? 'aria-busy="true"' : ''} tabindex="-1">
        <aside class="classpilot-auth-side" aria-hidden="true">
          <div>
            <div class="classpilot-auth-brand">
              <span class="classpilot-auth-logo">${icon('plane')}</span>
              <span>ClassPilot</span>
            </div>
            <div class="classpilot-auth-promise">Safe.<span>Focused.</span>Ready to learn.</div>
            <p class="classpilot-auth-side-copy">ClassPilot helps your school keep browsing safe, on-task, and distraction-free.</p>
          </div>
          <div class="classpilot-auth-safe-note">${icon('shield')} Protected student session</div>
        </aside>
        <div class="classpilot-auth-main">
          <div class="classpilot-auth-main-inner">
            <p class="classpilot-auth-eyebrow">Shared Chromebook</p>
            <h1 id="classpilot-auth-title">${escapeHtml(title)}</h1>
            <p class="classpilot-auth-subtitle" id="classpilot-auth-subtitle">${escapeHtml(subtitle)}</p>
            <div class="classpilot-auth-divider"></div>
            <div class="classpilot-auth-error" id="classpilot-auth-error" role="alert" aria-live="assertive"></div>
            ${body}
            <div class="classpilot-auth-footnote">${icon('shield')}<span>Shared Chromebook sign-in</span></div>
          </div>
        </div>
      </section>
    `;
  }

  function disabledEmailPreview() {
    return `
      <form class="classpilot-auth-form" aria-disabled="true">
        ${fieldMarkup('mail', 'School email', '<input type="email" placeholder="student@school.edu" disabled>')}
        ${fieldMarkup('badge', 'Student ID Number', '<input type="text" placeholder="Student ID" disabled>')}
        <button class="classpilot-auth-button" type="button" disabled>Sign In</button>
      </form>
    `;
  }

  function disabledPinPreview() {
    return `
      <form class="classpilot-auth-form" aria-disabled="true">
        ${fieldMarkup('graduation', 'Grade', '<select disabled><option>Waiting for ClassPilot…</option></select>')}
        <div class="classpilot-auth-roster-note">Waiting for live roster access…</div>
        ${fieldMarkup('user', 'Student', '<select disabled><option>Waiting for ClassPilot…</option></select>', 'classpilot-auth-field--student')}
        ${fieldMarkup('lock', '4-digit PIN', '<input type="text" placeholder="Enter your 4-digit PIN" disabled>', 'classpilot-auth-field--pin')}
        <button class="classpilot-auth-button" type="button" disabled>Sign In</button>
      </form>
    `;
  }

  function fieldMarkup(iconName, label, control, className = '') {
    return `
      <div class="classpilot-auth-field ${className}">
        <label><span class="classpilot-auth-field-icon">${icon(iconName)}</span><span>${escapeHtml(label)}</span></label>
        ${control}
      </div>
    `;
  }

  function loadingMarkup(state = {}) {
    const preview = state.loginMethod === 'email_id' ? disabledEmailPreview() : disabledPinPreview();
    return `
      <div class="classpilot-auth-state-card" role="status">
        <span class="classpilot-auth-spinner" aria-hidden="true"></span>
        <span><strong>Verifying live school settings</strong>Sign-in controls unlock only after ClassPilot reconnects to your school.</span>
      </div>
      <div style="margin-top:16px;opacity:.58" aria-hidden="true">${preview}</div>
    `;
  }

  function unavailableMarkup(state = {}) {
    const retryAt = Number(state.retryAt);
    const retryMessage = Number.isFinite(retryAt) && retryAt > Date.now()
      ? 'ClassPilot will retry automatically. You can also retry now.'
      : 'Use Retry now after checking the Chromebook’s connection.';
    return `
      <div class="classpilot-auth-state-card" role="status">
        <span class="classpilot-auth-state-icon">${icon('shield')}</span>
        <span><strong>Your browsing is still protected</strong>ClassPilot could not reach the live sign-in service. Cached information cannot be used to sign in.</span>
      </div>
      <button class="classpilot-auth-retry" id="classpilot-auth-retry" type="button">Retry now</button>
      <div class="classpilot-auth-retry-status" id="classpilot-auth-retry-status" aria-live="polite">${escapeHtml(retryMessage)}</div>
    `;
  }

  function setupMarkup() {
    return `
      <div class="classpilot-auth-state-card classpilot-auth-roster-note" role="status">
        <span class="classpilot-auth-state-icon">${icon('shield')}</span>
        <span><strong>School setup is required</strong>Ask a teacher or administrator to finish this Chromebook’s managed ClassPilot setup.</span>
      </div>
    `;
  }

  function emailMarkup() {
    return `
      <form class="classpilot-auth-form" id="classpilot-auth-email-form">
        <div class="classpilot-auth-field">
          <label for="classpilot-auth-email"><span class="classpilot-auth-field-icon">${icon('mail')}</span><span>School email</span></label>
          <input id="classpilot-auth-email" name="studentEmail" type="email" autocomplete="username" spellcheck="false" placeholder="student@school.edu" required>
        </div>
        <div class="classpilot-auth-field">
          <label for="classpilot-auth-student-id"><span class="classpilot-auth-field-icon">${icon('badge')}</span><span>Student ID Number</span></label>
          <input id="classpilot-auth-student-id" name="studentIdNumber" type="text" autocomplete="off" spellcheck="false" placeholder="Student ID" required>
        </div>
        <button class="classpilot-auth-button" id="classpilot-auth-email-submit" type="submit">Sign In</button>
      </form>
    `;
  }

  function pinMarkup() {
    return `
      <form class="classpilot-auth-form" id="classpilot-auth-pin-form">
        <div class="classpilot-auth-field">
          <label for="classpilot-auth-grade"><span class="classpilot-auth-field-icon">${icon('graduation')}</span><span>Grade</span></label>
          <select id="classpilot-auth-grade" name="gradeLevel" disabled required><option value="">Loading grades…</option></select>
        </div>
        <div class="classpilot-auth-roster-controls">
          <div class="classpilot-auth-roster-note" id="classpilot-auth-roster-status" aria-live="polite"></div>
          <button class="classpilot-auth-refresh-names" id="classpilot-auth-roster-refresh" type="button" disabled>Refresh names</button>
        </div>
        <div class="classpilot-auth-field classpilot-auth-field--student">
          <label for="classpilot-auth-student"><span class="classpilot-auth-field-icon">${icon('user')}</span><span>Student</span></label>
          <select id="classpilot-auth-student" name="studentId" disabled required><option value="">Select a grade first…</option></select>
        </div>
        <div class="classpilot-auth-field classpilot-auth-field--pin">
          <label for="classpilot-auth-pin"><span class="classpilot-auth-field-icon">${icon('lock')}</span><span>4-digit PIN</span></label>
          <input id="classpilot-auth-pin" name="pin" inputmode="numeric" maxlength="4" autocomplete="off" spellcheck="false" placeholder="Enter your 4-digit PIN" required>
        </div>
        <button class="classpilot-auth-button" id="classpilot-auth-pin-submit" type="submit" disabled>Sign In</button>
      </form>
    `;
  }

  function kioskMarkup(state = {}) {
    return safeKioskUrl(state.kioskUrl)
      ? `<button class="classpilot-auth-kiosk-button" id="classpilot-auth-kiosk-launch" type="button">${icon('badge')} Use as PassPilot hall-pass kiosk</button>`
      : '';
  }

  function safeKioskUrl(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
    } catch (_error) {
      return null;
    }
  }

  function render(state = {}) {
    clearTimers();
    loginConfirmationGeneration += 1;
    rosterRequestGeneration += 1;
    liveRosterLoaded = false;
    rosterSnapshot = null;

    const phase = authGatePhase(state);
    root.dataset.classpilotAuthPhase = phase;
    currentState = { ...state, phase };
    notifyParent('CLASSPILOT_AUTH_FRAME_PHASE', { phase });

    if (phase === 'authenticated') {
      root.innerHTML = shell(
        'Sign-in complete',
        'Opening your protected student session…',
        loadingMarkup({}),
        { busy: true },
      );
      return;
    }

    if (phase === 'loading') {
      root.innerHTML = shell(
        'Connecting to ClassPilot…',
        'Checking your school’s sign-in settings. Browsing stays locked until ClassPilot is ready.',
        loadingMarkup(state),
        { busy: true },
      );
      installFocusTrap();
      scheduleLoadingPoll();
      return;
    }

    if (phase === 'unavailable') {
      root.innerHTML = shell(
        'ClassPilot can’t connect right now',
        'Browsing stays locked until ClassPilot reconnects. Check the connection, then try again.',
        unavailableMarkup(state),
      );
      document.getElementById('classpilot-auth-retry')?.addEventListener('click', () => requestRefresh(true));
      installFocusTrap('#classpilot-auth-retry');
      scheduleUnavailableRetry(state);
      return;
    }

    if (phase === 'setup_required') {
      root.innerHTML = shell(
        'Ask your teacher to set up this Chromebook',
        'This Chromebook needs the school setup key and Shared Chromebook Sign-In enabled before browsing can start.',
        setupMarkup(),
      );
      installFocusTrap();
      return;
    }

    const loginMethod = state.loginMethod === 'email_id' ? 'email_id' : 'name_pin';
    const subtitle = loginMethod === 'name_pin'
      ? 'Choose your grade and name, then enter your 4-digit PIN.'
      : 'Enter your school email and student ID to continue.';
    const form = loginMethod === 'name_pin' ? pinMarkup() : emailMarkup();
    root.innerHTML = shell(
      'Sign in to this Chromebook',
      subtitle,
      `${form}${kioskMarkup(state)}`,
    );
    retryFallbackIndex = 0;
    attachReadyHandlers(currentState);
    installFocusTrap(loginMethod === 'name_pin' ? '#classpilot-auth-grade' : '#classpilot-auth-email');
  }

  function applyState(state = {}) {
    if (!state || typeof state !== 'object') {
      render({ phase: 'loading', authRequired: true });
      return;
    }
    const revision = authGateRevision(state);
    if (revision !== null && revision < latestRevision) return;
    if (revision !== null) latestRevision = Math.max(latestRevision, revision);

    const nextPhase = authGatePhase(state);
    const currentPhase = authGatePhase(currentState || {});
    const sameReadyForm = nextPhase === 'ready' && currentPhase === 'ready' &&
      (state.loginMethod === 'email_id' ? 'email_id' : 'name_pin') ===
        (currentState?.loginMethod === 'email_id' ? 'email_id' : 'name_pin') &&
      rosterContextGeneration(state) === rosterContextGeneration(currentState || {}) &&
      safeKioskUrl(state.kioskUrl) === safeKioskUrl(currentState?.kioskUrl);
    if (sameReadyForm) {
      // Keep partially entered values and focus when a duplicate/newer ready
      // state arrives. A failed server login is rendered inline, not by
      // replacing the credential controls.
      currentState = { ...state, phase: nextPhase };
      return;
    }
    render({ ...state, phase: nextPhase });
  }

  function scheduleLoadingPoll() {
    loadingPollTimer = setTimeout(() => {
      loadingPollTimer = null;
      requestLatestState();
    }, LOADING_POLL_MS);
  }

  function nextRetryDelay() {
    const delay = RETRY_DELAYS_MS[Math.min(retryFallbackIndex, RETRY_DELAYS_MS.length - 1)];
    retryFallbackIndex += 1;
    return delay;
  }

  function scheduleUnavailableRetry(state = {}) {
    const retryAt = Number(state.retryAt);
    const delay = Number.isFinite(retryAt) && retryAt > Date.now()
      ? Math.max(0, retryAt - Date.now())
      : nextRetryDelay();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      requestRefresh(false);
    }, delay);
  }

  function requestLatestState() {
    const generation = ++stateRequestGeneration;
    chrome.runtime.sendMessage({ type: 'get-auth-state' }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (generation !== stateRequestGeneration) return;
      if (runtimeError || !response?.state) {
        applyState({
          phase: 'unavailable',
          authRequired: true,
          retryAt: Date.now() + nextRetryDelay(),
        });
        return;
      }
      applyState(response.state);
    });
  }

  function requestRefresh(userInitiated) {
    clearTimers();
    const retryButton = document.getElementById('classpilot-auth-retry');
    const retryStatus = document.getElementById('classpilot-auth-retry-status');
    if (retryButton) {
      retryButton.disabled = true;
      retryButton.textContent = 'Connecting…';
      retryButton.setAttribute('aria-busy', 'true');
    }
    if (retryStatus) retryStatus.textContent = 'Checking the live ClassPilot sign-in service…';

    const generation = ++stateRequestGeneration;
    const message = {
      type: 'refresh-auth-state',
      reason: userInitiated ? 'user' : 'page_timer',
    };
    if (latestRevision >= 0) message.revision = latestRevision;
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (generation !== stateRequestGeneration) return;
      if (response?.state) {
        applyState(response.state);
        return;
      }
      applyState({
        ...(currentState || {}),
        phase: 'unavailable',
        authRequired: true,
        retryAt: Date.now() + nextRetryDelay(),
        error: response?.error || runtimeError?.message,
      });
    });
  }

  function attachReadyHandlers(state) {
    document.getElementById('classpilot-auth-email-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      submitLogin({
        mode: 'email_id',
        studentEmail: document.getElementById('classpilot-auth-email')?.value || '',
        studentIdNumber: document.getElementById('classpilot-auth-student-id')?.value || '',
      }, event.submitter);
    });

    const pinForm = document.getElementById('classpilot-auth-pin-form');
    if (pinForm) {
      document.getElementById('classpilot-auth-grade')?.addEventListener('change', () => {
        rosterSnapshot = null;
        clearRosterRefreshTimer();
        loadRoster();
      });
      document.getElementById('classpilot-auth-student')?.addEventListener('change', updatePinSubmitState);
      document.getElementById('classpilot-auth-roster-refresh')?.addEventListener('click', () => {
        refreshRosterOrGrades({ forceRefresh: true });
      });
      const pinInput = document.getElementById('classpilot-auth-pin');
      pinInput?.addEventListener('input', () => {
        pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 4);
        updatePinSubmitState();
      });
      pinForm.addEventListener('submit', (event) => {
        event.preventDefault();
        submitLogin({
          mode: 'pin',
          studentId: document.getElementById('classpilot-auth-student')?.value || '',
          pin: pinInput?.value || '',
        }, event.submitter);
      });
      loadGrades();
    }

    const kioskUrl = safeKioskUrl(state.kioskUrl);
    if (kioskUrl) {
      document.getElementById('classpilot-auth-kiosk-launch')?.addEventListener('click', () => {
        const button = document.getElementById('classpilot-auth-kiosk-launch');
        if (button) button.disabled = true;
        chrome.runtime.sendMessage({ type: 'request-kiosk-launch' }, (response) => {
          if (button) button.disabled = false;
          const launchUrl = safeKioskUrl(
            !chrome.runtime.lastError && response?.success ? response.url : kioskUrl,
          );
          if (launchUrl) {
            // Ticket continuity is carried only in the fragment; the kiosk
            // removes it immediately after POST redemption.
            window.open(launchUrl, '_top');
          } else {
            setError('PassPilot kiosk is unavailable. Please try again.');
          }
        });
      });
    }
  }

  function setError(message) {
    const error = document.getElementById('classpilot-auth-error');
    if (!error) return;
    error.textContent = message || '';
    error.style.display = message ? 'block' : 'none';
  }

  function loadGrades(options = {}) {
    const gradeSelect = document.getElementById('classpilot-auth-grade');
    const studentSelect = document.getElementById('classpilot-auth-student');
    const status = document.getElementById('classpilot-auth-roster-status');
    const submit = document.getElementById('classpilot-auth-pin-submit');
    const refreshButton = document.getElementById('classpilot-auth-roster-refresh');
    if (!gradeSelect || !studentSelect || !status || !submit) return;

    clearRosterRefreshTimer();
    liveRosterLoaded = false;
    rosterSnapshot = null;
    const generation = ++rosterRequestGeneration;
    const preserveControls = options.background === true || options.forceRefresh === true;
    const previousGrade = gradeSelect.value;
    const focusedControl = preserveControls && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setRosterStatus(preserveControls ? 'Refreshing grades…' : 'Loading grades…');
    status.setAttribute('aria-busy', 'true');
    if (!preserveControls) {
      gradeSelect.replaceChildren(new Option('Loading grades…', ''));
      gradeSelect.disabled = true;
      studentSelect.replaceChildren(new Option('Select a grade first…', ''));
    }
    studentSelect.disabled = true;
    submit.disabled = true;
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.textContent = 'Refreshing…';
      refreshButton.setAttribute('aria-busy', 'true');
    }

    chrome.runtime.sendMessage({
      type: 'get-login-roster',
      ...(options.forceRefresh === true ? { forceRefresh: true } : {}),
    }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (generation !== rosterRequestGeneration || !status.isConnected) return;
      status.setAttribute('aria-busy', 'false');
      if (refreshButton) {
        refreshButton.disabled = false;
        refreshButton.textContent = 'Refresh names';
        refreshButton.setAttribute('aria-busy', 'false');
      }
      if (runtimeError || !response?.success) {
        handleRosterFailure(response, runtimeError, 'Could not load roster grades.');
        if (authGatePhase(currentState || {}) === 'ready') {
          scheduleRosterRefresh(response?.refreshAfterMs);
        }
        restoreRosterFocus(focusedControl);
        return;
      }

      const grades = Array.isArray(response.grades)
        ? response.grades.filter((grade) => grade && grade.value !== undefined && grade.value !== null && String(grade.value))
        : [];
      gradeSelect.replaceChildren(new Option('Select your grade', ''));
      for (const grade of grades) {
        gradeSelect.add(new Option(String(grade.label || `Grade ${grade.value}`), String(grade.value)));
      }
      if (!grades.length) {
        setRosterStatus(
          response.cached === true && response.warning
            ? 'No roster grades are currently available. Names may be out of date; ClassPilot will try again automatically.'
            : 'No roster grades are currently available.',
          response.cached === true && Boolean(response.warning),
        );
        gradeSelect.replaceChildren(new Option('No grades available', ''));
        gradeSelect.disabled = true;
        studentSelect.replaceChildren(new Option('Select a grade first…', ''));
        studentSelect.disabled = true;
        submit.disabled = true;
        scheduleRosterRefresh(response.refreshAfterMs);
        restoreRosterFocus(focusedControl);
        return;
      }

      setRosterStatus('');
      gradeSelect.disabled = false;
      if (previousGrade && grades.some((grade) => String(grade.value) === previousGrade)) {
        gradeSelect.value = previousGrade;
      } else if (grades.length === 1) {
        gradeSelect.value = String(grades[0].value);
      }
      restoreRosterFocus(focusedControl);
      if (gradeSelect.value) {
        loadRoster();
      }
    });
  }

  function nextRosterRefreshDelay(refreshAfterMs) {
    const hintedDelay = Number(refreshAfterMs);
    if (Number.isFinite(hintedDelay) && hintedDelay > 0) {
      return Math.min(ROSTER_REFRESH_BACKOFF_MAX_MS, Math.max(5_000, hintedDelay));
    }
    return ROSTER_REFRESH_MIN_MS + Math.floor(
      Math.random() * (ROSTER_REFRESH_MAX_MS - ROSTER_REFRESH_MIN_MS + 1),
    );
  }

  function scheduleRosterRefresh(refreshAfterMs) {
    clearRosterRefreshTimer();
    const gradeSelect = document.getElementById('classpilot-auth-grade');
    if (!initialized || authGatePhase(currentState || {}) !== 'ready' ||
        currentState?.loginMethod === 'email_id' || document.visibilityState === 'hidden' ||
        !gradeSelect) {
      return;
    }
    rosterRefreshTimer = setTimeout(() => {
      rosterRefreshTimer = null;
      refreshRosterOrGrades({ background: true });
    }, nextRosterRefreshDelay(refreshAfterMs));
  }

  function restoreRosterFocus(control) {
    if (!control?.isConnected || control.disabled || document.activeElement === control) return;
    control.focus({ preventScroll: true });
  }

  function refreshRosterOrGrades(options = {}) {
    const gradeSelect = document.getElementById('classpilot-auth-grade');
    if (!gradeSelect) return;
    if (gradeSelect.value) loadRoster(options);
    else loadGrades(options);
  }

  function setRosterStatus(message, warning = false) {
    const status = document.getElementById('classpilot-auth-roster-status');
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('classpilot-auth-roster-note--warning', warning);
  }

  function hasCurrentRosterSnapshot(gradeLevel) {
    return rosterSnapshot?.gradeLevel === gradeLevel && Array.isArray(rosterSnapshot.students);
  }

  function showCachedRosterWarning() {
    setRosterStatus('Names may be out of date. ClassPilot will try again automatically.', true);
  }

  function loadRoster(options = {}) {
    const gradeSelect = document.getElementById('classpilot-auth-grade');
    const studentSelect = document.getElementById('classpilot-auth-student');
    const status = document.getElementById('classpilot-auth-roster-status');
    const submit = document.getElementById('classpilot-auth-pin-submit');
    const refreshButton = document.getElementById('classpilot-auth-roster-refresh');
    const selectedGrade = gradeSelect?.value || '';
    if (!gradeSelect || !studentSelect || !status || !submit) return;

    clearRosterRefreshTimer();
    const hasSnapshot = hasCurrentRosterSnapshot(selectedGrade);
    liveRosterLoaded = hasSnapshot;
    const generation = ++rosterRequestGeneration;
    if (!selectedGrade) {
      rosterSnapshot = null;
      setRosterStatus('');
      status.setAttribute('aria-busy', 'false');
      studentSelect.replaceChildren(new Option('Select a grade first…', ''));
      studentSelect.disabled = true;
      submit.disabled = true;
      if (refreshButton) {
        refreshButton.disabled = false;
        refreshButton.textContent = 'Refresh names';
        refreshButton.setAttribute('aria-busy', 'false');
      }
      scheduleRosterRefresh();
      return;
    }

    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.textContent = 'Refreshing…';
      refreshButton.setAttribute('aria-busy', 'true');
    }
    setRosterStatus(hasSnapshot ? 'Refreshing names…' : 'Loading roster…');
    status.setAttribute('aria-busy', 'true');
    if (!hasSnapshot) {
      studentSelect.replaceChildren(new Option('Loading students…', ''));
      studentSelect.disabled = true;
      submit.disabled = true;
    }
    chrome.runtime.sendMessage({
      type: 'get-login-roster',
      gradeLevel: selectedGrade,
      ...(options.forceRefresh === true ? { forceRefresh: true } : {}),
    }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (generation !== rosterRequestGeneration || !status.isConnected || gradeSelect.value !== selectedGrade) return;
      status.setAttribute('aria-busy', 'false');
      if (refreshButton) {
        refreshButton.disabled = false;
        refreshButton.textContent = 'Refresh names';
        refreshButton.setAttribute('aria-busy', 'false');
      }
      if (runtimeError || !response?.success) {
        if (response?.phase === 'setup_required') {
          handleRosterFailure(response, runtimeError, 'Could not load the classroom roster.');
          return;
        }
        if (hasCurrentRosterSnapshot(selectedGrade)) {
          showCachedRosterWarning();
          updatePinSubmitState();
          scheduleRosterRefresh(response?.refreshAfterMs);
          return;
        }
        handleRosterFailure(response, runtimeError, 'Could not load the classroom roster.');
        scheduleRosterRefresh(response?.refreshAfterMs);
        return;
      }

      const students = Array.isArray(response.students)
        ? response.students.filter((student) => student && student.id)
        : [];
      const previousStudentId = studentSelect.value;
      rosterSnapshot = { gradeLevel: selectedGrade, students };
      liveRosterLoaded = true;
      studentSelect.replaceChildren(new Option('Select your name…', ''));
      for (const student of students) {
        const label = `${student.name || 'Unknown'}${student.reclaimable === true ? ' — Resume on this Chromebook' : ''}${student.hasPin ? '' : ' (PIN missing)'}`;
        const option = new Option(label, String(student.id));
        option.disabled = student.hasPin !== true;
        studentSelect.add(option);
      }
      if (!students.length) {
        if (response.cached === true && response.warning) {
          setRosterStatus(
            'No students are currently available. Names may be out of date; ClassPilot will try again automatically.',
            true,
          );
        } else {
          setRosterStatus('No students are currently available.');
        }
        studentSelect.replaceChildren(new Option('No students available', ''));
        studentSelect.disabled = true;
        submit.disabled = true;
        scheduleRosterRefresh(response.refreshAfterMs);
        return;
      }

      studentSelect.disabled = false;
      if (students.some((student) => String(student.id) === previousStudentId)) {
        studentSelect.value = previousStudentId;
      }
      if (response.cached === true && response.warning) showCachedRosterWarning();
      else setRosterStatus('');
      updatePinSubmitState();
      scheduleRosterRefresh(response.refreshAfterMs);
    });
  }

  function handleRosterFailure(response, runtimeError, fallbackMessage) {
    const failurePhase = response?.phase === 'setup_required'
      ? 'setup_required'
      : response?.phase === 'unavailable' || runtimeError
        ? 'unavailable'
        : null;
    if (failurePhase) {
      applyState({
        ...(currentState || {}),
        phase: failurePhase,
        authRequired: true,
        setupRequired: failurePhase === 'setup_required',
        retryAt: failurePhase === 'unavailable' ? Date.now() + 2_000 : null,
      });
      return;
    }
    const status = document.getElementById('classpilot-auth-roster-status');
    if (status) status.textContent = response?.error || fallbackMessage;
  }

  function updatePinSubmitState() {
    const studentSelect = document.getElementById('classpilot-auth-student');
    const pinInput = document.getElementById('classpilot-auth-pin');
    const submit = document.getElementById('classpilot-auth-pin-submit');
    if (!studentSelect || !pinInput || !submit) return;
    const selectedStudent = studentSelect.selectedOptions?.[0];
    submit.disabled = !liveRosterLoaded || studentSelect.disabled ||
      !selectedStudent?.value || selectedStudent.disabled || !/^\d{4}$/.test(pinInput.value);
  }

  function submitLogin(payload, submitButton) {
    setError('');
    const submit = submitButton || document.getElementById(
      payload.mode === 'pin' ? 'classpilot-auth-pin-submit' : 'classpilot-auth-email-submit',
    );
    if (submit) {
      submit.disabled = true;
      submit.textContent = 'Signing in…';
      submit.setAttribute('aria-busy', 'true');
    }

    const confirmationGeneration = ++loginConfirmationGeneration;
    scheduleCommittedAuthConfirmation(confirmationGeneration, Date.now());
    chrome.runtime.sendMessage({ type: 'manual-student-login', payload }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (confirmationGeneration !== loginConfirmationGeneration) return;
      if (runtimeError || !response?.success) {
        loginConfirmationGeneration += 1;
        if (authCommitPollTimer !== null) {
          clearTimeout(authCommitPollTimer);
          authCommitPollTimer = null;
        }
        setError(response?.error || 'Invalid student credentials');
        if (submit) {
          submit.textContent = 'Sign In';
          submit.setAttribute('aria-busy', 'false');
          if (payload.mode === 'pin') updatePinSubmitState();
          else submit.disabled = false;
        }
        const retryField = document.getElementById(
          payload.mode === 'pin' ? 'classpilot-auth-pin' : 'classpilot-auth-email',
        );
        retryField?.focus({ preventScroll: true });
        retryField?.select?.();
        return;
      }

      for (const id of ['classpilot-auth-email', 'classpilot-auth-student-id', 'classpilot-auth-pin']) {
        const input = document.getElementById(id);
        if (input) input.value = '';
      }
      applyState({ phase: 'authenticated', authRequired: false });
    });
  }

  function scheduleCommittedAuthConfirmation(generation, startedAt) {
    if (generation !== loginConfirmationGeneration) return;
    authCommitPollTimer = setTimeout(() => {
      authCommitPollTimer = null;
      chrome.runtime.sendMessage({ type: 'get-auth-state' }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (generation !== loginConfirmationGeneration) return;
        if (!runtimeError && response?.state &&
            (response.state.authRequired === false || authGatePhase(response.state) === 'authenticated')) {
          // get-auth-state is a fresh, direct worker read. It becomes
          // authoritative as soon as the local student session is committed,
          // even if noncritical post-login initialization is still running.
          for (const id of ['classpilot-auth-email', 'classpilot-auth-student-id', 'classpilot-auth-pin']) {
            const input = document.getElementById(id);
            if (input) input.value = '';
          }
          render({ ...response.state, phase: 'authenticated', authRequired: false });
          return;
        }
        if (Date.now() - startedAt < 15_000) {
          scheduleCommittedAuthConfirmation(generation, startedAt);
        }
      });
    }, 250);
  }

  function installFocusTrap(preferredSelector) {
    const panel = document.querySelector('.classpilot-auth-panel');
    if (!panel) return;
    const focusableSelector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    panel.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const focusable = Array.from(panel.querySelectorAll(focusableSelector))
        .filter((element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true');
      if (!focusable.length) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    });
    requestAnimationFrame(() => {
      const preferred = preferredSelector ? document.querySelector(preferredSelector) : null;
      (preferred && !preferred.disabled ? preferred : panel).focus({ preventScroll: true });
    });
  }

  function restoreFrameFocus() {
    const active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement) return;
    const remembered = lastFocusedControlId
      ? document.getElementById(lastFocusedControlId)
      : null;
    const fallback = document.querySelector(
      '#classpilot-auth-email:not([disabled]), #classpilot-auth-grade:not([disabled]), #classpilot-auth-retry:not([disabled]), .classpilot-auth-panel',
    );
    const target = remembered?.isConnected && !remembered.disabled ? remembered : fallback;
    target?.focus({ preventScroll: true });
  }

  function refreshVisibleRoster() {
    const gradeSelect = document.getElementById('classpilot-auth-grade');
    if (!initialized || document.visibilityState === 'hidden' ||
        authGatePhase(currentState || {}) !== 'ready' ||
        currentState?.loginMethod === 'email_id' || !gradeSelect) {
      return;
    }
    refreshRosterOrGrades({ forceRefresh: true, background: true });
  }

  document.addEventListener('focusin', (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.id &&
        target.matches('button, input, select, [href], [tabindex]')) {
      lastFocusedControlId = target.id;
    }
  });

  window.addEventListener('focus', () => {
    requestAnimationFrame(restoreFrameFocus);
    refreshVisibleRoster();
  });

  window.addEventListener('pageshow', refreshVisibleRoster);
  window.addEventListener('online', refreshVisibleRoster);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      clearRosterRefreshTimer();
      return;
    }
    refreshVisibleRoster();
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!initialized) return;
    if (sender?.id && sender.id !== chrome.runtime.id) return;
    if (message?.type === 'CLASSPILOT_AUTH_COMPLETE') {
      applyState({ ...(message.state || {}), phase: 'authenticated', authRequired: false });
    } else if (message?.type === 'CLASSPILOT_AUTH_REQUIRED') {
      applyState(message.state || { phase: 'loading', authRequired: true });
    }
  });

  window.addEventListener('message', (event) => {
    if (initialized || event.source !== window.parent || !embeddingOrigin ||
        event.origin !== embeddingOrigin ||
        event.data?.type !== 'CLASSPILOT_AUTH_FRAME_INIT' ||
        event.data?.nonce !== INSTANCE_NONCE || !/^[a-f0-9]{64}$/.test(INSTANCE_NONCE)) {
      return;
    }
    initialized = true;
    render({ phase: 'loading', authRequired: true });
    notifyParent('CLASSPILOT_AUTH_FRAME_READY');
    requestLatestState();
  });

  window.addEventListener('pagehide', () => {
    notifyParent('CLASSPILOT_AUTH_FRAME_LEAVING');
  });
})();
