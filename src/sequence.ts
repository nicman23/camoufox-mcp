import type { Locator, Page } from "playwright-core";
import chalk from "chalk";
import { ALLOW_EVALUATE, DEFAULT_ACTION_TIMEOUT_MS, DEFAULT_MAX_CHARS, SEQUENCE_TIMEOUT_MS } from "./config.js";
import type { SequenceAction } from "./schemas.js";
import type { ClickMode, RequestGuard, SequenceActionResult } from "./types.js";
import { describeError, serializeBounded, withTimeout } from "./utils.js";
import { settleAndAssertSafe } from "./browser-runtime.js";
import { pressKeyOnDisplay } from "./virtdisplay.js";

interface ParsedAction {
  type: string;
  selector?: string;
  value?: string;
  text?: string;
  key?: string;
  expression?: string;
  delay?: number;
  state?: string;
  loadState?: string;
  clickMode?: ClickMode;
  deltaX?: number;
  deltaY?: number;
  maxChars?: number;
}

function parseAction(raw: SequenceAction): ParsedAction {
  const parsed: ParsedAction = { type: raw.action };
  if (raw.selector) parsed.selector = raw.selector;

  switch (raw.action) {
    case "fill":
    case "select":
      parsed.value = raw.value;
      break;
    case "type":
      parsed.text = raw.value;
      parsed.delay = raw.option ? Number(raw.option) : 0;
      break;
    case "press":
      parsed.key = raw.value;
      break;
    case "evaluate":
      parsed.expression = raw.value;
      parsed.maxChars = raw.option ? Number(raw.option) : DEFAULT_MAX_CHARS;
      break;
    case "click":
      parsed.clickMode = (raw.option as ClickMode) || "dom";
      break;
    case "waitFor":
      if (raw.selector) {
        parsed.state = raw.option || "visible";
      } else {
        parsed.loadState = raw.option || "load";
      }
      break;
    case "scroll":
      parsed.deltaX = raw.dx ? Number(raw.dx) : 0;
      parsed.deltaY = raw.dy ? Number(raw.dy) : 600;
      break;
  }
  return parsed;
}

export function sequenceTimeoutBudget(actions: SequenceAction[]): number {
  return actions.length * DEFAULT_ACTION_TIMEOUT_MS;
}

export function isLocalOperationTimeout(error: unknown): boolean {
  return describeError(error).endsWith(" timed out.");
}

export function resolveLocator(page: Page, selector: string, frame?: string): Locator {
  if (frame) return page.frameLocator(frame).locator(selector).first();
  return page.locator(selector).first();
}

export async function pointerClick(locator: Locator, timeout: number): Promise<void> {
  await locator.click({ timeout });
}

export async function domClick(locator: Locator, timeout: number): Promise<void> {
  // Camoufox's virtual display can hang during low-level mouse clicks in CI.
  // Keep this as DOM activation, without Playwright's stability-gated scroll
  // or pointer hit-testing, until mouse actions are stable under Xvfb.
  await withTimeout(
    locator.evaluate((element: HTMLElement) => {
      const clickable = element as HTMLElement & { click?: () => void };
      if (typeof clickable.click === "function") {
        clickable.click();
        return;
      }

      element.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: window,
      }));
    }),
    timeout,
    "Click action",
  );
}

export async function activateElement(page: Page, selector: string, timeout: number, frame?: string, clickMode: ClickMode = "dom"): Promise<void> {
  const locator = resolveLocator(page, selector, frame);
  await locator.waitFor({ state: "visible", timeout });
  if (!await locator.isEnabled({ timeout })) {
    throw new Error(`Click selector is disabled: ${selector}`);
  }

  if (clickMode === "pointer") {
    await pointerClick(locator, timeout);
    return;
  }

  if (clickMode === "auto") {
    try {
      await pointerClick(locator, timeout);
      return;
    } catch (error) {
      console.error(chalk.yellow(`[Camoufox] Pointer click failed, falling back to DOM click: ${describeError(error)}`));
    }
  }

  await domClick(locator, timeout);
}

export async function runSequenceAction(
  page: Page,
  rawAction: SequenceAction,
  index: number,
  rawUrls: string[],
  secrets: string[],
  display?: string,
): Promise<SequenceActionResult> {
  const action = parseAction(rawAction);
  const started = Date.now();
  const timeout = DEFAULT_ACTION_TIMEOUT_MS;

  switch (action.type) {
    case "click":
      await activateElement(page, action.selector!, timeout, undefined, action.clickMode);
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "hover":
      await resolveLocator(page, action.selector!).hover({ timeout });
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "fill":
      await resolveLocator(page, action.selector!).fill(action.value!, { timeout });
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "type":
      await resolveLocator(page, action.selector!).pressSequentially(action.text!, {
        delay: action.delay ?? 0,
        timeout,
      });
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "select":
      await resolveLocator(page, action.selector!).selectOption(action.value!, { timeout });
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "press":
      if (action.selector) {
        await resolveLocator(page, action.selector).press(action.key!, { timeout });
      } else if (display) {
        // Bare key on a session: send a real X11 key event to the browser
        // window via xdotool on the session's Xephyr display.
        await withTimeout(pressKeyOnDisplay(display, action.key!), timeout, "Press action");
      } else {
        // One-shot (no Xephyr display): fall back to CDP key injection.
        await withTimeout(page.keyboard.press(action.key!), timeout, "Press action");
      }
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "waitFor":
      if (action.selector) {
        await page.waitForSelector(action.selector, { state: (action.state ?? "visible") as "visible" | "hidden" | "attached" | "detached", timeout });
      } else {
        await page.waitForLoadState((action.loadState ?? "load") as "domcontentloaded" | "load" | "networkidle", { timeout });
      }
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };

    case "scroll": {
      const deltaX = action.deltaX ?? 0;
      const deltaY = action.deltaY ?? 600;
      if (action.selector) {
        const locator = resolveLocator(page, action.selector);
        await locator.waitFor({ state: "attached", timeout });
        await withTimeout(
          locator.evaluate(async (element: HTMLElement, { deltaX, deltaY }: { deltaX: number; deltaY: number }) => {
            const target = element as HTMLElement;
            const beforeLeft = target.scrollLeft;
            const beforeTop = target.scrollTop;
            let scrollEventFired = false;
            await new Promise<void>((resolve) => {
              const timer = window.setTimeout(() => resolve(), 100);
              target.addEventListener("scroll", () => {
                scrollEventFired = true;
                window.clearTimeout(timer);
                resolve();
              }, { once: true });
              target.scrollBy(deltaX, deltaY);
              if (target.scrollLeft === beforeLeft && target.scrollTop === beforeTop) {
                window.clearTimeout(timer);
                resolve();
              }
            });
            if (!scrollEventFired && (target.scrollLeft !== beforeLeft || target.scrollTop !== beforeTop)) {
              target.dispatchEvent(new Event("scroll", { bubbles: true }));
            }
          }, { deltaX, deltaY }),
          timeout,
          "Scroll action",
        );
      } else {
        await page.mouse.wheel(deltaX, deltaY);
      }
      return { index, type: action.type, selector: action.selector, status: "ok", durationMs: Date.now() - started };
    }

    case "evaluate": {
      if (!ALLOW_EVALUATE) {
        throw new Error("Evaluate action is disabled by server policy. Set CAMOUFOX_MCP_ALLOW_EVALUATE=1 to enable it.");
      }

      const result = await withTimeout(
        page.evaluate((expression) => globalThis.eval(expression), action.expression!),
        timeout,
        "Evaluate action",
      );
      const serialized = serializeBounded(result, action.maxChars ?? DEFAULT_MAX_CHARS, rawUrls, secrets);
      return {
        index,
        type: action.type,
        status: "ok",
        result: serialized.value,
        resultTruncated: serialized.truncated,
        durationMs: Date.now() - started,
      };
    }

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }
}

export async function runSequenceActionsWithBudget(
  page: Page,
  requestGuard: RequestGuard,
  actionsInput: SequenceAction[],
  rawUrls: string[],
  secrets: string[],
  display?: string,
): Promise<SequenceActionResult[]> {
  const actions: SequenceActionResult[] = [];

  await withTimeout((async () => {
    for (let index = 0; index < actionsInput.length; index += 1) {
      const result = await runSequenceAction(page, actionsInput[index], index, rawUrls, secrets, display);
      actions.push(result);
      await settleAndAssertSafe(page, requestGuard);
    }
  })(), SEQUENCE_TIMEOUT_MS, "Browse sequence");

  return actions;
}
