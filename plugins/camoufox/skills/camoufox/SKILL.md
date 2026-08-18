---
name: camoufox
description: Browser automation with Camoufox MCP. Use when an agent needs to browse a URL, extract page text or structure, fill or submit forms, click through a page, screenshot, run diagnostics, drive a multi-step interactive browser session, or tune privacy and anti-detection options through the camoufox-mcp-server MCP server. Also use when a fetch or HTTP request gets blocked, returns a bot wall, or needs a real browser fingerprint.
---

# Camoufox Browser Automation

Camoufox is a privacy-focused Firefox exposed through the `camoufox-mcp-server` MCP server. Reach for it when a plain HTTP fetch is not enough: JavaScript-rendered pages, bot walls, forms, multi-step flows, screenshots, or anything that benefits from a realistic browser fingerprint.

Every tool launches or reuses a real browser, so each call costs time and tokens. The whole skill is about getting the answer in the fewest, narrowest calls. Two habits do most of the work:

1. **Pick the narrowest tool for the question** (see Choosing a Tool). A page's link list, headings, or one text match is far cheaper than its full rendered text.
2. **Bound every call.** Set `maxChars`, `selector`, or `outputMode: "metadata"` so a giant page can't blow up your context.

This skill does not start the server. Confirm an MCP server named `camoufox` is available first. The installable plugin ships this config with unsafe browser options enabled so hard-site tuning can use `firefox_user_prefs`, `args`, and `exclude_addons`:

```json
{
  "mcpServers": {
    "camoufox": {
      "command": "npx",
      "args": ["-y", "camoufox-mcp-server@latest"],
      "env": { "CAMOUFOX_MCP_ALLOW_UNSAFE_OPTIONS": "1" }
    }
  }
}
```

Bare `npx -y camoufox-mcp-server@latest` remains safe by default unless the host config adds that env var.

On a fresh machine the first `browse` needs the Camoufox binary (~780MB), which npx installs do not prefetch. If a call returns `Camoufox browser binary not installed. Run: npx -y camoufox-js@0.12.0 fetch`, run that one-time command (it lands in the shared OS cache; do not omit the version pin) and retry.

## Bring the Server Up (operator / local checkout)

`npx camoufox-mcp-server@latest` self-installs, but a local checkout or a first
run needs the browser binary fetched and a preflight before you trust it:

```bash
npm install            # Node >=22 required
npm run build          # compile dist/
npm run fetch:camoufox # download the Camoufox browser binary
npm run doctor         # preflight: pins, cached binary, live browse smoke test
```

`npm run doctor` is the guardrail. It verifies Node >=22, the exact `camoufox-js`
pin, that `playwright-core` resolves to the pinned version (it floats otherwise),
that the cached browser build matches the expected one, and then drives a real
`browse` to prove the browser actually launches. Run it first whenever the server
misbehaves; it prints the exact fix (including the cache wipe command) for each
failure. Then register the server with your host (see Host Setup Failures below
for Hermes).

## Tool Names

Hosts expose MCP tool names differently. Use whatever the host lists; common forms:

- Hermes style: `mcp_camoufox_browse` (single underscore, `mcp_<server>_<tool>`; some setups show the double `mcp__camoufox__browse`)
- Claude Code style: `mcp__camoufox__browse`
- OpenClaw bundle style: `camoufox__browse`
- Raw MCP name: `browse`

This skill uses raw names (`browse`, `browse_find`, ...). Map them to your host's form.

In Hermes, `browser_navigate` is the built-in browser tool, not Camoufox. Use the `mcp_camoufox_*` tools after `hermes mcp test camoufox` succeeds.

## Choosing a Tool

Start from the question, not from `browse`. `browse` returns a wall of page text; the extractor tools return only the slice you asked for, which keeps your context small and the answer easy to read.

| You want | Use | Why |
| --- | --- | --- |
| Just confirm a page loads / get title + status | `browse` with `outputMode: "metadata"` | No body text at all |
| The page's readable text / article body | `browse` (default `text`), set `maxChars` | Bounded visible text |
| Raw HTML (only if you truly need markup) | `browse` with `outputMode: "html"` | Skip unless parsing markup |
| All links on the page | `browse_links` | Structured list, no body noise |
| Form fields and submit buttons | `browse_forms` | Names, types, controls only |
| Page structure / headings / sections | `browse_outline` | Headings + landmarks |
| Does the page contain "X"? Where? | `browse_find` with `query` | Bounded context around matches |
| What can I click/type? (interactive map) | `browse_snapshot` | Visible text + ARIA + elements |
| Navigate + a few actions, then read once | `browse_sequence` | One round trip, bounded actions |
| A screenshot | `browse_screenshot` (or `screenshot: true` on `browse`) | Image output |
| Console errors / failed requests | `browse_console`, `browse_network_summary` | Focused diagnostics |
| Multi-step flow with state between calls | session tools | Persistent page across calls |

Rules of thumb:

- Need one fact from a page? `browse_find` beats reading the whole thing.
- If the page you want has a predictable URL (`.../page/2/`, a category, a permalink), navigate straight to it. Reserve `browse_sequence` click-throughs for when the destination URL isn't knowable up front: search results, JS-built navigation, a control with no stable href. Clicking your way to a page you could have requested directly is slower and more fragile.
- Need to act, then read the result, in one shot? `browse_sequence`. Need to keep a logged-in / cookie-bearing page alive across several *unscripted* decisions? A session.
- `selector` scopes an extractor to **one** matching element (e.g. `selector: "main"`). Two failure modes follow: a selector that matches nothing returns empty (not an error), and a per-item selector on a list (e.g. `.quote .author`) returns only the *first* item. For a whole list, scope to the container or drop the selector. If a scoped call comes back empty or short, widen it rather than piling on more calls chasing the same wrong selector.
- Want exact or long text the page truncates visually (ellipsised titles, styled labels)? `browse_snapshot` reads element names from the ARIA tree, which keeps the full string where `browse` visible-text may cut it off.

## First Check

Call `camoufox_status` before relying on advanced behavior. It returns server, browser, queue, session, and policy state without launching a page.

Fields worth reading:

- `browserAvailable`: must be `true`, or nothing will run.
- `unsafeOptionsAllowed`: must be `true` before sending `firefox_user_prefs`, `args`, or `exclude_addons`.
- `evaluateAllowed`: must be `true` before using the `evaluate` action in a sequence/session.
- `maxConcurrency`, `maxQueue`, `maxSessions`, `sessionTtlMs`: capacity limits. Sessions auto-expire after `sessionTtlMs`; don't start more than `maxSessions`.
- `activeSessions`, `queuedRequests`: current load.
- `networkSecurity`: the server's application-layer URL policy. `ssrfPolicy: "app_layer_best_effort"` means best-effort SSRF filtering, not proof of network isolation. Check `warning` and `strictSandboxRequired`.

The active default wait strategy and stealth profile are advertised separately, during MCP `initialize`, at `result.capabilities.extensions["camoufox-mcp"].policy` (`defaultWaitStrategy`, `defaultStealthProfile`) — not in the `camoufox_status` body.

Packaged plugin default: the bundled config sets `CAMOUFOX_MCP_ALLOW_UNSAFE_OPTIONS=1`. Bare server installs do not. Do not add `CAMOUFOX_MCP_ALLOW_EVALUATE` unless the user or project config explicitly opts in.

## Common Calls

Metadata only (does it load? title? status):

```json
{ "url": "https://example.com", "outputMode": "metadata" }
```

Bounded visible text:

```json
{ "url": "https://example.com", "maxChars": 12000 }
```

Find one thing on a page (cheap, targeted):

```json
{ "url": "https://example.com", "query": "pricing", "maxMatches": 3 }
```

Map what's interactive before acting:

```json
{ "url": "https://example.com", "maxElements": 80 }
```

Navigate, act, read once (no session needed):

```json
{
  "url": "https://example.com/login",
  "actions": [
    { "action": "fill", "selector": "#user", "value": "alice" },
    { "action": "fill", "selector": "#pass", "value": "secret" },
    { "action": "click", "selector": "button[type=submit]" },
    { "action": "waitFor", "option": "domcontentloaded" }
  ],
  "maxChars": 8000
}
```

Screenshot (JPEG q80 by default; use `"screenshotType": "png"` for lossless):

```json
{ "url": "https://example.com", "screenshot": true }
```

## Sequence Actions

`browse_sequence` (one round trip) and `browse_session_action` (one action in a live session) both take the same flat 6-field action objects. All fields are optional strings except `action`:

| Field | Purpose |
| --- | --- |
| `action` | Action type: `click`, `hover`, `fill`, `type`, `select`, `press`, `waitFor`, `scroll`, `evaluate` |
| `selector` | CSS selector of the target element |
| `value` | Primary value: text to fill/type, key to press, expression to evaluate, dropdown value |
| `option` | Secondary: delay ms (type), state (waitFor), loadState (waitFor), clickMode (click), maxChars (evaluate) |
| `dx` | Horizontal scroll pixels (scroll) |
| `dy` | Vertical scroll pixels (scroll) |

Two things to remember up front:

- Prefer `fill` for setting an input's value; use `type` only when you need real per-keystroke events (set `option` to the delay in ms).
- `evaluate` runs arbitrary JS and is disabled unless the operator sets `CAMOUFOX_MCP_ALLOW_EVALUATE=1` (check `evaluateAllowed` in status first).

## Interactive Sessions

Use a session when you need the *same* page (cookies, login, scroll position, JS state) across several decisions you can't script up front — e.g. log in, look at the result, then decide where to go next. For a fixed known sequence, `browse_sequence` is cheaper because it's a single call.

### Persistent Profiles

Sessions use a persistent browser profile (`userDataDir`) so cookies, localStorage, and browser fingerprint survive across browser restarts and host restarts. Each session gets its own profile at `$CAMOUFOX_MCP_PROFILE_DIR/<sessionId>` (default: `~/.camoufox-mcp/profiles/`). This means:

- Log in once → the fingerprint stays consistent → Cloudflare/anti-bot services recognize the returning visitor → fewer CAPTCHAs on subsequent visits.
- The profile persists on disk after the session closes. Reuse the same session ID to pick up where you left off (or start a new session for a fresh identity).

### TTL

Sessions auto-expire after their TTL (sliding — every interaction resets the timer). Default is `sessionTtlMs` from server config (10 min). Override per-session with `ttlMs` on `browse_session_start` (30s to 24h):

```json
{ "ttlMs": 86400000 }  // 24-hour session
```

Always close sessions when done so you don't hold a browser slot.

### Lifecycle

1. `browse_session_start` → returns a `sessionId`. Pass stealth/privacy options here; they apply for the session's life. Accepts `ttlMs` for custom expiry.
2. `browse_session_navigate` → go to a URL in that session. Supports `screenshot: true`.
3. `browse_session_action` → run one action (same 6-field action objects as sequences). Supports `screenshot: true`.
4. `browse_session_snapshot` → read current visible text + interactive elements without acting. Supports `screenshot: true`.
5. `browse_session_resume` → after a paused CAPTCHA or human step, wait for load state and re-read.
6. `browse_session_close` → free the slot (profile data persists on disk).

### Screenshots on Session Tools

All session tools accept `screenshot`, `screenshotFullPage`, `screenshotType`, `screenshotQuality`. Default format is **JPEG q80** (~3-5x smaller than PNG in context). Use `"screenshotType": "png"` for lossless quality when needed.

Worked example — log in, then branch based on what you see:

```json
// 1. start (24h session for a persistent identity)
{ "ttlMs": 86400000 }  // → { "sessionId": "abc123", ... }

// 2. navigate with screenshot (browse_session_navigate)
{ "sessionId": "abc123", "url": "https://example.com/login", "screenshot": true }

// 3. fill + submit (browse_session_action, one per call)
{ "sessionId": "abc123", "action": { "action": "fill", "selector": "#user", "value": "alice" } }
{ "sessionId": "abc123", "action": { "action": "fill", "selector": "#pass", "value": "secret" } }
{ "sessionId": "abc123", "action": { "action": "click", "selector": "button[type=submit]" } }

// 4. read state and decide (browse_session_snapshot)
{ "sessionId": "abc123", "maxElements": 60, "screenshot": true }

// 5. close (browse_session_close) — profile persists on disk
{ "sessionId": "abc123" }
```

If a navigation or action returns a CAPTCHA pause, hand control to the user, then call `browse_session_resume` with the same `sessionId` once they've solved it.

## Stealth Profiles

Use `stealthProfile` as a shortcut, then override individual options only when needed.

| Profile | Use |
| --- | --- |
| `normal` | Default for most browsing. Humanized cursor, GeoIP, WebRTC blocked. |
| `privacy` | Adds WebGL blocking. More private, but can be more detectable on strict sites. |
| `human_assisted` | Visible browser and cache enabled, for when a human may need to interact. |
| `fast` | Blocks images and disables humanization for speed. More detectable. |
| `debug` | Enables console and network diagnostics. |

## Hard-Site Tuning

This is carried-over tuning guidance, not a fresh verification claim. Re-test with `camoufox_status` and a small `browse` call in your environment before relying on it.

For Reddit and similarly strict sites:

- Prefer `stealthProfile: "normal"` and `os: "windows"`.
- Leave `locale` unset unless the user or operator explicitly asks for locale testing. If you set it, match the approved target locale and align `intl.accept_languages` to the same locale family.
- Keep the default `waitStrategy: "domcontentloaded"`; it's safer for sites that hold connections open or redirect after the first HTML.
- Avoid `stealthProfile: "privacy"` if WebGL blocking itself seems to trigger detection.
- `firefox_user_prefs` requires `unsafeOptionsAllowed: true`. Some prefs (e.g. `dom.serviceWorkers.enabled`) are denied even then; remove any pref the server rejects.

Opt-in tuning payload:

```json
{
  "url": "https://www.reddit.com/",
  "stealthProfile": "normal",
  "os": "windows",
  "timeout": 30000,
  "firefox_user_prefs": {
    "media.navigator.enabled": false,
    "privacy.resistFingerprinting": true,
    "network.http.altsvc.enabled": false,
    "dom.battery.enabled": false
  }
}
```

If locale testing is explicitly approved, add matching values such as:

```json
{
  "locale": "<approved-locale>",
  "firefox_user_prefs": {
    "intl.accept_languages": "<approved-locale>,<base-language>;q=0.9"
  }
}
```

## CAPTCHA Handling

The server does not solve CAPTCHAs. It surfaces bounded challenge context for the user or host agent. Set `captchaPolicy`:

- `detect`: report challenge signals only.
- `pause`: return state for manual action, then call `browse_session_resume`.
- `fail`: return an error when a challenge is detected.
- `attempt`: return enhanced metadata (provider, iframe hints, suggested strategy, bounded screenshot). Still no hidden bypass.

`CAPTCHA_AUTONOMOUS=true` marks handling as LLM-assisted and may add provider playbooks, but the server still performs no covert bypass. Use `disable_coop: true` only when iframe interaction needs it.

**False-positive mitigation:** The server waits 5 seconds and re-checks once before surfacing a challenge. Only visible iframes and specific challenge DOM elements (`#challenge-stage`, `.cf-turnstile`, etc.) trigger detection — hidden auth iframes and CDN script references no longer produce false positives.

## Vision-Heavy Tasks: Use Subagents

When a task requires inspecting screenshots to make decisions (solving a visual CAPTCHA, identifying and clicking a specific image, reading rendered text), **delegate to a subagent** rather than processing the image in the main conversation context.

Each screenshot consumes significant context (~130K base64 chars even at JPEG q80). Vision-heavy workflows that take multiple screenshots quickly exhaust the main context window.

**Pattern:**
1. Main agent navigates and captures a screenshot (or uses `captchaPolicy: "attempt"`).
2. Spawn a subagent: "Given this page state, identify the target element and return its CSS selector."
3. Subagent inspects the image, returns a concise answer (selector or coordinates).
4. Main agent executes the returned action via `browse_session_action`.

**Delegate when:** solving visual CAPTCHAs, finding/clicking specific visual elements, verifying visual state, or any task requiring 2+ screenshot inspections.

**Do NOT delegate:** simple text extraction (use `outputMode: "text"`), single confirmation screenshots.

## Debugging

Read `references/json-rpc-debug.md` when the host hasn't registered the server or you need to test it through raw JSON-RPC.

## Host Setup Failures

Native module errors such as `better-sqlite3` compiled for the wrong Node.js version (`NODE_MODULE_VERSION` mismatch) come from this server's own dependency tree: `camoufox-js` pulls in `better-sqlite3`, whose native binary is tied to the Node version that ran the install. On Node 22.15+ the server (2.1.6+) avoids the native module entirely by using the built-in `node:sqlite`, so first make sure the gateway launches an up-to-date server version. If the error persists on an older Node, remember that `npx` keeps its own dependency copy under `~/.npm/_npx/<hash>/node_modules` — rebuilding another checkout does not fix it; clear the npx cache (`rm -rf ~/.npm/_npx`) using the same Node version the gateway spawns, then restart the gateway because the old MCP process keeps the old native module loaded. On a local checkout, `npm run doctor` surfaces most launch-blocking problems before a `browse` fails.

If the host blocks direct config edits, do not patch protected files. Use the host CLI or tell the operator exactly what to add. For Hermes, this verified command registers Camoufox with unsafe browser options enabled:

```bash
printf "Y\n" | hermes mcp add camoufox --command npx --env CAMOUFOX_MCP_ALLOW_UNSAFE_OPTIONS=1 --args -y camoufox-mcp-server@latest
```

> **Hermes TTY Gotcha:** `hermes mcp add` interactively prompts `"Enable all 17 tools? [Y/n/select]"`. On a non-TTY (piped/scripted inputs), the default response is `"n"` (canceled). Pipe `Y\n` as shown above to automatically enable the tools.

Hermes `--env` values are `KEY=VALUE`. `--args` must be the last option and receives plain argv tokens, not a JSON array string. To verify the saved MCP server entry, run `hermes mcp list`; the entry should look like this:

```yaml
mcp_servers:
  camoufox:
    command: npx
    args:
      - -y
      - camoufox-mcp-server@latest
    enabled: true
    env:
      CAMOUFOX_MCP_ALLOW_UNSAFE_OPTIONS: "1"
```

For local development, use `command: node` and a one-item `args` list containing the absolute `dist/index.js` path. Then run `hermes mcp list`, `hermes mcp test camoufox`, restart the gateway from a separate terminal, and confirm with `mcp_camoufox_camoufox_status.unsafeOptionsAllowed`.

If Hermes reports an ambiguous `camoufox` skill, keep only one installed Camoufox skill path or load the categorized path explicitly.

Common failures:

- **Missing tools**: server not installed/enabled, or plugin installed but not reloaded.
- **Unsafe option rejected**: `CAMOUFOX_MCP_ALLOW_UNSAFE_OPTIONS` not set, or a denied pref/arg was sent. The server logs which option family it rejected.
- **`evaluate` rejected**: `CAMOUFOX_MCP_ALLOW_EVALUATE` not set (`evaluateAllowed: false`).
- **Hanging navigation**: a call overrode `waitStrategy` to `load`/`networkidle`; revert to `domcontentloaded` and try a shorter `timeout`.
- **Empty output**: narrow with `selector`, switch to `browse_snapshot`, or check `browse_console` and `browse_network_summary`.
- **Browser won't launch / `Library not loaded: @rpath/libmozglue.dylib`**: a corrupt or mismatched binary cache, usually from fetching a new build over an old one. Wipe the cache and refetch rather than overlaying: `rm -rf ~/Library/Caches/camoufox/Camoufox.app ~/Library/Caches/camoufox/version.json && npx -y camoufox-js@0.12.0 fetch` (Linux: `rm -rf ~/.cache/camoufox && npx -y camoufox-js@0.12.0 fetch`). `npm run doctor` reports the mismatch and prints this command.
- **`Error: ENOSPC: no space left on device` during fetch**: The ~780MB binary extracts via `/tmp/camoufox-*` temporary directories. On cloud VMs/containers with small `/tmp` tmpfs limits (e.g., 1-2GB), failed attempts leave behind ~680MB temp directories that cause disk space errors on retry. Clean them up with `rm -rf /tmp/camoufox-*` (safe if no live processes own them) before refetching.
- **Anti-detection suddenly worse / Juggler errors after `npx @latest`**: `camoufox-js` floats `playwright-core`, so a foreign install can drift it off the pinned version. On a checkout the `overrides` pin holds it; `npm run doctor` flags a drift.
