import type { Page } from "playwright-core";
import chalk from "chalk";
import { MAX_SCREENSHOT_AREA, MAX_SCREENSHOT_BYTES, MAX_SCREENSHOT_HEIGHT, MAX_SCREENSHOT_WIDTH } from "./config.js";
import type { ScreenshotMetadata, ScreenshotOptions, ScreenshotResult, WindowSize } from "./types.js";
import { describeError } from "./utils.js";

export function isScreenshotDimensionAllowed(viewport?: { width: number; height: number }, window?: WindowSize): boolean {
  const width = viewport?.width ?? window?.[0] ?? MAX_SCREENSHOT_WIDTH;
  const height = viewport?.height ?? window?.[1] ?? MAX_SCREENSHOT_HEIGHT;
  return width <= MAX_SCREENSHOT_WIDTH && height <= MAX_SCREENSHOT_HEIGHT;
}

export function isScreenshotAreaAllowed(width: number, height: number): boolean {
  return Number.isFinite(width)
    && Number.isFinite(height)
    && width > 0
    && height > 0
    && width <= MAX_SCREENSHOT_WIDTH
    && height <= MAX_SCREENSHOT_HEIGHT
    && width * height <= MAX_SCREENSHOT_AREA;
}

export async function captureCaptchaScreenshot(page: Page, safeUrl: string): Promise<ScreenshotResult | undefined> {
  try {
    return await captureScreenshot(page, safeUrl, { fullPage: false });
  } catch {
    return undefined;
  }
}

export async function captureScreenshot(page: Page, safeUrl: string, options?: ScreenshotOptions): Promise<ScreenshotResult> {
  const type = options?.type ?? "jpeg";
  const screenshotMetadata: ScreenshotMetadata = {
    requested: true,
    included: false,
    maxBytes: MAX_SCREENSHOT_BYTES,
    type,
    fullPage: options?.selector ? false : Boolean(options?.fullPage),
    selector: options?.selector,
  };
  const mimeType = type === "jpeg" ? "image/jpeg" : "image/png";
  const baseOptions = {
    type,
    quality: type === "jpeg" ? (options?.quality ?? 80) : undefined,
  };

  try {
    let buffer: Buffer;
    if (options?.selector) {
      const locator = page.locator(options.selector).first();
      const count = await locator.count();
      if (count === 0) {
        screenshotMetadata.selectorFound = false;
        screenshotMetadata.error = "Screenshot selector was not found.";
        return { screenshotMetadata, mimeType };
      }

      screenshotMetadata.selectorFound = true;
      const clip = await locator.evaluate((element) => {
        element.scrollIntoView({ block: "center", inline: "center" });
        const rect = element.getBoundingClientRect();
        return {
          x: Math.max(0, rect.x),
          y: Math.max(0, rect.y),
          width: rect.width,
          height: rect.height,
        };
      });

      // Clamp the clip to the page viewport. After scrollIntoView a partially
      // offscreen element can yield a rect that extends past the viewport edge,
      // and Playwright rejects clips whose x/y/width/height fall outside it.
      // viewportSize() is null when no fixed viewport is set; in that case keep
      // the raw rect and let the dimension policy + screenshot call decide.
      const viewport = page.viewportSize();
      let clampedClip = clip;
      if (viewport) {
        const x = Math.max(0, Math.min(clip.x, viewport.width));
        const y = Math.max(0, Math.min(clip.y, viewport.height));
        clampedClip = {
          x,
          y,
          width: Math.max(0, Math.min(clip.width, viewport.width - x)),
          height: Math.max(0, Math.min(clip.height, viewport.height - y)),
        };
      }

      if (clip.width <= 0 || clip.height <= 0) {
        screenshotMetadata.error = "Screenshot selector has no visible area.";
        return { screenshotMetadata, mimeType };
      }

      // Enforce the dimension policy on the element's real size, not the
      // clamped clip; clamping would otherwise shrink an oversize element under
      // the limit and silently bypass the policy.
      if (!isScreenshotAreaAllowed(clip.width, clip.height)) {
        screenshotMetadata.error = `Screenshot selector exceeds server dimension policy (${MAX_SCREENSHOT_WIDTH}x${MAX_SCREENSHOT_HEIGHT}).`;
        return { screenshotMetadata, mimeType };
      }

      if (clampedClip.width <= 0 || clampedClip.height <= 0) {
        screenshotMetadata.error = "Screenshot selector has no visible area.";
        return { screenshotMetadata, mimeType };
      }

      buffer = await page.screenshot({
        ...baseOptions,
        clip: clampedClip,
      });
    } else {
      if (options?.fullPage) {
        const dimensions = await page.evaluate(() => {
          const documentElement = document.documentElement;
          const body = document.body;
          return {
            width: Math.max(
              documentElement.scrollWidth,
              documentElement.clientWidth,
              body?.scrollWidth ?? 0,
              body?.clientWidth ?? 0,
            ),
            height: Math.max(
              documentElement.scrollHeight,
              documentElement.clientHeight,
              body?.scrollHeight ?? 0,
              body?.clientHeight ?? 0,
            ),
          };
        });

        if (!isScreenshotAreaAllowed(dimensions.width, dimensions.height)) {
          screenshotMetadata.error = `Full-page screenshot exceeds server dimension policy (${MAX_SCREENSHOT_WIDTH}x${MAX_SCREENSHOT_HEIGHT}).`;
          return { screenshotMetadata, mimeType };
        }
      }

      buffer = await page.screenshot({
        ...baseOptions,
        fullPage: Boolean(options?.fullPage),
      });
    }

    screenshotMetadata.bytes = buffer.length;

    if (buffer.length > MAX_SCREENSHOT_BYTES) {
      screenshotMetadata.error = "Screenshot exceeded server byte limit.";
      console.error(chalk.yellow(`[Camoufox] Screenshot omitted for ${safeUrl}: byte limit exceeded.`));
      return { screenshotMetadata, mimeType };
    }

    console.error(chalk.green(`[Camoufox] Screenshot captured for ${safeUrl}.`));
    return {
      screenshotMetadata: {
        ...screenshotMetadata,
        included: true,
      },
      mimeType,
      base64: buffer.toString("base64"),
    };
  } catch (screenshotError) {
    screenshotMetadata.error = describeError(screenshotError);
    console.error(chalk.yellow(`[Camoufox] Screenshot failed: ${screenshotMetadata.error}`));
    return { screenshotMetadata, mimeType };
  }
}
