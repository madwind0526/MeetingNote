import { spawn } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import electronPath from "electron";

const projectRoot = process.cwd();
const devServerUrl = "http://127.0.0.1:5185";
const devServerHost = "127.0.0.1";
const devServerPort = 5185;

// Invoke tsc/vite's actual JS entry points with `node` directly instead of going through `npx`
// or the node_modules/.bin/*.cmd shims. `npx` re-resolves the package (and, depending on npm's
// cache/network state, can probe the registry) before running it, which cost ~10s per call on a
// machine behind a corporate proxy - the binary is already sitting in node_modules because
// tsc/vite are devDependencies, so there's nothing to resolve. Going straight to the JS entry
// point (rather than the .cmd shim) also means these spawns don't need Windows' cmd.exe shell at
// all, which avoids Node's DEP0190 warning about unescaped shell args and skips an extra process.
const tscEntry = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");
const viteEntry = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");

// Vite dev mode transforms each module on first request (a one-time ~20s+ cost the first time
// something requests the full app graph after a fresh Vite process starts, per the startup perf
// investigation) but stays warm for the lifetime of that Vite process. Electron closing no longer
// kills Vite (see shutdown below) so that cost is paid once per Vite process, not once per launch
// - which means two `start.bat` runs close together could otherwise both find "nothing on the
// port yet" and each try to start their own Vite/Electron pair. A PID lock file makes a second
// concurrent launch a no-op instead of racing the first one.
const runtimeDir = path.join(projectRoot, "data", "runtime");
const lockPath = path.join(runtimeDir, "meetingnote.lock");

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function acquireLaunchLock() {
  await mkdir(runtimeDir, { recursive: true });

  try {
    await writeFile(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }

  const existingPid = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10);

  if (Number.isInteger(existingPid) && isPidAlive(existingPid)) {
    return false;
  }

  // Stale lock left behind by a launch that didn't exit cleanly (e.g. killed from Task Manager) -
  // this launch takes over.
  await writeFile(lockPath, String(process.pid));
  return true;
}

function releaseLaunchLock() {
  return unlink(lockPath).catch(() => {});
}

if (!(await acquireLaunchLock())) {
  console.log("MeetingNote가 이미 실행 중이거나 시작 중입니다. 새로 띄우지 않고 종료합니다.");
  process.exit(0);
}

// A plain TCP connect bypasses any HTTP_PROXY/HTTPS_PROXY env vars that a corporate
// proxy setup might apply to fetch(), which would otherwise try (and fail) to route
// requests to the loopback dev server through the proxy.
function isDevServerUp(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 1000 });
    const finish = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

function runBuild() {
  return new Promise((resolve) => {
    console.log("Building Electron main process...");
    const build = spawn(process.execPath, [tscEntry, "-p", "tsconfig.node.json"], {
      stdio: "inherit",
      cwd: projectRoot,
      windowsHide: true
    });
    build.on("exit", (code) => resolve(code ?? 1));
    build.on("error", () => resolve(1));
  });
}

async function ensureDevServer() {
  if (await isDevServerUp(devServerHost, devServerPort)) {
    // Don't commit to "reuse" off a single connect - something on this port (e.g. a server
    // that's mid-shutdown from a moment ago) can still accept a connection for a brief moment
    // while it's tearing down. Re-check after a short delay so a dying listener doesn't get
    // mistaken for a live one, leaving us waiting on a port nothing will ever answer on again.
    await new Promise((resolve) => setTimeout(resolve, 300));

    if (await isDevServerUp(devServerHost, devServerPort)) {
      console.log("Vite dev server already running, reusing it.");
      return null;
    }
  }

  console.log("Starting Vite dev server...");
  // `detached: true` puts Vite in its own process group instead of this script's, and `unref()`
  // stops it from keeping the Node event loop (and, on Windows, the console/job it's attached to)
  // alive - without both, Vite was observed dying along with start-app.mjs when Electron exited
  // and this script called process.exit(), defeating the point of leaving Vite running for the
  // next launch to reuse.
  const child = spawn(process.execPath, [viteEntry, "--host", "127.0.0.1"], {
    stdio: "inherit",
    cwd: projectRoot,
    detached: true,
    windowsHide: true
  });
  child.unref();
  return child;
}

// The Electron main-process build and the Vite dev server have no dependency on each other -
// only launching Electron at the end needs both done - so run them at the same time instead of
// waiting for the build to finish before even checking whether Vite is up.
const [buildExitCode, vite] = await Promise.all([runBuild(), ensureDevServer()]);

if (buildExitCode !== 0) {
  vite?.kill();
  await releaseLaunchLock();
  process.exit(buildExitCode);
}

async function waitForDevServer(host, port, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await isDevServerUp(host, port)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return false;
}

const ready = await waitForDevServer(devServerHost, devServerPort, 20000);

if (!ready) {
  console.error("Vite dev server did not start in time.");
  vite?.kill();
  await releaseLaunchLock();
  process.exit(1);
}

// Some shells in this environment set ELECTRON_RUN_AS_NODE, which makes the electron binary
// behave as a plain Node CLI instead of launching the Electron GUI runtime - drop it explicitly
// so `electron .` actually opens the app window.
const electronEnv = { ...process.env, VITE_DEV_SERVER_URL: devServerUrl };
delete electronEnv.ELECTRON_RUN_AS_NODE;

console.log("Launching Electron...");
// windowsHide was tried here to suppress console flicker from Electron's own Chromium helper
// processes (GPU/utility/crashpad-handler), but it stopped the main BrowserWindow itself from
// appearing at all - reverted.
const electron = spawn(electronPath, ["."], {
  stdio: "inherit",
  cwd: projectRoot,
  env: electronEnv
});

electron.on("exit", async (code) => {
  // Deliberately NOT killing `vite` here - Vite pays a large one-time module-transform cost on
  // its first real request after starting (measured ~23s for this app's dependency graph) and
  // stays fast afterwards. Leaving it running lets the next launch reuse the already-warm server
  // instead of paying that cost again. Run stop.bat for a full stop (kills Vite too).
  await releaseLaunchLock();
  process.exit(code ?? 0);
});

process.on("SIGINT", async () => {
  // Ctrl+C in this terminal is an explicit "stop everything" request, unlike closing the
  // Electron window - tear down Vite here too instead of leaving it running.
  electron.kill();
  vite?.kill();
  await releaseLaunchLock();
  process.exit(0);
});
