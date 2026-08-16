import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlaywrightSurface } from "./playwright-surface.js";

// Uses a real (headless) browser against static, local HTML — no network dependency —
// to verify the ranked-locator fallback chain: role -> testId -> text -> css.
describe("PlaywrightSurface locator resolution", () => {
  let surface: PlaywrightSurface;

  beforeAll(async () => {
    surface = await PlaywrightSurface.launch("about:blank", { headed: false });
    await surface.rawPage.setContent(`
      <html><body>
        <button data-testid="submit-btn">Not the accessible name</button>
        <div>Click here to continue</div>
      </body></html>
    `);
  });

  afterAll(async () => {
    await surface.close();
  });

  it("resolves via the role tier when an accessible role+name matches", async () => {
    const res = await surface.resolveLocator({ role: { role: "button", name: "Not the accessible name" } });
    expect(res.found).toBe(true);
    expect(res.tierUsed).toBe("role");
  });

  it("falls back to the testId tier when no role/name is given", async () => {
    const res = await surface.resolveLocator({ testId: "submit-btn" });
    expect(res.found).toBe(true);
    expect(res.tierUsed).toBe("testId");
  });

  it("falls back to the text tier for plain, non-interactive content", async () => {
    const res = await surface.resolveLocator({ text: "Click here to continue" });
    expect(res.found).toBe(true);
    expect(res.tierUsed).toBe("text");
  });

  it("reports not found when nothing matches any tier", async () => {
    const res = await surface.resolveLocator({ text: "This text does not exist anywhere on the page" });
    expect(res.found).toBe(false);
  });
});
