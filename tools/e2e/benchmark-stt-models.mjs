// Times every Whisper CLI and WhisperX model against the same real audio clip, using this app's
// actual transcribeLocalWhisperCli/transcribeLocalWhisperX functions (same code path the app uses,
// including diarization when HF token + venv are configured) - not a re-implementation, so the
// numbers reflect real app performance on this machine.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { transcribeLocalWhisperCli } from "../../server/audio/sttLocalWhisperCli.mjs";
import { transcribeLocalWhisperX } from "../../server/audio/sttLocalWhisperX.mjs";
import { resolveComputeDevice } from "../../server/settingsFile.mjs";

const projectRoot = process.cwd();
const AUDIO_FILE = "diarize-2speaker-ko-en.wav";
const AUDIO_PATH = path.join(projectRoot, "data", "test-audio", AUDIO_FILE);
const AUDIO_DURATION_SEC = 35.16;
const WHISPER_CLI_MODELS = ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"];
const WHISPERX_MODELS = ["tiny", "base", "small", "medium", "large-v3"];
const OUT_PATH = path.join(projectRoot, "data", "test-audio", "stt-model-benchmark-result.json");

async function timeRun(label, fn) {
  console.log(`\n=== ${label} ===`);
  const start = Date.now();
  try {
    const result = await fn();
    const elapsedSec = (Date.now() - start) / 1000;
    // transcribeLocalWhisperCli/transcribeLocalWhisperX return the raw {durationSec, segments,
    // embeddings} shape - the transcriptSegments/speakerMap wrapping only happens later, in
    // vite.config.mts's route handler (via assignSpeakersWithProfiles), not inside these functions.
    const segmentCount = result?.segments?.length ?? 0;
    console.log(`  완료: ${elapsedSec.toFixed(1)}초 (세그먼트 ${segmentCount}개)`);
    return { ok: true, elapsedSec: Number(elapsedSec.toFixed(1)), segmentCount };
  } catch (error) {
    const elapsedSec = (Date.now() - start) / 1000;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  실패 (${elapsedSec.toFixed(1)}초): ${message.slice(0, 300)}`);
    return { ok: false, elapsedSec: Number(elapsedSec.toFixed(1)), error: message.slice(0, 500) };
  }
}

async function main() {
  const device = await resolveComputeDevice();
  console.log(`오디오: ${AUDIO_FILE} (${AUDIO_DURATION_SEC}초), 연산 장치: ${device}`);

  const audioBuffer = await readFile(AUDIO_PATH);
  const results = { audioFile: AUDIO_FILE, audioDurationSec: AUDIO_DURATION_SEC, device, whisperCli: {}, whisperX: {} };

  for (const model of WHISPER_CLI_MODELS) {
    results.whisperCli[model] = await timeRun(`Whisper CLI - ${model}`, () =>
      transcribeLocalWhisperCli(audioBuffer, AUDIO_FILE, model, AUDIO_DURATION_SEC)
    );
    await writeFile(OUT_PATH, JSON.stringify(results, null, 2), "utf8");
  }

  for (const model of WHISPERX_MODELS) {
    results.whisperX[model] = await timeRun(`WhisperX - ${model}`, () =>
      transcribeLocalWhisperX(audioBuffer, AUDIO_FILE, model, AUDIO_DURATION_SEC)
    );
    await writeFile(OUT_PATH, JSON.stringify(results, null, 2), "utf8");
  }

  console.log("\n===== 요약 (초) =====");
  console.log("Whisper CLI:", Object.fromEntries(Object.entries(results.whisperCli).map(([m, r]) => [m, r.ok ? r.elapsedSec : `실패`])));
  console.log("WhisperX:   ", Object.fromEntries(Object.entries(results.whisperX).map(([m, r]) => [m, r.ok ? r.elapsedSec : `실패`])));
  console.log(`\n결과 저장: ${path.relative(projectRoot, OUT_PATH)}`);
}

await main();
