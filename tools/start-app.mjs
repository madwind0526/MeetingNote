import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import electronPath from "electron";

const projectRoot = process.cwd();
const devServerUrl = "http://127.0.0.1:5185";

async function isDevServerUp(url) {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

console.log("Building Electron main process...");
const build = spawnSync("npx", ["tsc", "-p", "tsconfig.node.json"], {
  stdio: "inherit",
  shell: true,
  cwd: projectRoot
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

let vite = null;

if (await isDevServerUp(devServerUrl)) {
  console.log("Vite dev server already running, reusing it.");
} else {
  console.log("Starting Vite dev server...");
  vite = spawn("npx", ["vite", "--host", "127.0.0.1"], {
    stdio: "inherit",
    shell: true,
    cwd: projectRoot
  });
}

async function waitForDevServer(url, timeoutMs) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await isDevServerUp(url)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  return false;
}

const ready = await waitForDevServer(devServerUrl, 20000);

if (!ready) {
  console.error("Vite dev server did not start in time.");
  vite?.kill();
  process.exit(1);
}

// Some shells in this environment set ELECTRON_RUN_AS_NODE, which makes the electron binary
// behave as a plain Node CLI instead of launching the Electron GUI runtime - drop it explicitly
// so `electron .` actually opens the app window.
const electronEnv = { ...process.env, VITE_DEV_SERVER_URL: devServerUrl };
delete electronEnv.ELECTRON_RUN_AS_NODE;

console.log("Launching Electron...");
const electron = spawn(electronPath, ["."], {
  stdio: "inherit",
  cwd: projectRoot,
  env: electronEnv
});

const shutdown = (code) => {
  vite?.kill();
  process.exit(code ?? 0);
};

electron.on("exit", shutdown);
process.on("SIGINT", () => {
  electron.kill();
  shutdown(0);
});
