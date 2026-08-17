import { z } from "zod";
import {
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_ELEMENTS,
  DEFAULT_WAIT_STRATEGY,
  MAX_MAX_CHARS,
  MAX_MAX_ELEMENTS,
  MAX_SEQUENCE_ACTIONS,
} from "../config.js";
import { captchaPolicySchema, stealthProfileSchema, viewportSchema, proxySchema } from "./primitives.js";

export const commonBrowserOptionShape = {
  os: z.enum(["windows", "macos", "linux"]).optional().describe("Optional OS to spoof. Can be 'windows', 'macos', or 'linux'. If not specified, will rotate between all OS types."),
  waitStrategy: z.enum(["domcontentloaded", "load", "networkidle"]).optional().default(DEFAULT_WAIT_STRATEGY).describe("Wait strategy for page load. Defaults to 'domcontentloaded'. 'load' waits for all resources, 'networkidle' waits for network activity to finish."),
  timeout: z.number().min(5000).max(300000).optional().default(60000).describe("Timeout in milliseconds for page load (5-300 seconds)."),
  humanize: z.boolean().optional().describe("Enable realistic cursor movements and human-like behavior for better stealth and anti-detection."),
  locale: z.string().optional().describe("Browser locale (e.g., 'en-US', 'fr-FR')."),
  viewport: viewportSchema,
  block_webrtc: z.boolean().optional().describe("Block WebRTC entirely for enhanced privacy and stealth."),
  proxy: proxySchema,
  enable_cache: z.boolean().optional().describe("Cache pages, requests, etc. Uses more memory but improves performance when revisiting pages."),
  firefox_user_prefs: z.string().optional().describe("JSON object of custom Firefox user preferences (e.g., '{\"browser.send_pings\": false}'). Rejected unless CAMOUFOX_MCP_ALLOW_UNSAFE_OPTIONS=1."),
  exclude_addons: z.array(z.string()).optional().describe("List of default addons to exclude (e.g., ['ublock_origin']). Rejected unless CAMOUFOX_MCP_ALLOW_UNSAFE_OPTIONS=1."),
  window: z.string().optional().describe("Fixed window size as 'widthxheight' (e.g., '1920x1080'). Overrides random generation."),
  args: z.array(z.string()).optional().describe("Additional browser command-line arguments. Rejected unless CAMOUFOX_MCP_ALLOW_UNSAFE_OPTIONS=1."),
  block_images: z.boolean().optional().describe("Block all images for faster loading, reduced bandwidth, and lightweight browsing."),
  block_webgl: z.boolean().optional().describe("Block WebGL to prevent fingerprinting and tracking."),
  disable_coop: z.boolean().optional().describe("Disable Cross-Origin-Opener-Policy for sites that require it."),
  geoip: z.boolean().optional().describe("Automatically detect geolocation based on IP address."),
  headless: z.boolean().optional().describe("Run browser in headless mode. Auto-detects best mode for environment if not specified."),
  includeConsole: z.boolean().optional().describe("Include bounded page console diagnostics in the JSON response."),
  includeNetwork: z.boolean().optional().describe("Include bounded network diagnostics in the JSON response."),
  stealthProfile: stealthProfileSchema,
  captchaPolicy: captchaPolicySchema,
};

export const commonBrowserToolShape = {
  url: z.string().describe("The URL to navigate to. Must be a fully qualified http or https URL."),
  ...commonBrowserOptionShape,
};

export const browseToolShape = {
  ...commonBrowserToolShape,
  url: z.string().describe("The URL to navigate to and retrieve content from. Use this tool when users ask to visit, check, search, navigate, browse, fetch, or scrape websites. Must be a fully qualified URL (e.g., 'https://example.com')."),
  outputMode: z.enum(["text", "html", "metadata"]).optional().default("text").describe("Response content mode. Defaults to visible text. Use 'html' only when raw HTML is explicitly needed."),
  maxChars: z.number().int().min(1000).max(MAX_MAX_CHARS).optional().default(DEFAULT_MAX_CHARS).describe("Maximum text or HTML characters to return."),
  selector: z.string().max(2000).optional().describe("Optional CSS selector to limit extraction to one matching element."),
  screenshot: z.boolean().optional().default(false).describe("Capture a screenshot/image of the page after loading."),
  screenshotFullPage: z.boolean().optional().describe("Capture full page instead of viewport (screenshot only)."),
  screenshotType: z.enum(["png", "jpeg"]).optional().describe("Screenshot image format. Defaults to 'jpeg'. Use 'png' for lossless quality."),
  screenshotQuality: z.number().int().min(1).max(100).optional().describe("JPEG quality 1-100. Defaults to 80. Ignored for PNG."),
};

export const snapshotToolShape = {
  ...commonBrowserToolShape,
  maxChars: z.number().int().min(100).max(MAX_MAX_CHARS).optional().default(DEFAULT_MAX_CHARS).describe("Maximum visible text and ARIA snapshot characters to return."),
  maxElements: z.number().int().min(1).max(MAX_MAX_ELEMENTS).optional().default(DEFAULT_MAX_ELEMENTS).describe("Maximum interactive elements to return."),
  selector: z.string().max(2000).optional().describe("Optional CSS selector to limit snapshot extraction to one matching element."),
};

export const sequenceActionSchema = z.object({
  action: z.string().describe("Action type: click, hover, fill, type, select, press, waitFor, scroll, evaluate."),
  selector: z.string().optional().describe("CSS selector of the target element."),
  value: z.string().optional().describe("Primary value: text to fill/type, key to press, expression to evaluate, dropdown value."),
  option: z.string().optional().describe("Secondary option: delay ms (type), state (waitFor), loadState (waitFor), clickMode (click), maxChars (evaluate)."),
  dx: z.string().optional().describe("Horizontal scroll pixels (scroll)."),
  dy: z.string().optional().describe("Vertical scroll pixels (scroll)."),
});

export const sequenceToolShape = {
  ...commonBrowserToolShape,
  actions: z.array(sequenceActionSchema).max(MAX_SEQUENCE_ACTIONS).describe("Bounded action sequence to run after navigation."),
  outputMode: z.enum(["text", "html", "metadata"]).optional().default("text").describe("Final response content mode."),
  maxChars: z.number().int().min(100).max(MAX_MAX_CHARS).optional().default(DEFAULT_MAX_CHARS).describe("Maximum final text, HTML, snapshot, or evaluate-result characters to return."),
  selector: z.string().max(2000).optional().describe("Optional CSS selector to limit final content extraction to one matching element."),
  maxElements: z.number().int().min(1).max(MAX_MAX_ELEMENTS).optional().default(DEFAULT_MAX_ELEMENTS).describe("Maximum final snapshot elements to return."),
  screenshot: z.boolean().optional().default(false).describe("Capture a screenshot/image after all actions finish."),
  screenshotFullPage: z.boolean().optional().describe("Capture full page instead of viewport (screenshot only)."),
  screenshotType: z.enum(["png", "jpeg"]).optional().describe("Screenshot image format. Defaults to 'jpeg'. Use 'png' for lossless quality."),
  screenshotQuality: z.number().int().min(1).max(100).optional().describe("JPEG quality 1-100. Defaults to 80. Ignored for PNG."),
};

export const selectorLimitShape = {
  selector: z.string().max(2000).optional().describe("Optional CSS selector to limit extraction to one matching element."),
};

export const linksToolShape = {
  ...commonBrowserToolShape,
  ...selectorLimitShape,
  maxLinks: z.number().int().min(1).max(MAX_MAX_ELEMENTS).optional().default(DEFAULT_MAX_ELEMENTS).describe("Maximum links to return."),
};

export const formsToolShape = {
  ...commonBrowserToolShape,
  ...selectorLimitShape,
  maxForms: z.number().int().min(1).max(100).optional().default(20).describe("Maximum forms to return."),
  maxFields: z.number().int().min(1).max(MAX_MAX_ELEMENTS).optional().default(DEFAULT_MAX_ELEMENTS).describe("Maximum fields to return across all forms."),
};

export const outlineToolShape = {
  ...commonBrowserToolShape,
  ...selectorLimitShape,
  maxItems: z.number().int().min(1).max(MAX_MAX_ELEMENTS).optional().default(DEFAULT_MAX_ELEMENTS).describe("Maximum headings and landmarks to return."),
};

export const findToolShape = {
  ...commonBrowserToolShape,
  ...selectorLimitShape,
  query: z.string().min(1).max(500).describe("Visible text to search for on the page."),
  maxMatches: z.number().int().min(1).max(50).optional().default(5).describe("Maximum matches to return."),
  contextChars: z.number().int().min(50).max(2000).optional().default(300).describe("Characters of surrounding visible text to return per match."),
};

export const screenshotToolShape = {
  ...commonBrowserToolShape,
  selector: z.string().max(2000).optional().describe("Optional CSS selector for element-only screenshots."),
  fullPage: z.boolean().optional().default(false).describe("Capture the full page instead of only the viewport."),
  type: z.enum(["png", "jpeg"]).optional().default("jpeg").describe("Screenshot image type. Defaults to 'jpeg'. Use 'png' for lossless quality."),
  quality: z.number().int().min(1).max(100).optional().describe("JPEG quality from 1-100. Defaults to 80. Ignored for PNG."),
};

export const consoleToolShape = {
  ...commonBrowserToolShape,
  // browse_console exists to surface console diagnostics, so default to
  // collecting them. includeNetwork stays caller-controlled (defaults off) and
  // is honored rather than silently overridden by the handler.
  includeConsole: z.boolean().optional().default(true).describe("Include bounded page console diagnostics in the JSON response."),
};

export const networkSummaryToolShape = {
  ...commonBrowserToolShape,
  // browse_network_summary exists to surface network diagnostics, so default to
  // collecting them. includeConsole stays caller-controlled (defaults off).
  includeNetwork: z.boolean().optional().default(true).describe("Include bounded network diagnostics in the JSON response."),
  maxFailures: z.number().int().min(0).max(50).optional().default(10).describe("Maximum failed requests to include in the summary."),
};

export const sessionStartToolShape = {
  ...commonBrowserOptionShape,
  ttlMs: z.number().int().min(30000).max(86400000).optional().describe("Session time-to-live in milliseconds (30s to 24h). Defaults to server config (CAMOUFOX_MCP_SESSION_TTL_MS, 10 min)."),
};

export const sessionIdShape = {
  sessionId: z.string().min(1).max(200).describe("Session ID returned by browse_session_start."),
};

export const sessionNavigateToolShape = {
  ...sessionIdShape,
  url: z.string().describe("The URL to navigate to. Must be a fully qualified http or https URL."),
  waitStrategy: z.enum(["domcontentloaded", "load", "networkidle"]).optional().describe("Optional wait strategy override for this navigation."),
  timeout: z.number().min(5000).max(300000).optional().describe("Optional timeout override for this navigation."),
  outputMode: z.enum(["text", "html", "metadata"]).optional().default("text").describe("Response content mode."),
  maxChars: z.number().int().min(100).max(MAX_MAX_CHARS).optional().default(DEFAULT_MAX_CHARS).describe("Maximum text or HTML characters to return."),
  selector: z.string().max(2000).optional().describe("Optional CSS selector to limit extraction."),
  screenshot: z.boolean().optional().default(false).describe("Capture a screenshot/image of the page after navigation."),
  screenshotFullPage: z.boolean().optional().describe("Capture full page instead of viewport (screenshot only)."),
  screenshotType: z.enum(["png", "jpeg"]).optional().describe("Screenshot image format. Defaults to 'jpeg'. Use 'png' for lossless quality."),
  screenshotQuality: z.number().int().min(1).max(100).optional().describe("JPEG quality 1-100. Defaults to 80. Ignored for PNG."),
  captchaPolicy: captchaPolicySchema,
};

export const sessionActionToolShape = {
  ...sessionIdShape,
  action: sequenceActionSchema.describe("One bounded action to run in the existing session."),
  maxChars: z.number().int().min(100).max(MAX_MAX_CHARS).optional().default(DEFAULT_MAX_CHARS).describe("Maximum final visible text characters to return in snapshot."),
  maxElements: z.number().int().min(1).max(MAX_MAX_ELEMENTS).optional().default(DEFAULT_MAX_ELEMENTS).describe("Maximum final snapshot elements to return."),
  selector: z.string().max(2000).optional().describe("Optional CSS selector to limit final snapshot."),
  screenshot: z.boolean().optional().default(false).describe("Capture a screenshot/image after the action."),
  screenshotFullPage: z.boolean().optional().describe("Capture full page instead of viewport (screenshot only)."),
  screenshotType: z.enum(["png", "jpeg"]).optional().describe("Screenshot image format. Defaults to 'jpeg'. Use 'png' for lossless quality."),
  screenshotQuality: z.number().int().min(1).max(100).optional().describe("JPEG quality 1-100. Defaults to 80. Ignored for PNG."),
  captchaPolicy: captchaPolicySchema,
};

export const sessionSnapshotToolShape = {
  ...sessionIdShape,
  maxChars: z.number().int().min(100).max(MAX_MAX_CHARS).optional().default(DEFAULT_MAX_CHARS).describe("Maximum visible text and ARIA snapshot characters to return."),
  maxElements: z.number().int().min(1).max(MAX_MAX_ELEMENTS).optional().default(DEFAULT_MAX_ELEMENTS).describe("Maximum interactive elements to return."),
  selector: z.string().max(2000).optional().describe("Optional CSS selector to limit snapshot extraction."),
  screenshot: z.boolean().optional().default(false).describe("Capture a screenshot/image of the current page state."),
  screenshotFullPage: z.boolean().optional().describe("Capture full page instead of viewport (screenshot only)."),
  screenshotType: z.enum(["png", "jpeg"]).optional().describe("Screenshot image format. Defaults to 'jpeg'. Use 'png' for lossless quality."),
  screenshotQuality: z.number().int().min(1).max(100).optional().describe("JPEG quality 1-100. Defaults to 80. Ignored for PNG."),
  captchaPolicy: captchaPolicySchema,
};

export const sessionResumeToolShape = {
  ...sessionSnapshotToolShape,
  waitStrategy: z.enum(["domcontentloaded", "load", "networkidle"]).optional().describe("Optional load state to wait for before reading the session."),
  timeout: z.number().min(100).max(60000).optional().default(DEFAULT_ACTION_TIMEOUT_MS).describe("Timeout in milliseconds for the resume wait."),
};

export const sessionCloseToolShape = {
  ...sessionIdShape,
};

export type BrowseToolInput = z.infer<z.ZodObject<typeof browseToolShape>>;
export type SnapshotToolInput = z.infer<z.ZodObject<typeof snapshotToolShape>>;
export type SequenceToolInput = z.infer<z.ZodObject<typeof sequenceToolShape>>;
export type SequenceAction = z.infer<typeof sequenceActionSchema>;
export type LinksToolInput = z.infer<z.ZodObject<typeof linksToolShape>>;
export type FormsToolInput = z.infer<z.ZodObject<typeof formsToolShape>>;
export type OutlineToolInput = z.infer<z.ZodObject<typeof outlineToolShape>>;
export type FindToolInput = z.infer<z.ZodObject<typeof findToolShape>>;
export type ScreenshotToolInput = z.infer<z.ZodObject<typeof screenshotToolShape>>;
export type ConsoleToolInput = z.infer<z.ZodObject<typeof consoleToolShape>>;
export type NetworkSummaryToolInput = z.infer<z.ZodObject<typeof networkSummaryToolShape>>;
export type SessionStartToolInput = z.infer<z.ZodObject<typeof sessionStartToolShape>>;
export type SessionNavigateToolInput = z.infer<z.ZodObject<typeof sessionNavigateToolShape>>;
export type SessionActionToolInput = z.infer<z.ZodObject<typeof sessionActionToolShape>>;
export type SessionSnapshotToolInput = z.infer<z.ZodObject<typeof sessionSnapshotToolShape>>;
export type SessionResumeToolInput = z.infer<z.ZodObject<typeof sessionResumeToolShape>>;
export type SessionCloseToolInput = z.infer<z.ZodObject<typeof sessionCloseToolShape>>;
