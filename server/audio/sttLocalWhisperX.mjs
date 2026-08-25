import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readEnvFile } from "../envFile.mjs";
import { readAppSettings, resolveComputeDevice } from "../settingsFile.mjs";
import { runPythonCommand, runDiarizeWithEmbeddings, createLineSplitter } from "./pyannoteDiarize.mjs";

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

const DEFAULT_VAD_ONSET = 0.3;
const DEFAULT_VAD_OFFSET = 0.2;

// Settings' VAD onset/offset (see SettingsView's "WhisperX 음성 감지" section) - how confident
// silero's voice-activity detector must be before marking speech as starting/continuing. Only
// WhisperX exposes these (the plain Whisper CLI has no separate VAD step to tune).
async function resolveVadThresholds() {
  const settings = await readAppSettings();
  const onset = typeof settings?.vadOnset === "number" && Number.isFinite(settings.vadOnset) ? settings.vadOnset : DEFAULT_VAD_ONSET;
  const offset = typeof settings?.vadOffset === "number" && Number.isFinite(settings.vadOffset) ? settings.vadOffset : DEFAULT_VAD_OFFSET;
  return { onset, offset };
}

// See pyannoteDiarize.mjs's runPythonCommand for why PYTHONIOENCODING/PYTHONUTF8 are set - same
// Windows console-codepage crash risk applies here (whisperx's logger also writes decoded text
// to stdout).
const runCommand = runPythonCommand;

// Matches whisperx's "Transcript: [start --> end]  text" log lines (plain seconds, not mm:ss).
// The end timestamp divided by the known audio duration is used as a real progress fraction, and
// the trailing text is surfaced live via onSegment - see transcribeLocalWhisperX below.
const SEGMENT_LINE_RE = /Transcript:\s*\[([\d.]+)\s*-->\s*([\d.]+)\]\s*(.*)/;

function parseSegmentLine(line) {
  const match = SEGMENT_LINE_RE.exec(line);
  if (!match) {
    return null;
  }

  return {
    startSec: Number(match[1]),
    endSec: Number(match[2]),
    text: (match[3] ?? "").trim()
  };
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

// deep=false (the default) only checks whether the venv's python.exe exists - no subprocess spawn.
// deep=true additionally imports torch/torchcodec/whisperx inside that venv to confirm it actually
// works, which is slow (real package imports, not just a file check) - only runs for the user's
// explicit "지금 확인" action instead of automatically on every Settings open.
export async function checkLocalWhisperXAvailable(deep = false) {
  const pythonPath = whisperXPythonPath();

  if (!existsSync(pythonPath)) {
    return { available: false, version: null };
  }

  if (!deep) {
    return { available: true, version: null };
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

export async function transcribeLocalWhisperX(audioBuffer, fileName, model = "base", expectedDurationSec = 0, onProgress, attendeeNames = [], onSegment, signal) {
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
  //
  // This used to pass WhisperX's own `--diarize`/`--hf_token` CLI flags, which run pyannote
  // internally as a black box with no way to get per-speaker embeddings out. It now runs plain
  // transcription here, then diarizes as a separate step via the same shared
  // pyannoteDiarize.mjs helper sttLocalWhisperCli.mjs uses - identical diarization mechanics on
  // both paths (WhisperX's --diarize called the same DiarizationPipeline internally anyway), but
  // this way both paths expose embeddings for B3's persistent voice-profile matching.
  const env = await readEnvFile();
  const hfToken = env.HUGGINGFACE_TOKEN;
  const speakerCount = Array.isArray(attendeeNames) ? attendeeNames.filter(Boolean).length : 0;
  const device = await resolveComputeDevice();
  // float16 only runs on CUDA - faster-whisper (WhisperX's backend) rejects it on CPU, so CPU
  // falls back to int8 (its standard fast CPU quantization) instead of hardcoding a GPU-only value.
  const computeType = device === "cpu" ? "int8" : "float16";
  const { onset: vadOnset, offset: vadOffset } = await resolveVadThresholds();

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
          // No --language - see sttLocalWhisperCli.mjs's transcribeLocalWhisperCli for why forcing
          // Korean was wrong (it broke chunks that were actually in another language).
          `    '--device', ${JSON.stringify(device)},`,
          `    '--compute_type', ${JSON.stringify(computeType)},`,
          `    '--vad_onset', ${JSON.stringify(String(vadOnset))},`,
          `    '--vad_offset', ${JSON.stringify(String(vadOffset))},`,
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
      cwd: workDir,
      signal,
      onStdoutChunk: onProgress || onSegment
        ? createLineSplitter((line) => {
            const segment = parseSegmentLine(line);
            if (!segment) {
              return;
            }
            if (expectedDurationSec > 0 && onProgress) {
              onProgress(Math.min(0.99, segment.endSec / expectedDurationSec));
            }
            onSegment?.(segment);
          })
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

    let embeddings = {};
    if (signal?.aborted) {
      throw new DOMException("음성 분석을 중지했습니다.", "AbortError");
    }
    if (hfToken) {
      const diarized = await runDiarizeWithEmbeddings({
        pythonPath,
        workDir,
        audioPath: inputPath,
        whisperResult: outputJson,
        hfToken,
        speakerCount,
        ffmpegBin: ffmpegBinPath(),
        device,
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
        signal
      });
      // Best-effort inside runDiarizeWithEmbeddings swallows a signal-triggered kill and falls
      // back to the plain transcript, so a cancel mid-diarization has to be re-checked here.
      if (signal?.aborted) {
        throw new DOMException("음성 분석을 중지했습니다.", "AbortError");
      }
      outputJson = diarized.whisperResult;
      embeddings = diarized.embeddings;
    }

    const rawSegments = Array.isArray(outputJson.segments) ? outputJson.segments : [];
    const segments = rawSegments.map((segment) => ({
      startSec: Number(segment.start ?? 0),
      endSec: Number(segment.end ?? 0),
      text: String(segment.text ?? "").trim(),
      // Only present when diarization ran above - a flat "SPEAKER_00"-style string per segment,
      // which diarize.mjs picks up as-is.
      ...(typeof segment.speaker === "string" && segment.speaker ? { speaker: segment.speaker } : {})
    }));
    const lastSegment = segments[segments.length - 1];
    const durationSec = lastSegment ? lastSegment.endSec : 0;

    return { durationSec, segments, embeddings };
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
