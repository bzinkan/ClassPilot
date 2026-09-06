/* Shared by the MV3 worker and its behavioral tests. No browser state is retained here. */
(function (root) {
  function matches(url, rules) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return false;
      const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
      return rules.some((rule) => {
        const hostname = String(rule).replace(/^www\./, '').toLowerCase();
        return host === hostname || host.endsWith(`.${hostname}`);
      });
    } catch { return false; }
  }
  async function enforceExistingTabs({ rules, queryTabs, getTab, closeTab, assertCurrent }) {
    assertCurrent();
    const candidates = await queryTabs();
    assertCurrent();
    let closedTabCount = 0;
    let failed = false;
    for (const candidate of candidates) {
      if (!Number.isInteger(candidate.id) || !matches(candidate.url, rules)) continue;
      assertCurrent();
      let current;
      try { current = await getTab(candidate.id); } catch { continue; }
      assertCurrent();
      // An unrelated navigation after the enumeration must never be closed.
      if (!current || current.url !== candidate.url || !matches(current.url, rules)) continue;
      try { await closeTab(current.id); closedTabCount++; } catch { failed = true; }
      assertCurrent();
    }
    return { status: failed ? 'failed' : 'applied', closedTabCount,
      ...(failed ? { errorCode: 'TAB_ENFORCEMENT_FAILED' } : {}) };
  }
  root.ClassPilotSchoolWebsitePolicy = Object.freeze({ matches, enforceExistingTabs });
})(globalThis);
