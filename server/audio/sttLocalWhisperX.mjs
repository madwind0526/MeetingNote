import spawn from "cross-spawn";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CHECK_TIMEOUT_MS = 20000;
const TRANSCRIBE_TIMEOUT_MS = 900000;
const DEFAULT_PYTHON_PATH = path.resolve(process.cwd(), ".venv-whisperx", "Scripts", "python.exe");
const DEFAULT_FFMPEG_BIN = "D:\\ffmpeg\\ffmpeg-7.1.1-full_build-shared\\bin";

function whisperXPythonPath() {
  return process.env.MEETINGNOTE_WHISPERX_PYTHON || DEFAULT_PYTHON_PATH;
}

function ffmpegBinPath() {
  return process.env.MEETINGNOTE_FFMPEG_BIN || DEFAULT_FFMPEG_BIN;
}

function runCommand(command, args, { timeoutMs, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { timeout: timeoutMs, cwd });
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

function buildBootstrapCode(body) {
  const ffmpegPath = JSON.stringify(ffmpegBinPath());

  return [
    "import os",
    `ffmpeg_bin = ${ffmpegPath}`,
    "if ffmpeg_bin:",
    "    os.environ['PATH'] = ffmpeg_bin + os.pathsep + os.environ.get('PATH', '')",
    "    if hasattr(os, 'add_dll_directory'):",
    "        os.add_dll_directory(ffmpeg_bin)",
    body
  ].join("\n");
}

export async function checkLocalWhisperXAvailable() {
  const pythonPath = whisperXPythonPath();

  if (!existsSync(pythonPath)) {
    return { available: false, version: null };
  }

  try {
    const code = buildBootstrapCode(
      [
        "import importlib.metadata as md",
        "import torch",
        "import torchcodec",
        "import whisperx",
        "device = torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'",
        "print(md.version('whisperx') + ' / ' + device)"
      ].join("\n")
    );
    const result = await runCommand(pythonPath, ["-c", code], { timeoutMs: CHECK_TIMEOUT_MS });

    if (result.code !== 0) {
      return { available: false, version: null };
    }

    return { available: true, version: result.stdout || "whisperx" };
  } catch {
    return { available: false, version: null };
  }
}

function pickExtension(fileName) {
  const ext = path.extname(fileName || "");
  return ext || ".wav";
}

export async function transcribeLocalWhisperX(audioBuffer, fileName, model = "base") {
  const pythonPath = whisperXPythonPath();

  if (!existsSync(pythonPath)) {
    throw new Error(`WhisperX Python을 찾을 수 없습니다: ${pythonPath}`);
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "meetingnote-whisperx-"));
  const inputExt = pickExtension(fileName);
  const inputPath = path.join(workDir, `input${inputExt}`);
  const outputJsonPath = path.join(workDir, "input.json");
  const scriptPath = path.join(workDir, "run_whisperx.py");

  try {
    await writeFile(inputPath, audioBuffer);
    await writeFile(
      scriptPath,
      buildBootstrapCode(
        [
          "import sys",
          "from whisperx.__main__ import cli",
          "sys.argv = [",
          "    'whisperx',",
          `    ${JSON.stringify(inputPath)},`,
          `    '--model', ${JSON.stringify(model)},`,
          "    '--language', 'ko',",
          "    '--device', os.environ.get('MEETINGNOTE_WHISPERX_DEVICE', 'cuda'),",
          "    '--compute_type', os.environ.get('MEETINGNOTE_WHISPERX_COMPUTE_TYPE', 'float16'),",
          "    '--output_format', 'json',",
          `    '--output_dir', ${JSON.stringify(workDir)},`,
          "]",
          "cli()"
        ].join("\n")
      ),
      "utf8"
    );

    const result = await runCommand(pythonPath, [scriptPath], {
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      cwd: workDir
    });

    if (result.code !== 0) {
      throw new Error(`WhisperX 실행에 실패했습니다. (${result.stderr || "종료 코드 " + result.code})`);
    }

    let outputJson;
    try {
      const raw = await readFile(outputJsonPath, "utf8");
      outputJson = JSON.parse(raw);
    } catch {
      throw new Error("WhisperX 결과 파일을 읽지 못했습니다.");
    }

    const rawSegments = Array.isArray(outputJson.segments) ? outputJson.segments : [];
    const segments = rawSegments.map((segment) => ({
      startSec: Number(segment.start ?? 0),
      endSec: Number(segment.end ?? 0),
      text: String(segment.text ?? "").trim()
    }));
    const lastSegment = segments[segments.length - 1];
    const durationSec = lastSegment ? lastSegment.endSec : 0;

    return { durationSec, segments };
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
