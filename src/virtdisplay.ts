import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomInt } from "node:crypto";
import { access } from "node:fs/promises";

export interface XephyrDisplay {
  display: string;
  pid: number;
  close: () => Promise<void>;
}

// camoufox-mcp owns its X server so it never attaches to the ambient DISPLAY
// (the user's desktop) or another project's Xephyr. Display numbers are drawn
// from a high, sparse range and verified free before use to avoid collisions.
const DISPLAY_MIN = 200;
const DISPLAY_MAX = 299;
const READY_TIMEOUT_MS = 10000;
const READY_POLL_MS = 100;

// The host display captured at module load — before any browser launch can
// mutate process.env.DISPLAY (camoufox-js does exactly that when it spawns
// its own Xvfb). Xephyr must always attach to this display, whatever
// process.env says later.
const HOST_DISPLAY = process.env.DISPLAY;

let xephyrAvailable: boolean | undefined;

export async function isXephyrAvailable(): Promise<boolean> {
  if (xephyrAvailable !== undefined) return xephyrAvailable;
  // Without a host display there is nothing for Xephyr to embed in — defer to
  // camoufox-js's off-screen Xvfb instead.
  if (!HOST_DISPLAY) {
    xephyrAvailable = false;
    return false;
  }
  try {
    await access("/usr/bin/Xephyr");
    xephyrAvailable = true;
  } catch {
    xephyrAvailable = await probePath("Xephyr");
  }
  return xephyrAvailable;
}

async function probePath(binary: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("which", [binary], (error) => resolve(!error));
  });
}

// A display is free when xdpyinfo cannot connect to it.
function isDisplayInUse(display: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("xdpyinfo", ["-display", display], (error) => resolve(!error));
  });
}

async function findFreeDisplay(): Promise<string> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const number = DISPLAY_MIN + randomInt(0, DISPLAY_MAX - DISPLAY_MIN + 1);
    const display = `:${number}`;
    if (!(await isDisplayInUse(display))) return display;
  }
  throw new Error(`Could not find a free X display number in :${DISPLAY_MIN}-${DISPLAY_MAX}`);
}

// Bounded tail of the child's stderr, so a failed launch reports WHY it died
// (e.g. "cannot open display :0") instead of a bare exit notice.
function createStderrTail(limit = 4000): { push: (chunk: Buffer) => void; value: () => string } {
  let buffer = "";
  return {
    push: (chunk: Buffer) => {
      buffer = (buffer + chunk.toString()).slice(-limit);
    },
    value: () => buffer.trim(),
  };
}

function waitForDisplay(
  display: string,
  child: ChildProcess,
  timeoutMs: number,
  stderr: { value: () => string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    };
    const timer = setTimeout(() => {
      fail(`Timed out waiting for Xephyr display ${display} to become ready`);
    }, timeoutMs);

    // Fail fast on spawn errors (e.g. ENOENT) — exitCode stays null in that case.
    child.once("error", (error) => {
      fail(`Xephyr spawn failed: ${error.message}`);
    });

    const poll = (): void => {
      if (settled) return;
      if (child.exitCode !== null || child.signalCode !== null) {
        const detail = stderr.value();
        fail(`Xephyr exited before display ${display} became ready (code ${child.exitCode}, signal ${child.signalCode})${detail ? `: ${detail}` : ""}`);
        return;
      }
      execFile("xdpyinfo", ["-display", display], (error) => {
        if (settled) return;
        if (!error) {
          settled = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        setTimeout(poll, READY_POLL_MS);
      });
    };
    poll();
  });
}

export async function launchXephyr(opts?: { width?: number; height?: number }): Promise<XephyrDisplay> {
  if (!HOST_DISPLAY) {
    throw new Error("No host display available; cannot launch Xephyr");
  }
  const width = opts?.width ?? 1280;
  const height = opts?.height ?? 800;
  const display = await findFreeDisplay();
  const stderr = createStderrTail();

  const child = spawn(
    "Xephyr",
    [
      display,
      "-screen", `${width}x${height}x24`,
      "-ac",
      "-noreset",
      "-nolisten", "tcp",
      "-extension", "RENDER",
      "+extension", "GLX",
      "-extension", "COMPOSITE",
    ],
    // Pin DISPLAY to the host display captured at module load. process.env
    // may have been mutated by earlier browser launches, so it cannot be
    // trusted here.
    { stdio: ["ignore", "ignore", "pipe"], detached: true, env: { ...process.env, DISPLAY: HOST_DISPLAY } },
  );
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.on("error", (error) => {
    // spawn failure (e.g. ENOENT): surface it on the next poll via exit state.
    stderr.push(Buffer.from(`spawn error: ${error.message}\n`));
  });

  try {
    await waitForDisplay(display, child, READY_TIMEOUT_MS, stderr);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  let closed = false;
  const pid = child.pid ?? -1;
  return {
    display,
    pid,
    close: async () => {
      if (closed) return;
      closed = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            resolve();
          }, 2000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}

// Maps Playwright key names to X keysyms for xdotool. Letters, digits, and
// F-keys pass through unchanged.
const PLAYWRIGHT_TO_XDOTOOL: Record<string, string> = {
  Enter: "Return",
  Tab: "Tab",
  Backspace: "BackSpace",
  Delete: "Delete",
  Insert: "Insert",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  PageUp: "Page_Up",
  PageDown: "Page_Down",
  Home: "Home",
  End: "End",
  Space: "space",
  Escape: "Escape",
  Esc: "Escape",
  Control: "Control_L",
  ControlLeft: "Control_L",
  ControlRight: "Control_R",
  Shift: "Shift_L",
  ShiftLeft: "Shift_L",
  ShiftRight: "Shift_R",
  Alt: "Alt_L",
  AltLeft: "Alt_L",
  AltRight: "Alt_R",
  Meta: "Super_L",
  Command: "Super_L",
  Super: "Super_L",
  Quote: "apostrophe",
  Backquote: "grave",
  Minus: "minus",
  Equal: "equal",
  Backslash: "backslash",
  Comma: "comma",
  Period: "period",
  Slash: "slash",
  Semicolon: "semicolon",
  BracketLeft: "bracketleft",
  BracketRight: "bracketright",
};

export function toXdotoolKeysym(key: string): string {
  return PLAYWRIGHT_TO_XDOTOOL[key] ?? key;
}

// Sends a real X11 key event to the focused window on the given display via
// xdotool. Used for bare keys (no selector) so the event behaves like physical
// keyboard input to the browser window, rather than a CDP injection that only
// reaches the page's currently-focused element. xdotool has no --display flag;
// it connects to the display named by the DISPLAY env var, so we set that to
// the session's Xephyr display for the subprocess.
export function pressKeyOnDisplay(display: string, key: string): Promise<void> {
  const keysym = toXdotoolKeysym(key);
  return new Promise((resolve, reject) => {
    execFile(
      "xdotool",
      ["key", "--clearmodifiers", keysym],
      { env: { ...process.env, DISPLAY: display } },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`xdotool key "${keysym}" on ${display} failed: ${stderr.trim() || error.message}`));
          return;
        }
        resolve();
      },
    );
  });
}
