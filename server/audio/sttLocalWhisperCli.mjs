import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readEnvFile } from "../envFile.mjs";
import { resolveComputeDevice } from "../settingsFile.mjs";
import { runPythonCommand, runDiarizeWithEmbeddings, createLineSplitter, AUTO_DIARIZE_ON_TRANSCRIBE } from "./pyannoteDiarize.mjs";

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

function whisperXPythonPath() {
  return process.env.MEETINGNOTE_WHISPERX_PYTHON || DEFAULT_WHISPERX_PYTHON;
}

function ffmpegBinPath() {
  return process.env.MEETINGNOTE_FFMPEG_BIN || DEFAULT_FFMPEG_BIN;
}

// Same shell-out pattern as PhoneBook's server/llm.mjs runCommand/checkClaudeCliAvailable -
// cross-spawn resolves the real whisper(.exe) shim on Windows and passes args through argv
// (not a shell string), so it can't be abused via shell metacharacters. See pyannoteDiarize.mjs's
// runPythonCommand for why PYTHONIOENCODING/PYTHONUTF8 are required (shared with the diarization
// step below, which uses the exact same Python environment).
const runCommand = runPythonCommand;

// Matches the "[mm:ss.ms --> mm:ss.ms]  text" lines openai-whisper prints per decoded segment
// (its default non-tqdm verbose mode). The end timestamp divided by the known audio duration is
// used as a real progress fraction, and the trailing text is surfaced live via onSegment - see
// transcribeLocalWhisperCli below.
const SEGMENT_LINE_RE = /\[(\d+):(\d+(?:\.\d+)?)\s*-->\s*(\d+):(\d+(?:\.\d+)?)\]\s*(.*)/;

function parseSegmentLine(line) {
  const match = SEGMENT_LINE_RE.exec(line);
  if (!match) {
    return null;
  }

  return {
    startSec: Number(match[1]) * 60 + Number(match[2]),
    endSec: Number(match[3]) * 60 + Number(match[4]),
    text: (match[5] ?? "").trim()
  };
}

// deep=false (the default) only checks whether the expected install exists on disk - no
// subprocess spawn, since `whisper -h` loads the whole whisper package (including torch) just to
// print help text, which is slow enough that running it automatically on every Settings open was
// a real contributor to a sluggish-feeling UI. deep=true runs the full spawn-based check, for the
export async function checkLocalWhisperAvailable(deep = false) {
  if (!deep) {
    const installed = existsSync(DEFAULT_WHISPER_EXE) || Boolean(process.env.MEETINGNOTE_WHISPER_CLI);
    return { available: installed, version: null };
  }

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

export async function transcribeLocalWhisperCli(audioBuffer, fileName, model = "base", expectedDurationSec = 0, onProgress, attendeeNames = [], onSegment, signal) {
  const workDir = await mkdtemp(path.join(tmpdir(), "meetingnote-whisper-"));
  const inputExt = pickExtension(fileName);
  const inputBaseName = `input${inputExt}`;
  const inputPath = path.join(workDir, inputBaseName);
  const outputJsonPath = path.join(workDir, "input.json");
  const device = await resolveComputeDevice();

  try {
    await writeFile(inputPath, audioBuffer);

    let result;
    try {
      // No --language flag - each chunk auto-detects its own language instead of being forced to
      // decode as Korean. A chunk that's actually in English (or any other language) was previously
      // garbled by being force-decoded as Korean; most chunks are still Korean and Whisper's
      // detector is reliable with 12s+ of clear speech (this app's minimum chunk length).
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
          "--device",
          device
        ],
        {
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

    // Whole-recording diarization is now off by default (AUTO_DIARIZE_ON_TRANSCRIBE, see
    // pyannoteDiarize.mjs) - a misclustered turn used to poison a voice profile with two blended
    // speakers. Segments come back with no `speaker` field, so diarize.mjs's no-embedding fallback
    // gives every segment the same single label; the user names segments individually in
    // /api/voice-profiles/classify-clips). Best-effort: falls back silently to the plain transcript
    // above if it fails, since transcription itself already succeeded. return_embeddings gives per-
    // speaker voice embeddings for B3's persistent voice-profile matching (see diarize.mjs).
    const env = await readEnvFile();
    const hfToken = env.HUGGINGFACE_TOKEN;
    let embeddings = {};
    if (signal?.aborted) {
      throw new DOMException("음성 분석을 중지했습니다.", "AbortError");
    }
    if (AUTO_DIARIZE_ON_TRANSCRIBE && hfToken && existsSync(whisperXPythonPath())) {
      const speakerCount = attendeeNames.filter(Boolean).length;
      const diarized = await runDiarizeWithEmbeddings({
        pythonPath: whisperXPythonPath(),
        workDir,
        audioPath: inputPath,
        whisperResult: outputJson,
        hfToken,
        speakerCount,
        ffmpegBin: ffmpegBinPath(),
        device,
        timeoutMs: DIARIZE_TIMEOUT_MS,
        signal
      });
      // runDiarizeWithEmbeddings treats every failure as best-effort (falls back to the plain
      // transcript) - including a signal-triggered kill - so a cancel mid-diarization has to be
      // re-checked here instead of trusting that call to have thrown.
      if (signal?.aborted) {
        throw new DOMException("음성 분석을 중지했습니다.", "AbortError");
      }
      outputJson = diarized.whisperResult;
      embeddings = diarized.embeddings;
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

    return { durationSec, segments, embeddings };
  } finally {
    // Best-effort cleanup - a failure here should never mask the real transcription result/error.
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
