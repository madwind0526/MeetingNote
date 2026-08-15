import spawn from "cross-spawn";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CHECK_TIMEOUT_MS = 10000;
// Local CPU transcription is slow (minutes per file), so this needs a much longer budget than
// the other CLI shell-outs in this project.
const TRANSCRIBE_TIMEOUT_MS = 600000;
const DEFAULT_WHISPER_EXE = path.resolve(process.cwd(), ".venv-whisperx", "Scripts", "whisper.exe");

function whisperCommand() {
  return process.env.MEETINGNOTE_WHISPER_CLI || (existsSync(DEFAULT_WHISPER_EXE) ? DEFAULT_WHISPER_EXE : "whisper");
}

function whisperModel(model) {
  return model || process.env.MEETINGNOTE_WHISPER_MODEL || "base";
}

function whisperDevice() {
  return process.env.MEETINGNOTE_WHISPER_DEVICE || "cuda";
}

// Same shell-out pattern as PhoneBook's server/llm.mjs runCommand/checkClaudeCliAvailable -
// cross-spawn resolves the real whisper(.exe) shim on Windows and passes args through argv
// (not a shell string), so it can't be abused via shell metacharacters.
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
      // The openai-whisper CLI doesn't have a simple `--version` flag on all versions, so
      // "the process ran and produced some output" (even a non-zero exit for `-h`-like usage
      // text) is treated as good enough evidence that the command exists.
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
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

export async function transcribeLocalWhisperCli(audioBuffer, fileName, model = "base") {
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
        { timeoutMs: TRANSCRIBE_TIMEOUT_MS, cwd: workDir }
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

    const rawSegments = Array.isArray(outputJson.segments) ? outputJson.segments : [];
    const segments = rawSegments.map((segment) => ({
      startSec: segment.start,
      endSec: segment.end,
      text: (segment.text ?? "").trim()
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
