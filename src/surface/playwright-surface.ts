import { chromium, selectors, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import {
  LocatorNotFoundError,
  type ElementLocator,
  type LocatorResolution,
  type LocatorTier,
  type Observation,
  type Surface,
  type SurfaceAction,
} from "./surface.js";

const DEFAULT_TIER_TIMEOUT_MS = 3000;

/**
 * Resolves an ElementLocator against a live Page by trying tiers in priority order:
 * role+accessibleName -> data-testid -> visible text -> css (debug-only, last resort).
 * The first tier that finds at least one match wins. This is what makes locators
 * resilient to markup that lacks stable selectors, which is the norm in legacy
 * enterprise UIs.
 */
async function resolvePlaywrightLocator(
  page: Page,
  locator: ElementLocator,
  timeoutMs = DEFAULT_TIER_TIMEOUT_MS,
): Promise<{ pwLocator: Locator; tierUsed: LocatorTier; matchedCount: number } | null> {
  const tiers: Array<[LocatorTier, () => Locator | undefined]> = [
    ["role", () => (locator.role ? page.getByRole(locator.role.role as never, { name: locator.role.name }) : undefined)],
    ["testId", () => (locator.testId ? page.getByTestId(locator.testId) : undefined)],
    ["text", () => (locator.text ? page.getByText(locator.text, { exact: false }) : undefined)],
    ["css", () => (locator.css ? page.locator(locator.css) : undefined)],
  ];

  for (const [tier, build] of tiers) {
    const candidate = build();
    if (!candidate) continue;
    try {
      const matchedCount = await candidate.count();
      if (matchedCount === 0) continue;
      const scoped = locator.nth !== undefined ? candidate.nth(locator.nth) : candidate.first();
      await scoped.waitFor({ state: "attached", timeout: timeoutMs });
      return { pwLocator: scoped, tierUsed: tier, matchedCount };
    } catch {
      continue; // this tier didn't pan out within budget; fall through to the next
    }
  }
  return null;
}

export class PlaywrightSurface implements Surface {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {}

  /**
   * @param opts.testIdAttribute The DOM attribute the "testId" locator tier reads.
   * Vendor apps vary here (`data-testid`, `data-test`, `data-qa`, ...) — this is exactly
   * the kind of per-target-app setting a tenant/app profile would carry in a multi-app
   * deployment (see REPORT.md, Heterogeneity & multi-tenant). Defaults to Playwright's
   * own convention, `data-testid`.
   */
  static async launch(baseUrl: string, opts: { headed?: boolean; testIdAttribute?: string } = {}): Promise<PlaywrightSurface> {
    selectors.setTestIdAttribute(opts.testIdAttribute ?? "data-testid");
    const browser = await chromium.launch({ headless: !opts.headed });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(baseUrl);
    return new PlaywrightSurface(browser, context, page);
  }

  /** Wraps an already-open Page (used by the escalation handoff, which reuses the live session). */
  static fromExistingPage(browser: Browser, context: BrowserContext, page: Page): PlaywrightSurface {
    return new PlaywrightSurface(browser, context, page);
  }

  get rawPage(): Page {
    return this.page;
  }

  async observe(): Promise<Observation> {
    const ariaSnapshot = await this.page.locator("body").ariaSnapshot();
    return { url: this.page.url(), title: await this.page.title(), ariaSnapshot };
  }

  async resolveLocator(locator: ElementLocator, timeoutMs?: number): Promise<LocatorResolution> {
    const result = await resolvePlaywrightLocator(this.page, locator, timeoutMs);
    if (!result) return { found: false };
    return { found: true, tierUsed: result.tierUsed, matchedCount: result.matchedCount };
  }

  async perform(action: SurfaceAction): Promise<void> {
    if (action.type === "navigate") {
      await this.page.goto(action.url);
      return;
    }

    const resolved = await resolvePlaywrightLocator(this.page, action.locator);
    if (!resolved) {
      throw new LocatorNotFoundError(action.locator);
    }

    switch (action.type) {
      case "click":
        await resolved.pwLocator.click();
        return;
      case "type":
        await resolved.pwLocator.fill(action.text);
        return;
      case "select":
        await resolved.pwLocator.selectOption(action.value);
        return;
      case "wait_for":
        // Resolution above already waited for attachment; nothing further to do.
        return;
    }
  }

  async extract(locator: ElementLocator): Promise<string> {
    const resolved = await resolvePlaywrightLocator(this.page, locator);
    if (!resolved) throw new LocatorNotFoundError(locator);
    return (await resolved.pwLocator.innerText()).trim();
  }

  async screenshot(destPath: string): Promise<void> {
    await this.page.screenshot({
      path: destPath,
      fullPage: false,
      // Defense in depth: never let a screenshot leak a password field's value.
      mask: [this.page.locator('input[type="password"]')],
    });
  }

  currentUrl(): string {
    return this.page.url();
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
