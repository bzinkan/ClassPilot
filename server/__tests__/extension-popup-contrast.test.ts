import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const popup = readFileSync(resolve("extension/popup.html"), "utf8");
const script = readFileSync(resolve("extension/popup.js"), "utf8");

function color(style: string, property: string) {
  const value = style.match(new RegExp(`(?:^|[;{])\\s*${property}:\\s*(#[\\da-f]{6}|white)\\s*[;}"]`, "i"))?.[1];
  if (!value) throw new Error(`Expected ${property} in ${style}`);
  const hex = value === "white" ? "ffffff" : value.slice(1);
  return [0, 2, 4].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
}

function contrast(foreground: number[], background: number[], opacity = 1) {
  const luminance = (rgb: number[]) => rgb.reduce((sum, component, i) => {
    const linear = component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][i];
  }, 0);
  const text = foreground.map((channel, i) => channel * opacity + background[i] * (1 - opacity));
  const [dark, light] = [luminance(text), luminance(background)].sort((a, b) => a - b);
  return (light + 0.05) / (dark + 0.05);
}

function inlineStyle(id: string) {
  const tag = popup.match(new RegExp(`<[^>]+id="${id}"[^>]+>`))?.[0];
  const style = tag?.match(/style="([^"]+)"/)?.[1];
  if (!style) throw new Error(`Expected inline style on #${id}`);
  return style;
}

describe("student popup normal text contrast", () => {
  const header = popup.match(/\.header\s*\{([^}]+)\}/)?.[1] ?? "";
  const opacity = Number(popup.match(/\.header p\s*\{[^}]*opacity:\s*([\d.]+)/)?.[1]);
  it("keeps the heading and translucent school name readable", () => {
    for (const alpha of [1, opacity]) {
      expect(contrast(color(header, "color"), color(header, "background"), alpha)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("keeps the detected email readable against its panel", () => {
    expect(contrast(color(inlineStyle("detected-student-email"), "color"),
      color(inlineStyle("auto-detected-student"), "background"))).toBeGreaterThanOrEqual(4.5);
  });
  it.each(["send-question-btn", "send-message-btn"])("keeps #%s readable", (id) => {
    const style = inlineStyle(id);
    expect(contrast(color(style, "color"), color(style, "background"))).toBeGreaterThanOrEqual(4.5);
  });
  it.each([
    ["chat-disabled", "Messaging"],
    ["messaging-disabled", "Hand raising"],
  ])("keeps the %s notice readable", (id, label) => {
    const notice = popup.match(new RegExp(`<p style="([^"]+)">${label} is currently disabled by your teacher`))?.[1] ?? "";
    expect(contrast(color(notice, "color"), color(inlineStyle(id), "background"))).toBeGreaterThanOrEqual(4.5);
  });
  it.each(["", ".unread"])("keeps the timestamp readable in a message%s", (variant) => {
    const timestamp = popup.match(/\.message-time\s*\{([^}]+)\}/)?.[1] ?? "";
    const item = popup.match(new RegExp(`\\.message-item${variant.replace(".", "\\.")}\\s*\\{([^}]+)\\}`))?.[1] ?? "";
    expect(contrast(color(timestamp, "color"), color(item, "background"))).toBeGreaterThanOrEqual(4.5);
  });
  it("keeps Raise Hand readable across its gradient", () => {
    const style = popup.match(/\.raise-hand-btn\s*\{([^}]+)\}/)?.[1] ?? "";
    const endpoints = style.match(/linear-gradient\([^)]*\)/)?.[0].match(/#[\da-f]{6}/gi) ?? [];
    expect(endpoints).toHaveLength(2);
    for (const endpoint of endpoints) {
      expect(contrast(color(style, "color"), color(`background: ${endpoint};`, "background"))).toBeGreaterThanOrEqual(4.5);
    }
  });
  it.each([["initial", popup], ["refreshed", script]])("keeps the %s empty inbox readable", (_name, source) => {
    const style = source.match(/<p style="([^"]+)"[^>]*>\s*No messages yet/)?.[1] ?? "";
    const section = popup.match(/\.section\s*\{([^}]+)\}/)?.[1] ?? "";
    expect(contrast(color(style, "color"), color(section, "background"))).toBeGreaterThanOrEqual(4.5);
  });
});
