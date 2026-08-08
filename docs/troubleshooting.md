# Troubleshooting

On a local checkout, run `npm run doctor` first. It checks Node version, the
`camoufox-js` and `playwright-core` pins, the cached browser build, and drives a
real `browse`, printing the exact fix for each failure. It resolves most of the
issues below in one command.

### Common Issues

1. **"Camoufox browser not found" or `browserAvailable: false` after fetch**
   - Run `npm run fetch:camoufox` or `npx -y camoufox-js@0.12.0 fetch` to download the browser. Do **not** omit the `@0.12.0` version pin (a bare `camoufox-js fetch` pulls the latest version, which writes a layout the MCP server cannot read).
   - For Docker, the browser is pre-installed.
   - If the browser is downloaded but status still reports it is missing:
     - **Stale MCP Server Process:** The daemon/gateway process cached the false answer at startup. Restart the daemon/gateway, or remove and re-add the server (e.g., `hermes mcp remove camoufox && hermes mcp add ...`).
     - **Mismatched Directory Layout:** If you fetched without a version pin, you may have the wrong folder layout. Clear the cache and refetch using the pinned version (see item 10).

2. **"Cannot find module"**
   - Ensure you've run `npm install` or are using npx
   - For global install: `npm install -g camoufox-mcp-server@latest`

3. **"MCP server not responding"**
   - Check that the server is properly configured in your AI assistant
   - Verify the command path is correct
   - Check logs for error messages

4. **"Unsafe browser options are disabled"**
   - `firefox_user_prefs`, `args`, and `exclude_addons` require `CAMOUFOX_MCP_ALLOW_UNSAFE_OPTIONS=1`
   - Confirm the active state in `initialize.result.capabilities.extensions["camoufox-mcp"].policy.unsafeOptionsAllowed` or `camoufox_status.unsafeOptionsAllowed`
   - Check stderr for a warning naming the rejected option family

5. **Navigation hangs on sites with long-lived connections**
   - The default `waitStrategy` is `domcontentloaded`
   - If a call overrides it to `load` or `networkidle`, try removing the override or setting `waitStrategy: "domcontentloaded"`

6. **`better-sqlite3` NODE_MODULE_VERSION / ABI mismatch errors**
   - `better-sqlite3` is a dependency of this server, pulled in transitively through `camoufox-js`, which uses it to read a bundled WebGL fingerprint database
   - The native binary is downloaded for the Node ABI of the Node version that ran the install. If the gateway spawns the server with a different Node version (for example npm install under Node 22 but the gateway launches Node 25 via nvm), loading fails with `NODE_MODULE_VERSION X ... requires NODE_MODULE_VERSION Y`
   - As of 2.1.6 this error should no longer occur on Node 22.15+: the server redirects `better-sqlite3` to the built-in `node:sqlite` module, so no native binary is loaded. Set `CAMOUFOX_MCP_NO_SQLITE_SHIM=1` to opt out and use the native module
   - On older Node runtimes, note that when the server is launched via `npx`, its dependencies live in the npx cache (`~/.npm/_npx/<hash>/node_modules`) — rebuilding `better-sqlite3` in another checkout does not fix the copy the server actually loads. Clear the cache (`rm -rf ~/.npm/_npx`) using the same Node version the gateway spawns, or run `npm rebuild better-sqlite3` inside the npx cache directory itself
   - Restart the gateway afterwards so the MCP server process reloads native modules

7. **Hermes MCP tools do not appear or discovery fails**
   - For Hermes direct skill installs, register the MCP server explicitly:
     `hermes mcp add camoufox --command npx --env CAMOUFOX_MCP_ALLOW_UNSAFE_OPTIONS=1 --args -y camoufox-mcp-server@latest`
   - `--args` must be the last option and must receive plain argv tokens, not a JSON array string
   - In `~/.hermes/config.yaml`, `mcp_servers.camoufox.args` must be a YAML list and `CAMOUFOX_MCP_ALLOW_UNSAFE_OPTIONS` must be `"1"` without embedded quote characters
   - Verify with `hermes mcp list` and `hermes mcp test camoufox`, then restart Hermes from a separate terminal
   - Camoufox tools appear as `mcp_camoufox_*`; `browser_navigate` is Hermes' built-in browser, not Camoufox
   - If Hermes reports ambiguous `camoufox` skills, keep only one installed Camoufox skill path or load the categorized path explicitly

8. **OpenClaw still uses an old MCP process after rebuild**
   - Restart the OpenClaw gateway after changing config or rebuilding the server

9. **Cloudflare or other challenge pages instead of content**
   - High-security sites may challenge any automated browser; this is expected and not fully solvable server-side
   - Enable `geoip` so the fingerprint locale/timezone matches the exit IP, and use `humanize` cursor movement
   - Datacenter IPs are heavily challenged; a residential or mobile proxy via the `proxy` option significantly improves pass rates
   - Session tools support challenge pause/resume so a human can complete an interactive challenge when needed

10. **Browser fails to launch / `Library not loaded: @rpath/libmozglue.dylib` after changing binary versions**
    - Overlaying a new browser build onto an old cached bundle corrupts it. Wipe the cache, then refetch; do not fetch over the top:
      `rm -rf ~/Library/Caches/camoufox/Camoufox.app ~/Library/Caches/camoufox/version.json && npx -y camoufox-js@0.12.0 fetch`
    - Linux/Docker cache path: `rm -rf ~/.cache/camoufox && npx -y camoufox-js@0.12.0 fetch` (respects `XDG_CACHE_HOME`)
    - `npm run doctor` reports a version/build mismatch and prints the wipe command

11. **`Browser.setDefaultViewport ... isMobile ... not described in this scheme`, or anti-detection regressed after `npx @latest`**
    - `camoufox-js` floats `playwright-core` (peer `*`). This package pins `playwright-core` as a direct dependency, but npm `overrides` alone would not: they bind only the root project, so a raw `npx`/global install can still pull a newer `playwright-core` than the Camoufox browser supports
    - A `playwright-core` too new for the browser build breaks the Juggler protocol (1.61+ sends an `isMobile` viewport field the browser rejects; 1.60 breaks a navigation guard). Match the pair; do not bump one alone
    - On a checkout, `npm run doctor` fails if `playwright-core` drifted off the pin

12. **`Error: ENOSPC: no space left on device, write` or partial-install errors during fetch**
    - The ~780MB binary download extracts via `/tmp/camoufox-*` temporary directories.
    - On hosts with limited `/tmp` space (such as cloud VMs or containers where `/tmp` is a `tmpfs` capped at 1-2GB), failed attempts leave behind ~680MB temp directories that fill the filesystem.
    - **Fix:** Clear the temporary directories: `rm -rf /tmp/camoufox-*` (only do this if no live Camoufox processes are running), then retry the fetch command.

### Debug Mode

To see detailed logs, run the server directly:

```bash
node dist/index.js
```
