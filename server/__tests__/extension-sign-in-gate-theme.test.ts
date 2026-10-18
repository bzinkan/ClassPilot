import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// 3.0.1: the sign-in gate may paint the school's theme. The worker admits only
// a known preset with same-origin artwork; the frame re-checks the shape and
// never lets a value reach markup unescaped. Both are exercised on the real
// production source, extracted by function boundary.

const workerSource = readFileSync(resolve(__dirname, "../../extension/service-worker.js"), "utf8").replace(/\r\n/g, "\n");
const frameSource = readFileSync(resolve(__dirname, "../../extension/auth-gate-frame.js"), "utf8").replace(/\r\n/g, "\n");
const frameCss = readFileSync(resolve(__dirname, "../../extension/auth-gate-frame.css"), "utf8");

function functionSource(source: string, name: string): string {
  const match = new RegExp(`^(?:  )?function ${name}\\(`, "m").exec(source);
  expect(match, `missing production function ${name}`).toBeTruthy();
  const start = match!.index;
  const rest = source.slice(start);
  const end = /^}[ 	]*$/m.exec(rest.slice(rest.indexOf("\n")));
  expect(end, `missing boundary for ${name}`).toBeTruthy();
  return rest.slice(0, rest.indexOf("\n") + end!.index + end![0].length + 1);
}

function loadWorkerSanitizer() {
  const presets = /const SIGN_IN_GATE_THEME_PRESETS = \[[^\]]+\];/.exec(workerSource);
  expect(presets).toBeTruthy();
  const context: Record<string, unknown> = { URL, Number, String, Array };
  context.globalThis = context;
  runInNewContext([presets![0], functionSource(workerSource, "sameOriginAssetUrl"), functionSource(workerSource, "sanitizeSignInGateTheme"),
    "globalThis.sanitize = sanitizeSignInGateTheme;"].join("\n"), context);
  return context.sanitize as (raw: unknown, serverUrl: string) => Record<string, unknown> | null;
}

const SERVER = "https://school-pilot.net";
const good = { preset: "halloween", label: "Halloween", artwork: `${SERVER}/themes/halloween.webp`, mark: "halloween",
  brandFace: { family: "Creepster", weight: 400, url: `${SERVER}/fonts/creepster-latin.woff2` } };

describe("sign-in gate theme (3.0.1)", () => {
  const sanitize = loadWorkerSanitizer();

  it("admits a known preset with same-origin artwork and face", () => {
    expect(sanitize(good, SERVER)).toEqual({ preset: "halloween", label: "Halloween", artwork: good.artwork, mark: "halloween",
      brandFace: { family: "Creepster", weight: 400, url: good.brandFace.url } });
    expect(sanitize({ preset: "winter", artwork: `${SERVER}/themes/winter.webp` }, SERVER))
      .toEqual({ preset: "winter", label: "winter", artwork: `${SERVER}/themes/winter.webp`, mark: "winter", brandFace: null });
  });

  it("refuses anything that is not a known preset with same-origin artwork", () => {
    for (const bad of [null, "halloween", [], {}, { ...good, preset: "bengals" }, { ...good, preset: 1 },
      { ...good, artwork: "https://evil.example/x.webp" }, { ...good, artwork: `${SERVER}/x.webp?q=1` },
      { ...good, artwork: "javascript:alert(1)" }, { ...good, artwork: "data:image/webp;base64,AAAA" },
      { ...good, artwork: `${SERVER}/a.webp#f` }, { ...good, artwork: "https://user:pw@school-pilot.net/a.webp" }]) {
      expect(sanitize(bad, SERVER)).toBeNull();
    }
  });

  it("drops a bad face but keeps the artwork", () => {
    for (const face of [{ family: "Creepster", weight: 400, url: "https://fonts.gstatic.com/x.woff2" },
      { family: "Creep'ster", weight: 400, url: good.brandFace.url }, { family: "Creepster", weight: 500, url: good.brandFace.url }, "Creepster", null]) {
      expect(sanitize({ ...good, brandFace: face }, SERVER)?.brandFace).toBeNull();
    }
    expect(sanitize({ ...good, label: "x".repeat(80) }, SERVER)?.label).toHaveLength(40);
  });

  it("carries the theme through the gate state, the presentation cache and the frame", () => {
    expect(workerSource).toContain("theme: sharedSignInEnabled ? sanitizeSignInGateTheme(data.theme, CONFIG.serverUrl) : null,");
    expect(workerSource).toContain("...(config.theme ? { theme: config.theme } : {}),");
    expect(workerSource).toContain("theme: sanitizeSignInGateTheme(rawCache.theme, CONFIG.serverUrl),");
    expect(workerSource).toContain("theme: authRequired && sharedSignInLoginConfig.sharedSignInEnabled === true ? (sharedSignInLoginConfig.theme || null) : null,");
    expect(frameSource).toContain("theme: safeGateTheme(state.theme) },");
    expect(frameSource).toContain("gateThemeKey(state.theme) === gateThemeKey(currentState?.theme)");
    expect(frameSource).toContain("applyGateTheme(state.theme);");
    // Markup only ever sees a preset from the frame's own list and a CSS url() built from a parsed URL.
    expect(frameSource).toContain('data-theme="${options.theme.preset}"');
    expect(frameSource).toContain("THEME_MARKS[options.theme.preset]");
    expect(frameSource).toContain("encodeURIComponent(character)");
    for (const preset of ["halloween", "thanksgiving", "christmas", "advent", "valentines", "st-patricks", "easter", "spring", "summer", "fall", "winter"]) {
      expect(frameSource).toContain(`${preset.includes("-") ? `'${preset}'` : preset}: '<svg`);
      expect(frameCss).toContain(`.classpilot-auth-panel[data-theme="${preset}"]`);
    }
    // The form card, the artwork and the side tint are opt-in classes the frame adds only once assets load.
    expect(frameCss).toContain(".classpilot-auth-panel--art .classpilot-auth-main-inner");
    expect(frameCss).toContain("body.classpilot-auth-themed");
    expect(frameSource).toContain("image.onload = () => {");
    expect(frameSource).toContain("face.load().then((loaded) => {");
  });
});
