import spawn from "cross-spawn";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DEMUCS_TIMEOUT_MS = 900000;
const DEFAULT_PYTHON_PATH = path.resolve(process.cwd(), ".venv-whisperx", "Scripts", "python.exe");
const DEFAULT_FFMPEG_BIN = "D:\\ffmpeg\\ffmpeg-7.1.1-full_build-shared\\bin";

function pythonPath() {
  return process.env.MEETINGNOTE_DEMUCS_PYTHON || process.env.MEETINGNOTE_WHISPERX_PYTHON || DEFAULT_PYTHON_PATH;
}

function ffmpegBinPath() {
  return process.env.MEETINGNOTE_FFMPEG_BIN || DEFAULT_FFMPEG_BIN;
}

function demucsModel() {
  return process.env.MEETINGNOTE_DEMUCS_MODEL || "htdemucs";
}

function demucsDevice() {
  return process.env.MEETINGNOTE_DEMUCS_DEVICE || "cuda";
}

function runCommand(command, args, { timeoutMs, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    const ffmpegBin = ffmpegBinPath();

    if (ffmpegBin) {
      env.PATH = `${ffmpegBin}${path.delimiter}${env.PATH ?? ""}`;
    }

    const child = spawn(command, args, { timeout: timeoutMs, cwd, env });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

async function findFileByName(rootDir, fileName) {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) {
      return entryPath;
    }
    if (entry.isDirectory()) {
      const nested = await findFileByName(entryPath, fileName);
      if (nested) {
        return nested;
      }
    }
  }

  return null;
}

export async function isolateVocalsWithDemucs(audioBuffer, fileName) {
  const executable = pythonPath();

  if (!existsSync(executable)) {
    throw new Error(`Demucs Python을 찾을 수 없습니다: ${executable}`);
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "meetingnote-demucs-"));
  const inputPath = path.join(workDir, `input${path.extname(fileName || "") || ".wav"}`);
  const outputRoot = path.join(workDir, "separated");
  const model = demucsModel();

  try {
    await writeFile(inputPath, audioBuffer);

    const result = await runCommand(
      executable,
      ["-m", "demucs.separate", "--two-stems", "vocals", "-n", model, "--device", demucsDevice(), "-o", outputRoot, inputPath],
      { timeoutMs: DEMUCS_TIMEOUT_MS, cwd: workDir }
    );

    if (result.code !== 0) {
      throw new Error(`Demucs 음성 추출에 실패했습니다. (${result.stderr || `종료 코드 ${result.code}`})`);
    }

    const expectedPath = path.join(outputRoot, model, path.basename(inputPath, path.extname(inputPath)), "vocals.wav");
    const vocalsPath = existsSync(expectedPath) ? expectedPath : await findFileByName(outputRoot, "vocals.wav");

    if (!vocalsPath) {
      throw new Error("Demucs 결과 파일(vocals.wav)을 찾을 수 없습니다.");
    }

    return await readFile(vocalsPath);
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
