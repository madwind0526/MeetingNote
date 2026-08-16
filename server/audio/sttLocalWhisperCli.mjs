import spawn from "cross-spawn";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readEnvFile } from "../envFile.mjs";

const CHECK_TIMEOUT_MS = 10000;
// Local CPU transcription is slow (minutes per file), so this needs a much longer budget than
// the other CLI shell-outs in this project.
const TRANSCRIBE_TIMEOUT_MS = 600000;
const DIARIZE_TIMEOUT_MS = 300000;
const DEFAULT_WHISPER_EXE = path.resolve(process.cwd(), ".venv-whisperx", "Scripts", "whisper.exe");
// The whisper CLI and the diarization merge step (below) share the same Python environment -
// whisperx (and its pyannote.audio dependency) is already installed there even though this file
// never runs whisperx's own transcription.
const DEFAULT_WHISPERX_PYTHON = path.resolve(process.cwd(), ".venv-whisperx", "Scripts", "python.exe");
const DEFAULT_FFMPEG_BIN = "D:\\ffmpeg\\ffmpeg-7.1.1-full_build-shared\\bin";

function whisperCommand() {
  return process.env.MEETINGNOTE_WHISPER_CLI || (existsSync(DEFAULT_WHISPER_EXE) ? DEFAULT_WHISPER_EXE : "whisper");
}

function whisperModel(model) {
  return model || process.env.MEETINGNOTE_WHISPER_MODEL || "base";
}

function whisperDevice() {
  return process.env.MEETINGNOTE_WHISPER_DEVICE || "cuda";
}

function whisperXPythonPath() {
  return process.env.MEETINGNOTE_WHISPERX_PYTHON || DEFAULT_WHISPERX_PYTHON;
}

function ffmpegBinPath() {
  return process.env.MEETINGNOTE_FFMPEG_BIN || DEFAULT_FFMPEG_BIN;
}

// Same shell-out pattern as PhoneBook's server/llm.mjs runCommand/checkClaudeCliAvailable -
// cross-spawn resolves the real whisper(.exe) shim on Windows and passes args through argv
// (not a shell string), so it can't be abused via shell metacharacters.
//
// PYTHONIOENCODING/PYTHONUTF8 are required on Windows: openai-whisper prints each decoded
// segment's text to stdout as it works (used below for progress), and Python defaults stdout to
// the OS console codepage (cp949 on a Korean-locale Windows install) rather than UTF-8. Any
// transcribed character outside that codepage then throws UnicodeEncodeError mid-run - the CLI
// catches it, skips the file, and still exits 0 with no JSON output, which otherwise surfaces
// only as a confusing "결과 파일을 읽지 못했습니다" error with no indication of the real cause.
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
      // The openai-whisper CLI doesn't have a simple `--version` flag on all versions, so
      // "the process ran and produced some output" (even a non-zero exit for `-h`-like usage
      // text) is treated as good enough evidence that the command exists.
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

// Matches the "[mm:ss.ms --> mm:ss.ms]  text" lines openai-whisper prints per decoded segment
// (its default non-tqdm verbose mode). The end timestamp divided by the known audio duration is
// used as a real progress fraction - see transcribeLocalWhisperCli's onProgress usage below.
const SEGMENT_TIMESTAMP_RE = /\[(\d+):(\d+(?:\.\d+)?)\s*-->\s*(\d+):(\d+(?:\.\d+)?)\]/g;

function parseLatestEndSeconds(text) {
  let match;
  let lastEndSec = null;

  while ((match = SEGMENT_TIMESTAMP_RE.exec(text))) {
    lastEndSec = Number(match[3]) * 60 + Number(match[4]);
  }

  return lastEndSec;
}

export async function checkLocalWhisperAvailable() {
  try {
    const command = whisperCommand();
    const result = await runCommand(command, ["-h"], { timeoutMs: CHECK_TIMEOUT_MS });
    const output = result.stdout || result.stderr;

    if (!output) {
      return { available: false, version: null };
    }

    const versionMatch = output.match(/\d+\.\d+(\.\d+)?/);
    return { available: true, version: versionMatch ? versionMatch[0] : "unknown" };
  } catch {
    return { available: false, version: null };
  }
}

function pickExtension(fileName) {
  const ext = path.extname(fileName || "");
  return ext || ".wav";
}

// Runs pyannote.audio's speaker diarization directly (the same model/library WhisperX's own
// --diarize flag uses under the hood - see sttLocalWhisperX.mjs) and merges the resulting speaker
// turns into openai-whisper's own transcript segments, using whisperx's own
// DiarizationPipeline/assign_word_speakers helpers so the overlap-matching logic is identical to
// WhisperX's. This lets local-whisper-cli (better transcription quality than WhisperX's
// faster-whisper backend, per user feedback) also get real speaker labels, instead of only
// local-whisperx.
function buildDiarizeScript({ audioPath, whisperJsonPath, mergedJsonPath, hfToken, minSpeakers, maxSpeakers }) {
  const ffmpegPath = JSON.stringify(ffmpegBinPath());

  return [
    "import os",
    `ffmpeg_bin = ${ffmpegPath}`,
    "if ffmpeg_bin:",
    "    os.environ['PATH'] = ffmpeg_bin + os.pathsep + os.environ.get('PATH', '')",
    "    if hasattr(os, 'add_dll_directory'):",
    "        os.add_dll_directory(ffmpeg_bin)",
    "import json",
    "from whisperx.diarize import DiarizationPipeline, assign_word_speakers",
    "",
    `with open(${JSON.stringify(whisperJsonPath)}, "r", encoding="utf-8") as f:`,
    "    whisper_result = json.load(f)",
    "",
    `pipeline = DiarizationPipeline(token=${JSON.stringify(hfToken)}, device=os.environ.get('MEETINGNOTE_WHISPER_DEVICE', 'cuda'))`,
    `diarize_df = pipeline(${JSON.stringify(audioPath)}` +
      (minSpeakers ? `, min_speakers=${minSpeakers}` : "") +
      (maxSpeakers ? `, max_speakers=${maxSpeakers}` : "") +
      ")",
    "merged = assign_word_speakers(diarize_df, whisper_result)",
    // whisperx/pyannote log INFO/warning lines to stdout during loading, so the merged result is
    // written to its own file instead of printed - stdout can't be trusted to contain only JSON.
    `with open(${JSON.stringify(mergedJsonPath)}, "w", encoding="utf-8") as f:`,
    "    json.dump(merged, f, ensure_ascii=False)"
  ].join("\n");
}

// Best-effort: any failure here (no GPU memory, model download hiccup, etc.) falls back to the
// plain (non-diarized) transcript rather than failing the whole analysis - matches
// transcribeLocalWhisperX's "no hard failure" behavior when diarization can't run.
async function diarizeWithPyannote(inputPath, outputJson, hfToken, speakerCount) {
  const pythonPath = whisperXPythonPath();
  if (!existsSync(pythonPath)) {
    return outputJson;
  }

  const workDir = path.dirname(inputPath);
  const whisperJsonPath = path.join(workDir, "whisper-for-diarize.json");
  const mergedJsonPath = path.join(workDir, "whisper-diarized.json");
  const scriptPath = path.join(workDir, "run_diarize.py");

  try {
    await writeFile(whisperJsonPath, JSON.stringify(outputJson), "utf8");
    await writeFile(
      scriptPath,
      buildDiarizeScript({
        audioPath: inputPath,
        whisperJsonPath,
        mergedJsonPath,
        hfToken,
        minSpeakers: speakerCount > 0 ? 1 : undefined,
        maxSpeakers: speakerCount > 0 ? speakerCount : undefined
      }),
      "utf8"
    );

    const result = await runCommand(pythonPath, [scriptPath], { timeoutMs: DIARIZE_TIMEOUT_MS, cwd: workDir });

    if (result.code !== 0) {
      return outputJson;
    }

    const mergedRaw = await readFile(mergedJsonPath, "utf8");
    return JSON.parse(mergedRaw);
  } catch {
    return outputJson;
  }
}

export async function transcribeLocalWhisperCli(audioBuffer, fileName, model = "base", expectedDurationSec = 0, onProgress, attendeeNames = []) {
  const workDir = await mkdtemp(path.join(tmpdir(), "meetingnote-whisper-"));
  const inputExt = pickExtension(fileName);
  const inputBaseName = `input${inputExt}`;
  const inputPath = path.join(workDir, inputBaseName);
  const outputJsonPath = path.join(workDir, "input.json");

  try {
    await writeFile(inputPath, audioBuffer);

    let result;
    try {
      result = await runCommand(
        whisperCommand(),
        [
          inputPath,
          "--output_format",
          "json",
          "--output_dir",
          workDir,
          "--model",
          whisperModel(model),
          "--language",
          "Korean",
          "--device",
          whisperDevice()
        ],
        {
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
        }
      );
    } catch (error) {
      if (error && error.code === "ENOENT") {
        throw new Error(
          "로컬 Whisper CLI를 찾을 수 없습니다. `pip install -U openai-whisper`와 ffmpeg를 설치하거나, 설정에서 다른 STT 프로바이더를 선택해 주세요."
        );
      }
      throw new Error(`로컬 Whisper 실행 중 오류가 발생했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (result.code !== 0) {
      throw new Error(
        `로컬 Whisper 실행에 실패했습니다. openai-whisper와 ffmpeg가 올바르게 설치되어 있는지 확인하거나, 설정에서 다른 STT 프로바이더를 선택해 주세요. (${result.stderr || "종료 코드 " + result.code})`
      );
    }

    let outputJson;
    try {
      const raw = await readFile(outputJsonPath, "utf8");
      outputJson = JSON.parse(raw);
    } catch {
      throw new Error(
        "로컬 Whisper 결과 파일을 읽지 못했습니다. openai-whisper 설치 상태를 확인하거나, 설정에서 다른 STT 프로바이더를 선택해 주세요."
      );
    }

    // Diarization is applied automatically whenever a Hugging Face token is configured - same
    // opt-in condition as local-whisperx (see NaverClovaConfigModal's counterpart, the HF token
    // modal, wired from Settings). Best-effort: falls back silently to the plain transcript above
    // if it fails, since transcription itself already succeeded.
    const env = await readEnvFile();
    const hfToken = env.HUGGINGFACE_TOKEN;
    if (hfToken) {
      const speakerCount = attendeeNames.filter(Boolean).length;
      outputJson = await diarizeWithPyannote(inputPath, outputJson, hfToken, speakerCount);
    }

    const rawSegments = Array.isArray(outputJson.segments) ? outputJson.segments : [];
    const segments = rawSegments.map((segment) => ({
      startSec: segment.start,
      endSec: segment.end,
      text: (segment.text ?? "").trim(),
      ...(typeof segment.speaker === "string" && segment.speaker ? { speaker: segment.speaker } : {})
    }));
    const lastSegment = segments[segments.length - 1];
    const durationSec = lastSegment ? lastSegment.endSec : 0;

    return { durationSec, segments };
  } finally {
    // Best-effort cleanup - a failure here should never mask the real transcription result/error.
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
