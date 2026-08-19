import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Response } from "playwright-core";
import chalk from "chalk";
import { validateTargetUrl } from "./policy.js";
import { DEFAULT_ACTION_TIMEOUT_MS, DEFAULT_MAX_CHARS, DEFAULT_MAX_ELEMENTS, DEFAULT_WAIT_STRATEGY, MAX_SESSIONS, PROFILE_DIR, SESSION_CLOSE_GRACE_MS, SESSION_TTL_MS } from "./config.js";
import type { CaptchaPolicy, ScreenshotOptions, ScreenshotResult, SessionRecord, SlotRelease, WaitStrategy } from "./types.js";
import type { SessionActionToolInput, SessionCloseToolInput, SessionNavigateToolInput, SessionResumeToolInput, SessionSnapshotToolInput, SessionStartToolInput } from "./schemas.js";
import { acquireBrowserSlot, buildCamoufoxOptions, closeBrowser, installRequestGuard, launchPersistentCamoufox, runGuardedPageRead, settleAndAssertSafe, trackBrowser, validateBrowserOptionsInput } from "./browser-runtime.js";
import { isXephyrAvailable, launchXephyr, type XephyrDisplay } from "./virtdisplay.js";
import { createDiagnosticsCollector } from "./diagnostics.js";
import { buildBrowsePayload, buildSnapshotPayload } from "./extractors.js";
import { maybeDetectCaptcha } from "./captcha.js";
import { captureScreenshot } from "./screenshots.js";
import { buildSuccessContent, buildToolError } from "./responses.js";
import { isLocalOperationTimeout, runSequenceAction } from "./sequence.js";
import { applyStealthProfile, defaultHeadlessMode, describeError, getProxySecrets, getProxyServer, redactUrl, sanitizeErrorMessage, selectOperatingSystem } from "./utils.js";

let reservedSessions = 0;
const sessions = new Map<string, SessionRecord>();

export function activeSessionCount(): number { return sessions.size; }

export function sessionExpiresAt(session: SessionRecord): string {
  return new Date(session.expiresAt).toISOString();
}

export function resetSessionTtl(session: SessionRecord): void {
  clearTimeout(session.timer);
  session.expiresAt = Date.now() + session.ttlMs;
  session.timer = setTimeout(() => {
    void closeSession(session.id, "expired");
  }, session.ttlMs);
}

export function reserveSessionSlot(): boolean {
  if (reservedSessions >= MAX_SESSIONS) {
    return false;
  }

  reservedSessions += 1;
  return true;
}

export function releaseSessionSlot(): void {
  reservedSessions = Math.max(0, reservedSessions - 1);
}

function sessionScreenshotOptions(input: { screenshot?: boolean; screenshotFullPage?: boolean; screenshotType?: "png" | "jpeg"; screenshotQuality?: number }): ScreenshotOptions | undefined {
  if (!input.screenshot) return undefined;
  return { fullPage: input.screenshotFullPage, type: input.screenshotType, quality: input.screenshotQuality };
}

async function captureSessionScreenshot(page: Parameters<typeof captureScreenshot>[0], safeUrl: string, input: { screenshot?: boolean; screenshotFullPage?: boolean; screenshotType?: "png" | "jpeg"; screenshotQuality?: number }): Promise<ScreenshotResult | undefined> {
  const options = sessionScreenshotOptions(input);
  if (!options) return undefined;
  try {
    return await captureScreenshot(page, safeUrl, options);
  } catch {
    return undefined;
  }
}

export async function closeSessionNow(session: SessionRecord, reason: string): Promise<boolean> {
  if (session.closed) {
    return false;
  }

  session.closing = true;
  session.closed = true;
  sessions.delete(session.id);
  clearTimeout(session.timer);
  console.error(chalk.blue(`[Camoufox] Closing session ${session.id} (${reason}).`));
  try {
    await closeBrowser(session.browser);
  } finally {
    // Tear down the session's own Xephyr display. close is idempotent, so this
    // is safe even if the browser close already dropped the last client.
    if (session.xephyr) {
      await session.xephyr.close();
    }
    session.releaseSlot();
    releaseSessionSlot();
  }
  return true;
}

export async function closeSession(sessionId: string, reason: string): Promise<boolean> {
  const session = sessions.get(sessionId);
  if (!session) {
    return false;
  }

  session.closing = true;
  sessions.delete(sessionId);
  clearTimeout(session.timer);
  await waitForSessionOperationCloseGrace(session);
  return closeSessionNow(session, reason);
}

export async function waitForSessionOperationCloseGrace(session: SessionRecord): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      session.op.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SESSION_CLOSE_GRACE_MS);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function closeActiveSessions(): Promise<void> {
  const ids = Array.from(sessions.keys());
  await Promise.all(ids.map((id) => closeSession(id, "shutdown")));
}

export async function getSession(sessionId: string): Promise<SessionRecord> {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Unknown or closed session: ${sessionId}`);
  }

  if (Date.now() > session.expiresAt) {
    await closeSession(sessionId, "expired");
    throw new Error(`Session expired: ${sessionId}`);
  }

  resetSessionTtl(session);
  return session;
}

export async function runSessionExclusive<T>(
  session: SessionRecord,
  operation: () => Promise<T>,
): Promise<T> {
  const run = session.op.catch(() => undefined).then(async () => {
    if (session.closing || session.closed) {
      throw new Error(`Session is closing or closed: ${session.id}`);
    }

    try {
      return await operation();
    } catch (error) {
      if (isLocalOperationTimeout(error)) {
        await closeSessionNow(session, "operation-timeout");
      }
      throw error;
    }
  });

  session.op = run.then(() => undefined, () => undefined);
  return run;
}

export async function navigateSession(
  session: SessionRecord,
  url: string,
  waitStrategy?: WaitStrategy,
  timeout?: number,
): Promise<Response | null> {
  const safeUrl = redactUrl(url);
  const targetUrl = await validateTargetUrl(url);
  session.rawUrls.push(url);

  // Reset the request budget for this navigation. Sessions reuse one context,
  // so without a reset the lifetime budget is exhausted after a few heavy pages.
  session.requestGuard.resetBudget();

  try {
    const response = await session.page.goto(targetUrl.toString(), {
      waitUntil: waitStrategy ?? session.waitStrategy,
      timeout: timeout ?? DEFAULT_ACTION_TIMEOUT_MS * 6,
    });
    session.lastNavigationResponse = response;
    await settleAndAssertSafe(session.page, session.requestGuard);
    return response;
  } catch (navigationError) {
    const navigationErrorMessage = describeError(navigationError).toLowerCase();
    if (/\b(?:127\.0\.0\.1|localhost|ip6-localhost|ip6-loopback|::1)\b/.test(navigationErrorMessage)) {
      throw new Error(`Blocked unsafe browser request to ${safeUrl}.`, { cause: navigationError });
    }

    session.requestGuard.assertAllowed();
    throw navigationError;
  }
}

export async function handleSessionStart(input: SessionStartToolInput) {
  const captchaPolicy = input.captchaPolicy ?? "pause";
  const effectiveInput = applyStealthProfile({
    ...input,
    captchaPolicy,
  });

  if (!reserveSessionSlot()) {
    return buildToolError(`Too many active sessions. Maximum is ${MAX_SESSIONS}.`);
  }

  let release: SlotRelease | undefined;
  let browser: Browser | undefined;
  let xephyr: XephyrDisplay | undefined;
  try {
    await validateBrowserOptionsInput(effectiveInput);
    release = await acquireBrowserSlot();
    const selectedOS = selectOperatingSystem(effectiveInput.os);
    const waitStrategy = effectiveInput.waitStrategy ?? DEFAULT_WAIT_STRATEGY;
    const headlessMode = defaultHeadlessMode(effectiveInput.headless);

    const id = `sess_${randomUUID()}`;
    const profilePath = join(PROFILE_DIR, id);
    mkdirSync(profilePath, { recursive: true });

    const baseOptions = buildCamoufoxOptions(effectiveInput, selectedOS, headlessMode);

    // On Linux "virtual" mode, own an isolated Xephyr display for the session so
    // the browser never attaches to the ambient DISPLAY or another project's X
    // server. The display is launched here (session start) and torn down in
    // closeSessionNow. The browser is pointed at it via an explicit env so it
    // reliably inherits DISPLAY — we do NOT rely on camoufox-js mutating the
    // shared process.env, which is racy across concurrent launches.
    if (headlessMode === "virtual" && (await isXephyrAvailable())) {
      xephyr = await launchXephyr();
      baseOptions.headless = false;
      baseOptions.virtual_display = xephyr.display;
      baseOptions.env = { ...process.env, DISPLAY: xephyr.display };
      console.error(chalk.blue(`[Camoufox] Session ${id} using own Xephyr display ${xephyr.display} (pid ${xephyr.pid}).`));
    }

    const context = await launchPersistentCamoufox({ ...baseOptions, user_data_dir: profilePath });
    browser = context.browser() ?? undefined;
    if (!browser) {
      await context.close();
      throw new Error("Persistent context did not expose a browser instance.");
    }
    trackBrowser(browser);
    const requestGuard = await installRequestGuard(context);
    const page = await context.newPage();
    requestGuard.watchPage(page);

    const rawUrls = [getProxyServer(effectiveInput.proxy)].filter((rawUrl): rawUrl is string => Boolean(rawUrl));
    const secrets = getProxySecrets(effectiveInput.proxy);
    const now = Date.now();
    const ttlMs = input.ttlMs ?? SESSION_TTL_MS;
    const session: SessionRecord = {
      id,
      browser,
      context,
      page,
      requestGuard,
      diagnostics: createDiagnosticsCollector(page, effectiveInput, rawUrls, secrets),
      selectedOS,
      waitStrategy,
      captchaPolicy,
      ttlMs,
      releaseSlot: release,
      rawUrls,
      secrets,
      createdAt: now,
      expiresAt: now + ttlMs,
      timer: setTimeout(() => {
        void closeSession(id, "expired");
      }, ttlMs),
      lastNavigationResponse: null,
      op: Promise.resolve(),
      closing: false,
      closed: false,
      xephyr,
    };

    sessions.set(id, session);
    // Ownership of the Xephyr display transfers to the session record; clear the
    // local handles so the catch block below doesn't double-close them.
    browser = undefined;
    release = undefined;
    xephyr = undefined;

    return buildSuccessContent({
      sessionId: id,
      expiresAt: sessionExpiresAt(session),
      browser: "camoufox",
      selectedOS,
      headlessMode,
      stealthProfile: effectiveInput.stealthProfile,
      captchaPolicy,
    });
  } catch (error) {
    if (xephyr) {
      await xephyr.close();
    }
    if (browser) {
      await closeBrowser(browser);
    }
    if (release) {
      release();
    }
    releaseSessionSlot();
    const errorMessage = sanitizeErrorMessage(
      describeError(error),
      [getProxyServer(effectiveInput.proxy)].filter((rawUrl): rawUrl is string => Boolean(rawUrl)),
      getProxySecrets(effectiveInput.proxy),
    );
    return buildToolError(`Failed to start browser session. Error: ${errorMessage}`);
  }
}

export function sessionSanitizedError(error: unknown, session?: SessionRecord, extraRawUrls: string[] = []): string {
  const rawUrls = session ? [...session.rawUrls, ...extraRawUrls] : extraRawUrls;
  const secrets = session?.secrets ?? [];
  return sanitizeErrorMessage(describeError(error), rawUrls, secrets);
}

// Resolve the CAPTCHA policy for a session operation: a per-call override wins,
// otherwise fall back to the policy persisted at session start. Without this,
// starting a session with the documented "pause" default performed no detection
// on subsequent calls unless the caller re-passed captchaPolicy each time.
export function effectiveCaptchaPolicy(
  session: SessionRecord,
  input: { captchaPolicy?: CaptchaPolicy },
): CaptchaPolicy {
  return input.captchaPolicy ?? session.captchaPolicy;
}

export async function buildSessionSnapshotResult(
  session: SessionRecord,
  input: SessionSnapshotToolInput,
) {
  const snapshot = await runGuardedPageRead(
    session.page,
    session.requestGuard,
    () => buildSnapshotPayload(
      session.page,
      session.lastNavigationResponse,
      input.maxChars ?? DEFAULT_MAX_CHARS,
      input.maxElements ?? DEFAULT_MAX_ELEMENTS,
      input.selector,
    ),
  );
  // Surface the diagnostics collector that was created at session start but
  // previously never read. Snapshot/resume are the read-state operations, so
  // bounded console/network diagnostics belong here.
  const diagnostics = session.diagnostics.payload();
  const basePayload = { sessionId: session.id, expiresAt: sessionExpiresAt(session), ...snapshot, ...(diagnostics ? { diagnostics } : {}) };
  const captchaPolicy = effectiveCaptchaPolicy(session, input);
  const { mergedPayload, captchaScreenshot } = await maybeDetectCaptcha(
    session.page,
    session.lastNavigationResponse,
    basePayload,
    captchaPolicy,
    redactUrl(session.page.url()),
  );
  const screenshot = (await captureSessionScreenshot(session.page, redactUrl(session.page.url()), input)) ?? captchaScreenshot;
  return buildSuccessContent(mergedPayload, screenshot);
}

export async function handleSessionNavigate(input: SessionNavigateToolInput) {
  let session: SessionRecord | undefined;
  try {
    const currentSession = await getSession(input.sessionId);
    session = currentSession;
    return await runSessionExclusive(currentSession, async () => {
      const response = await navigateSession(currentSession, input.url, input.waitStrategy, input.timeout);
      const mode = input.outputMode ?? "text";
      const charLimit = input.maxChars ?? DEFAULT_MAX_CHARS;
      const payload = await runGuardedPageRead(
        currentSession.page,
        currentSession.requestGuard,
        () => buildBrowsePayload(currentSession.page, response, mode, charLimit, input.selector),
      );
      const basePayload = { sessionId: currentSession.id, expiresAt: sessionExpiresAt(currentSession), ...payload };
      const captchaPolicy = effectiveCaptchaPolicy(currentSession, input);
      const { mergedPayload, captchaScreenshot } = await maybeDetectCaptcha(currentSession.page, response, basePayload, captchaPolicy, redactUrl(input.url));
      const screenshot = (await captureSessionScreenshot(currentSession.page, redactUrl(input.url), input)) ?? captchaScreenshot;
      return buildSuccessContent(mergedPayload, screenshot);
    });
  } catch (error) {
    return buildToolError(`Failed to navigate session. Error: ${sessionSanitizedError(error, session, [input.url])}`);
  }
}

export async function handleSessionAction(input: SessionActionToolInput) {
  let session: SessionRecord | undefined;
  try {
    const currentSession = await getSession(input.sessionId);
    session = currentSession;
    return await runSessionExclusive(currentSession, async () => {
      const actionResult = await runSequenceAction(currentSession.page, input.action, 0, currentSession.rawUrls, currentSession.secrets, currentSession.xephyr?.display);
      await settleAndAssertSafe(currentSession.page, currentSession.requestGuard);
      const snapshot = await runGuardedPageRead(
        currentSession.page,
        currentSession.requestGuard,
        () => buildSnapshotPayload(
          currentSession.page,
          currentSession.lastNavigationResponse,
          input.maxChars ?? DEFAULT_MAX_CHARS,
          input.maxElements ?? DEFAULT_MAX_ELEMENTS,
          input.selector,
        ),
      );
      const basePayload = { sessionId: currentSession.id, expiresAt: sessionExpiresAt(currentSession), action: actionResult, snapshot };
      const captchaPolicy = effectiveCaptchaPolicy(currentSession, input);
      const { mergedPayload, captchaScreenshot } = await maybeDetectCaptcha(currentSession.page, currentSession.lastNavigationResponse, basePayload, captchaPolicy, redactUrl(currentSession.page.url()));
      const screenshot = (await captureSessionScreenshot(currentSession.page, redactUrl(currentSession.page.url()), input)) ?? captchaScreenshot;
      return buildSuccessContent(mergedPayload, screenshot);
    });
  } catch (error) {
    return buildToolError(`Failed to run session action. Error: ${sessionSanitizedError(error, session)}`);
  }
}

export async function handleSessionSnapshot(input: SessionSnapshotToolInput) {
  let session: SessionRecord | undefined;
  try {
    const currentSession = await getSession(input.sessionId);
    session = currentSession;
    return await runSessionExclusive(currentSession, async () => buildSessionSnapshotResult(currentSession, input));
  } catch (error) {
    return buildToolError(`Failed to snapshot session. Error: ${sessionSanitizedError(error, session)}`);
  }
}

export async function handleSessionResume(input: SessionResumeToolInput) {
  let session: SessionRecord | undefined;
  try {
    const currentSession = await getSession(input.sessionId);
    session = currentSession;
    return await runSessionExclusive(currentSession, async () => {
      if (input.waitStrategy) {
        await currentSession.page.waitForLoadState(input.waitStrategy, { timeout: input.timeout ?? DEFAULT_ACTION_TIMEOUT_MS });
        await settleAndAssertSafe(currentSession.page, currentSession.requestGuard);
      }
      return buildSessionSnapshotResult(currentSession, input);
    });
  } catch (error) {
    return buildToolError(`Failed to resume session. Error: ${sessionSanitizedError(error, session)}`);
  }
}

export async function handleSessionClose(input: SessionCloseToolInput) {
  const closed = await closeSession(input.sessionId, "requested");
  return buildSuccessContent({
    sessionId: input.sessionId,
    closed,
  });
}
