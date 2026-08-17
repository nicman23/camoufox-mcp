import { z } from "zod";
import { DEFAULT_STEALTH_PROFILE } from "../config.js";

export const viewportSchema = z.object({
  width: z.number().min(320).max(3840).default(1920),
  height: z.number().min(240).max(2160).default(1080),
}).optional().describe("Custom viewport dimensions.");

export const proxySchema = z.string().optional().describe("Proxy URL (e.g., 'http://user:pass@proxy.example.com:8080'). Checked against the same local-network URL policy as page requests.");


export const stealthProfileSchema = z.enum(["normal", "privacy", "human_assisted", "fast", "debug"]).optional().default(DEFAULT_STEALTH_PROFILE)
  .describe("Convenience profile for common Camoufox browser settings. Explicit options override profile values.");
export const captchaPolicySchema = z.enum(["detect", "pause", "fail", "attempt"]).optional()
  .describe("Challenge handling policy. 'detect' reports signals, 'pause' returns state for human action, 'fail' returns an error, 'attempt' returns enhanced challenge metadata, interactive elements, a bounded screenshot, and a suggested strategy. When CAPTCHA_AUTONOMOUS=true, responses are marked for LLM-assisted handling and include provider-specific challengePlaybook context when known.");
export const anyOutputSchema = z.object({}).passthrough();

export const consoleDiagnosticOutputSchema = z.object({
  type: z.string(),
  text: z.string(),
  location: z.object({
    url: z.string().optional(),
    lineNumber: z.number().optional(),
    columnNumber: z.number().optional(),
  }).optional(),
});

export const networkDiagnosticOutputSchema = z.object({
  url: z.string(),
  method: z.string(),
  resourceType: z.string(),
  status: z.number().optional(),
  contentType: z.string().optional(),
  failed: z.boolean().optional(),
  errorText: z.string().optional(),
});

export const diagnosticsOutputSchema = z.object({
  console: z.array(consoleDiagnosticOutputSchema).optional(),
  network: z.array(networkDiagnosticOutputSchema).optional(),
  consoleTruncated: z.boolean().optional(),
  networkTruncated: z.boolean().optional(),
}).optional();

export const captchaIframeOutputSchema = z.object({
  selector: z.string(),
  src: z.string(),
  title: z.string().optional(),
});

export const captchaElementOutputSchema = z.object({
  selector: z.string(),
  frame: z.string().optional(),
  type: z.enum(["checkbox", "input", "button", "image"]),
  label: z.string().optional(),
});

export const captchaDetectionOutputShape = {
  captchaDetected: z.boolean().optional(),
  challengeSignals: z.array(z.string()).optional(),
  challengeHandling: z.enum(["manual", "llm_assisted"]).optional(),
  requiresUserAction: z.boolean().optional(),
  challengeType: z.literal("captcha_or_bot_check").optional(),
  message: z.string().optional(),
  challengeProvider: z.enum(["recaptcha", "hcaptcha", "turnstile", "cloudflare", "text_captcha", "generic"]).optional(),
  captchaIframes: z.array(captchaIframeOutputSchema).optional(),
  interactiveElements: z.array(captchaElementOutputSchema).optional(),
  suggestedStrategy: z.string().optional(),
  challengePlaybook: z.string().optional(),
};
