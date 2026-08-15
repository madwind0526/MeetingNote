import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ENV_PATH = path.join(process.cwd(), ".env");

export function parseEnv(raw) {
  const env = {};

  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  });

  return env;
}

export async function readEnvFile() {
  try {
    const raw = await readFile(ENV_PATH, "utf8");
    return parseEnv(raw);
  } catch {
    return {};
  }
}

function upsertEnvText(raw, updates) {
  const remainingKeys = new Set(Object.keys(updates));
  const lines = raw
    .split(/\r?\n/)
    .filter((line, index, all) => !(line === "" && index === all.length - 1))
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return line;
      }

      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) {
        return line;
      }

      const key = trimmed.slice(0, eqIndex).trim();
      if (remainingKeys.has(key)) {
        remainingKeys.delete(key);
        return `${key}=${updates[key]}`;
      }

      return line;
    });

  remainingKeys.forEach((key) => {
    lines.push(`${key}=${updates[key]}`);
  });

  return `${lines.join("\n")}\n`;
}

export async function writeEnvUpdates(updates) {
  let raw = "";
  try {
    raw = await readFile(ENV_PATH, "utf8");
  } catch {
    raw = "";
  }

  await mkdir(path.dirname(ENV_PATH), { recursive: true });
  await writeFile(ENV_PATH, upsertEnvText(raw, updates), "utf8");
}
