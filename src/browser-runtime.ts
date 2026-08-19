import { Camoufox, type LaunchOptions } from "camoufox-js";
import { launchPath } from "camoufox-js/dist/pkgman.js";
import type { Browser, BrowserContext, Page, Response, Route } from "playwright-core";
import chalk from "chalk";
import { parseAndValidateBrowserRequestUrl, validateBrowserRequestUrl, validateTargetUrl } from "./policy.js";
import { DEFAULT_WAIT_STRATEGY, GUARD_SETTLE_MS, LAUNCH_TIMEOUT_MS, MAX_CONCURRENCY, MAX_GUARDED_REQUESTS, MAX_QUEUE, QUEUE_TIMEOUT_MS } from "./config.js";
import { createDiagnosticsCollector } from "./diagnostics.js";
import { browserContextOptions, buildCamoufoxOptions, validateCommonBrowserInput } from "./browser-options.js";
import type { BrowserInstance, BrowserOperationContext, CamoufoxOptions, CommonBrowserInput, PendingBrowse, RequestGuard, SlotRelease } from "./types.js";
import { isXephyrAvailable, launchXephyr, type XephyrDisplay } from "./virtdisplay.js";
import { applyStealthProfile, defaultHeadlessMode, describeError, getProxySecrets, getProxyServer, redactUrl, selectOperatingSystem, withTimeout } from "./utils.js";

export { browserContextOptions, buildCamoufoxOptions, validateBrowserOptionsInput } from "./browser-options.js";

let shuttingDown = false;
let activeBrowses = 0;
const pendingBrowses: PendingBrowse[] = [];
const activeBrowsers = new Set<BrowserInstance>();
// Associates each launched browser with the Xephyr display it renders to, so
// closeBrowser can tear down the display alongside the browser.
const browserDisplays = new WeakMap<BrowserInstance, XephyrDisplay>();

export function setBrowserShuttingDown(value: boolean): void { shuttingDown = value; }
export function activeBrowserCount(): number { return activeBrowsers.size; }
export function queuedBrowserRequestCount(): number { return pendingBrowses.length; }
export function trackBrowser(browser: BrowserInstance): void { activeBrowsers.add(browser); }

export function releaseBrowserSlot(): void {
  activeBrowses = Math.max(0, activeBrowses - 1);
  const next = pendingBrowses.shift();
  if (next) {
    next.start();
  }
}

export async function acquireBrowserSlot(): Promise<SlotRelease> {
  if (shuttingDown) {
    throw new Error("Server is shutting down.");
  }

  if (activeBrowses < MAX_CONCURRENCY) {
    activeBrowses += 1;
    return releaseBrowserSlot;
  }

  if (pendingBrowses.length >= MAX_QUEUE) {
    throw new Error("Too many concurrent browse requests. Try again later.");
  }

  return new Promise((resolve, reject) => {
    const entry: PendingBrowse = {
      reject,
      timer: setTimeout(() => {
        const index = pendingBrowses.indexOf(entry);
        if (index >= 0) {
          pendingBrowses.splice(index, 1);
        }
        reject(new Error("Timed out waiting for a browse slot."));
      }, QUEUE_TIMEOUT_MS),
      start: () => {
        clearTimeout(entry.timer);
        activeBrowses += 1;
        resolve(releaseBrowserSlot);
      },
    };

    pendingBrowses.push(entry);
  });
}

export async function withBrowserSlot<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireBrowserSlot();
  try {
    return await fn();
  } finally {
    release();
  }
}

export const MISSING_BROWSER_MESSAGE =
  "Camoufox browser binary not installed. Run: npx -y camoufox-js@0.12.0 fetch (one-time ~780MB download into the shared OS cache), then retry.";

// ponytail: preflight only; a launch-time miss after this passes stays generic. `launchPath`
// throws when the binary is absent (same probe camoufox_status uses). The default arg keeps it
// injectable so the unit test can drive both branches without a real 780MB download.
export function assertBrowserBinaryAvailable(probe: () => unknown = launchPath): void {
  try {
    probe();
  } catch {
    throw new Error(MISSING_BROWSER_MESSAGE);
  }
}

// When the caller asked for a virtual display, launch camoufox-mcp's OWN Xephyr
// on a random, verified-free display and point the browser at it. This keeps us
// isolated from the ambient DISPLAY and from other projects' X servers. Returns
// the display handle for cleanup, or undefined when we defer to camoufox-js's
// built-in Xvfb (Xephyr unavailable) or no virtual display was requested.
async function maybeLaunchXephyr(options: CamoufoxOptions): Promise<XephyrDisplay | undefined> {
  if (options.headless !== "virtual") return undefined;
  if (!(await isXephyrAvailable())) return undefined;
  const display = await launchXephyr();
  // headless:false stops camoufox-js from spawning its own Xvfb; virtual_display
  // makes it set env.DISPLAY to our Xephyr.
  options.headless = false;
  options.virtual_display = display.display;
  return display;
}

export async function launchCamoufoxBrowser(options: CamoufoxOptions): Promise<Browser> {
  const display = await maybeLaunchXephyr(options);
  let timedOut = false;
  const launchPromise = Camoufox<undefined, Browser>(options as LaunchOptions);
  launchPromise.then(
    (browser) => {
      if (timedOut) {
        void closeBrowser(browser);
      }
    },
    () => undefined,
  );

  try {
    const browser = await withTimeout(launchPromise, LAUNCH_TIMEOUT_MS, "Browser launch");
    if (display) browserDisplays.set(browser, display);
    return browser;
  } catch (error) {
    timedOut = true;
    if (display) await display.close();
    throw error;
  }
}

export async function launchPersistentCamoufox(options: CamoufoxOptions): Promise<BrowserContext> {
  if (!options.user_data_dir) {
    throw new Error("user_data_dir is required for persistent launch");
  }
  const display = await maybeLaunchXephyr(options);
  let timedOut = false;
  const launchPromise = Camoufox<string, BrowserContext>(options as LaunchOptions & { user_data_dir: string });
  launchPromise.then(
    (context) => {
      if (timedOut) {
        void context.close().catch(() => undefined);
      }
    },
    () => undefined,
  );

  try {
    const context = await withTimeout(launchPromise, LAUNCH_TIMEOUT_MS, "Persistent browser launch");
    const browser = context.browser();
    if (display && browser) browserDisplays.set(browser, display);
    return context;
  } catch (error) {
    timedOut = true;
    if (display) await display.close();
    throw error;
  }
}

export async function installRequestGuard(context: BrowserContext): Promise<RequestGuard> {
  let inspectedRequests = 0;
  let blockedRequestError: Error | undefined;

  function blockRequest(rawUrl: string, reason: string): void {
    if (!blockedRequestError) {
      blockedRequestError = new Error(`Blocked unsafe browser request to ${redactUrl(rawUrl)}. ${reason}`);
    }
  }

  function hasRequestBudget(rawUrl: string): boolean {
    if (inspectedRequests >= MAX_GUARDED_REQUESTS) {
      blockRequest(rawUrl, "Too many browser requests.");
      return false;
    }

    inspectedRequests += 1;
    return true;
  }

  context.on("request", (request) => {
    const requestUrl = request.url();
    try {
      parseAndValidateBrowserRequestUrl(requestUrl);
    } catch (requestError) {
      blockRequest(requestUrl, describeError(requestError));
    }
  });

  await context.route("**/*", async (route: Route) => {
    const requestUrl = route.request().url();

    if (!hasRequestBudget(requestUrl)) {
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }

    try {
      await validateBrowserRequestUrl(requestUrl);
    } catch (requestError) {
      blockRequest(requestUrl, describeError(requestError));
      await route.abort("blockedbyclient").catch(() => undefined);
      return;
    }

    await route.continue().catch((continueError) => {
      console.error(chalk.yellow(`[Camoufox] Request continue failed: ${describeError(continueError)}`));
    });
  });

  await context.routeWebSocket(/.*/, async (webSocket) => {
    const requestUrl = webSocket.url();

    if (!hasRequestBudget(requestUrl)) {
      await webSocket.close({ code: 1008, reason: "Blocked by server policy" }).catch(() => undefined);
      return;
    }

    try {
      await validateBrowserRequestUrl(requestUrl);
    } catch (requestError) {
      blockRequest(requestUrl, describeError(requestError));
      await webSocket.close({ code: 1008, reason: "Blocked by server policy" }).catch(() => undefined);
      return;
    }

    webSocket.connectToServer();
  });

  return {
    assertAllowed(): void {
      if (blockedRequestError) {
        throw blockedRequestError;
      }
    },
    watchPage(page: Page): void {
      // WebSocket targets are gated by context.routeWebSocket above (budget +
      // validation). Observing them again here would double-count each socket
      // against the request budget, so this hook is intentionally a no-op.
      void page;
    },
    resetBudget(): void {
      inspectedRequests = 0;
    },
  };
}

export async function runBrowserOperation<T>(
  label: string,
  input: CommonBrowserInput,
  callback: (context: BrowserOperationContext) => Promise<T>,
): Promise<T> {
  const effectiveInput = applyStealthProfile(input);
  const safeUrl = redactUrl(effectiveInput.url);
  const targetUrl = await validateCommonBrowserInput(effectiveInput);

  return withBrowserSlot(async () => {
    assertBrowserBinaryAvailable();

    const selectedOS = selectOperatingSystem(effectiveInput.os);
    const waitStrategy = effectiveInput.waitStrategy ?? DEFAULT_WAIT_STRATEGY;
    const headlessMode = defaultHeadlessMode(effectiveInput.headless);

    console.error(chalk.blue(`[Camoufox] Launching browser to ${label}: ${safeUrl}`));

    const browser = await launchCamoufoxBrowser(buildCamoufoxOptions(effectiveInput, selectedOS, headlessMode));
    activeBrowsers.add(browser);

    try {
      const context = await browser.newContext(browserContextOptions(effectiveInput));
      const requestGuard = await installRequestGuard(context);
      const page = await context.newPage();
      requestGuard.watchPage(page);

      const rawUrls = [effectiveInput.url, getProxyServer(effectiveInput.proxy)].filter((rawUrl): rawUrl is string => Boolean(rawUrl));
      const secrets = getProxySecrets(effectiveInput.proxy);
      const diagnostics = createDiagnosticsCollector(page, effectiveInput, rawUrls, secrets);
      let lastNavigationResponse: Response | null = null;
      page.on("response", (response) => {
        const request = response.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          lastNavigationResponse = response;
        }
      });

      let response: Response | null;
      try {
        response = await page.goto(targetUrl.toString(), {
          waitUntil: waitStrategy,
          timeout: effectiveInput.timeout,
        });
        lastNavigationResponse = response;
      } catch (navigationError) {
        const navigationErrorMessage = describeError(navigationError).toLowerCase();
        if (/\b(?:127\.0\.0\.1|localhost|ip6-localhost|ip6-loopback|::1)\b/.test(navigationErrorMessage)) {
          throw new Error(`Blocked unsafe browser request to ${safeUrl}.`, { cause: navigationError });
        }

        requestGuard.assertAllowed();
        throw navigationError;
      }

      await page.waitForTimeout(GUARD_SETTLE_MS);
      requestGuard.assertAllowed();
      await validateTargetUrl(page.url());
      requestGuard.assertAllowed();

      return await callback({
        page,
        response,
        requestGuard,
        diagnostics,
        selectedOS,
        waitStrategy,
        getLastNavigationResponse: () => lastNavigationResponse,
      });
    } finally {
      console.error(chalk.blue("[Camoufox] Closing browser."));
      await closeBrowser(browser);
    }
  });
}

export async function assertPageLocationSafe(page: Page): Promise<void> {
  if (page.url() === "about:blank") {
    return;
  }

  await validateTargetUrl(page.url());
}

export async function settleAndAssertSafe(page: Page, requestGuard: RequestGuard): Promise<void> {
  await page.waitForTimeout(GUARD_SETTLE_MS);
  requestGuard.assertAllowed();
  await assertPageLocationSafe(page);
  requestGuard.assertAllowed();
}

export async function runGuardedPageRead<T>(page: Page, requestGuard: RequestGuard, read: () => Promise<T>): Promise<T> {
  try {
    requestGuard.assertAllowed();
    await assertPageLocationSafe(page);
    requestGuard.assertAllowed();
    const result = await read();
    await page.waitForTimeout(GUARD_SETTLE_MS).catch(() => undefined);
    requestGuard.assertAllowed();
    await assertPageLocationSafe(page);
    requestGuard.assertAllowed();
    return result;
  } catch (readError) {
    await page.waitForTimeout(GUARD_SETTLE_MS).catch(() => undefined);
    requestGuard.assertAllowed();
    await assertPageLocationSafe(page);
    requestGuard.assertAllowed();
    throw readError;
  }
}

export async function closeBrowser(browser: BrowserInstance): Promise<void> {
  activeBrowsers.delete(browser);
  const display = browserDisplays.get(browser);
  browserDisplays.delete(browser);
  try {
    await browser.close();
  } catch (closeError) {
    console.error(chalk.yellow(`[Camoufox] Browser close failed: ${describeError(closeError)}`));
  } finally {
    if (display) await display.close();
  }
}

export async function closeActiveBrowsers(): Promise<void> {
  const browsers = Array.from(activeBrowsers);
  await Promise.all(browsers.map((browser) => closeBrowser(browser)));
}

export function rejectPendingBrowses(reason: string): void {
  const pending = pendingBrowses.splice(0);
  for (const entry of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error(reason));
  }
}
