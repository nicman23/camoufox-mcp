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

let xephyrAvailable: boolean | undefined;

export async function isXephyrAvailable(): Promise<boolean> {
  if (xephyrAvailable !== undefined) return xephyrAvailable;
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

function waitForDisplay(display: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) {
        reject(new Error(`Xephyr exited before display ${display} became ready`));
        return;
      }
      execFile("xdpyinfo", ["-display", display], (error) => {
        if (!error) {
          resolve();
          return;
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`Timed out waiting for Xephyr display ${display} to become ready`));
          return;
        }
        setTimeout(poll, READY_POLL_MS);
      });
    };
    poll();
  });
}

export async function launchXephyr(opts?: { width?: number; height?: number }): Promise<XephyrDisplay> {
  const width = opts?.width ?? 1280;
  const height = opts?.height ?? 800;
  const display = await findFreeDisplay();

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
    { stdio: "ignore", detached: true },
  );

  try {
    await waitForDisplay(display, child, READY_TIMEOUT_MS);
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
