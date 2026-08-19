import type { Browser, BrowserContext, Page, Response } from "playwright-core";
import type { CaptchaPolicy, DiagnosticsPayload, ScreenshotMetadata } from "./payload-types.js";
import type { XephyrDisplay } from "./virtdisplay.js";

export type BrowserInstance = Browser;
export type SupportedOs = "windows" | "macos" | "linux";
export type HeadlessMode = boolean | "virtual";
export type WaitStrategy = "domcontentloaded" | "load" | "networkidle";
export type ClickMode = "dom" | "pointer" | "auto";
export type StealthProfile = "normal" | "privacy" | "human_assisted" | "fast" | "debug";
export type WindowSize = [number, number];
export type SlotRelease = () => void;
export type ProxyConfig = string;

export interface RequestGuard {
  assertAllowed(): void;
  watchPage(page: Page): void;
  // Reset the per-navigation request budget. Long-lived sessions reuse one
  // context across navigations; without a reset the lifetime budget is
  // exhausted after a handful of heavy pages and every request is blocked.
  resetBudget(): void;
}

export interface SessionRecord {
  id: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  requestGuard: RequestGuard;
  diagnostics: DiagnosticsCollector;
  selectedOS: SupportedOs;
  waitStrategy: WaitStrategy;
  // CAPTCHA policy persisted at session start so the documented "pause" default
  // drives detection on every subsequent navigate/action/snapshot/resume without
  // the caller re-passing captchaPolicy on each call.
  captchaPolicy: CaptchaPolicy;
  ttlMs: number;
  releaseSlot: SlotRelease;
  rawUrls: string[];
  secrets: string[];
  createdAt: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
  lastNavigationResponse: Response | null;
  op: Promise<void>;
  closing: boolean;
  closed: boolean;
  // The session's own Xephyr display (Linux "virtual" mode). Launched at
  // session start and torn down in closeSessionNow so its lifetime matches the
  // session exactly, independent of the browser close path.
  xephyr?: XephyrDisplay;
}

export interface CamoufoxOptions {
  os?: SupportedOs[];
  headless?: HeadlessMode;
  humanize?: boolean;
  geoip?: boolean;
  ublock?: boolean;
  block_webgl?: boolean;
  block_images?: boolean;
  block_webrtc?: boolean;
  disable_coop?: boolean;
  locale?: string;
  viewport?: { width: number; height: number };
  proxy?: ProxyConfig;
  enable_cache?: boolean;
  firefox_user_prefs?: Record<string, unknown>;
  exclude_addons?: string[];
  window?: WindowSize;
  args?: string[];
  user_data_dir?: string;
  virtual_display?: string;
  // Explicit environment for the browser process. Set by the session layer to
  // point DISPLAY at the session's own Xephyr so the browser reliably inherits
  // it (rather than relying on camoufox-js mutating the shared process.env).
  env?: Record<string, string>;
}

export interface BrowserLaunchInput {
  os?: SupportedOs;
  waitStrategy?: WaitStrategy;
  timeout?: number;
  humanize?: boolean;
  locale?: string;
  viewport?: { width: number; height: number };
  block_webrtc?: boolean;
  proxy?: ProxyConfig;
  enable_cache?: boolean;
  firefox_user_prefs?: string;
  exclude_addons?: string[];
  window?: string;
  args?: string[];
  block_images?: boolean;
  block_webgl?: boolean;
  disable_coop?: boolean;
  geoip?: boolean;
  headless?: boolean;
  includeConsole?: boolean;
  includeNetwork?: boolean;
  stealthProfile?: StealthProfile;
  captchaPolicy?: CaptchaPolicy;
}

export interface ExtractedContent {
  value: string;
  truncated: boolean;
  found: boolean;
}

export interface ScreenshotResult {
  screenshotMetadata: ScreenshotMetadata;
  mimeType: string;
  base64?: string;
}

export interface CommonBrowserInput extends BrowserLaunchInput {
  url: string;
}

export interface BrowserOperationContext {
  page: Page;
  response: Response | null;
  requestGuard: RequestGuard;
  diagnostics: DiagnosticsCollector;
  selectedOS: SupportedOs;
  waitStrategy: WaitStrategy;
  getLastNavigationResponse: () => Response | null;
}

export interface DiagnosticsCollector {
  payload(): DiagnosticsPayload | undefined;
}
