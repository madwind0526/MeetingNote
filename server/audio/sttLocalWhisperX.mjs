import spawn from "cross-spawn";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readEnvFile } from "../envFile.mjs";

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

// See sttLocalWhisperCli.mjs's runCommand for why PYTHONIOENCODING/PYTHONUTF8 are set - same
// Windows console-codepage crash risk applies here (whisperx's logger also writes decoded text
// to stdout).
function runCommand(command, args, { timeoutMs, cwd, onStdoutChunk } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      timeout: timeoutMs,
      cwd,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
    });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onStdoutChunk?.(text);
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

// Matches whisperx's "Transcript: [start --> end]  text" log lines (plain seconds, not mm:ss).
// The end timestamp divided by the known audio duration is used as a real progress fraction.
const SEGMENT_TIMESTAMP_RE = /Transcript:\s*\[[\d.]+\s*-->\s*([\d.]+)\]/g;

function parseLatestEndSeconds(text) {
  let match;
  let lastEndSec = null;

  while ((match = SEGMENT_TIMESTAMP_RE.exec(text))) {
    lastEndSec = Number(match[1]);
  }

  return lastEndSec;
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

export async function transcribeLocalWhisperX(audioBuffer, fileName, model = "base", expectedDurationSec = 0, onProgress, attendeeNames = []) {
  const pythonPath = whisperXPythonPath();

  if (!existsSync(pythonPath)) {
    throw new Error(`WhisperX Python을 찾을 수 없습니다: ${pythonPath}`);
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "meetingnote-whisperx-"));
  const inputExt = pickExtension(fileName);
  const inputPath = path.join(workDir, `input${inputExt}`);
  const outputJsonPath = path.join(workDir, "input.json");
  const scriptPath = path.join(workDir, "run_whisperx.py");

  // Diarization is applied automatically whenever a Hugging Face token is configured - see
  // NaverClovaConfigModal's counterpart, the HF token modal, wired from Settings' "로컬 WhisperX
  // GPU" provider card. Without a token, transcription still runs, just without speaker labels
  // (matches the behavior before diarization support existed - never a hard failure).
  const env = await readEnvFile();
  const hfToken = env.HUGGINGFACE_TOKEN;
  const speakerCount = Array.isArray(attendeeNames) ? attendeeNames.filter(Boolean).length : 0;

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
          ...(hfToken
            ? [
                "    '--diarize',",
                `    '--hf_token', ${JSON.stringify(hfToken)},`,
                ...(speakerCount > 0
                  ? [`    '--min_speakers', '1',`, `    '--max_speakers', ${JSON.stringify(String(speakerCount))},`]
                  : [])
              ]
            : []),
          "]",
          "cli()"
        ].join("\n")
      ),
      "utf8"
    );

    const result = await runCommand(pythonPath, [scriptPath], {
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      cwd: workDir,
      onStdoutChunk: expectedDurationSec > 0 && onProgress
        ? (text) => {
            const endSec = parseLatestEndSeconds(text);
            if (endSec !== null) {
              onProgress(Math.min(0.99, endSec / expectedDurationSec));
            }
          }
        : undefined
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
      text: String(segment.text ?? "").trim(),
      // Only present when --diarize ran (see above) - whisperx writes a flat "SPEAKER_00"-style
      // string per segment, which diarizeSegments (server/audio/diarize.mjs) picks up as-is.
      ...(typeof segment.speaker === "string" && segment.speaker ? { speaker: segment.speaker } : {})
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
