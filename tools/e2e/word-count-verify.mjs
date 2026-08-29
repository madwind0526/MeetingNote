// Verifies STT completeness across chunk sizes by comparing actual transcript WORD COUNTS
// (not just segment counts, which chunk-size-sweep.mjs already measured). Same underlying
// audio content split at different chunk sizes should yield roughly the same total word count;
// a large drop at a bigger chunk size would indicate silent truncation of Whisper's output.
//
// Part A: base-5min.wav (237s) at 15s (reference, closest to Whisper's native 30s window,
//          most chunks = least likely to lose anything at a boundary) vs 120s (2분).
// Part B: a 3x-concatenated copy of base-5min.wav (~711s / ~11.9min, same content repeated
//          3x back-to-back) at 120s/240s/360s (2/4/6분) per the user's follow-up request.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const BASE_URL = "http://127.0.0.1:5185";
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const BASE_AUDIO_PATH = path.join(projectRoot, "data", "test-audio", "duration-bench", "base-5min.wav");
const TRIPLE_AUDIO_PATH = path.join(projectRoot, "data", "test-audio", "duration-bench", "triple-3x.wav");
const RESULT_PATH = path.join(projectRoot, "data", "test-audio", "duration-bench", "word-count-verify-result.json");

function wavHeader(pcmLength) {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * BYTES_PER_SAMPLE;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmLength, 40);
  return header;
}

function readPcmFromWav(buffer) {
  const dataIdx = buffer.indexOf("data");
  const dataSize = buffer.readUInt32LE(dataIdx + 4);
  return buffer.subarray(dataIdx + 8, dataIdx + 8 + dataSize);
}

function sliceIntoChunks(pcm, chunkSec) {
  const chunkBytes = Math.round(chunkSec * SAMPLE_RATE * BYTES_PER_SAMPLE);
  const chunks = [];
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    chunks.push(pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length)));
  }
  return chunks;
}

async function api(pathname, init) {
  const response = await fetch(`${BASE_URL}${pathname}`, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${pathname} 실패: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function transcribeChunk(pcm) {
  const wavBuffer = Buffer.concat([wavHeader(pcm.length), pcm]);
  const { jobId } = await api("/api/stt/transcribe/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "local-whisper-cli",
      model: "turbo",
      audioBase64: wavBuffer.toString("base64"),
      fileName: "chunk.wav",
      durationSec: pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE),
      preprocessing: { vocalIsolation: false, noiseRemoval: false, normalize: false },
      attendeeNames: [],
      agenda: []
    })
  });

  let job;
  for (;;) {
    await sleep(1000);
    job = await api(`/api/stt/transcribe/status?jobId=${encodeURIComponent(jobId)}`);
    if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
      break;
    }
  }
  if (job.status !== "done" || !job.result) {
    throw new Error(`${job.status} ${job.error ?? ""}`);
  }
  return job.result;
}

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

async function testChunkSize(pcm, chunkSec, audioLabel) {
  const chunks = sliceIntoChunks(pcm, chunkSec);
  console.log(`\n=== [${audioLabel}] chunk size ${chunkSec}초 (${chunks.length}개 청크) ===`);

  const texts = [];
  let failures = 0;
  const start = Date.now();

  for (let i = 0; i < chunks.length; i += 1) {
    const chunkStart = Date.now();
    try {
      const result = await transcribeChunk(chunks[i]);
      const chunkText = (result.transcriptSegments ?? []).map((s) => s.text ?? "").join(" ");
      texts.push(chunkText);
      console.log(
        `  청크 ${i + 1}/${chunks.length}: ${((Date.now() - chunkStart) / 1000).toFixed(1)}초, ` +
          `세그먼트 ${result.transcriptSegments?.length ?? 0}개, 단어 ${countWords(chunkText)}개`
      );
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  청크 ${i + 1}/${chunks.length}: 실패 (${message.slice(0, 200)})`);
    }
  }

  const fullText = texts.join(" ").trim();
  const totalSec = (Date.now() - start) / 1000;

  return {
    audioLabel,
    chunkSizeSec: chunkSec,
    chunkCount: chunks.length,
    totalProcessingSec: Number(totalSec.toFixed(1)),
    failures,
    wordCount: countWords(fullText),
    charCount: fullText.length,
    fullText
  };
}

async function buildTripleAudio() {
  const buffer = await readFile(BASE_AUDIO_PATH);
  const basePcm = readPcmFromWav(buffer);
  const tripled = Buffer.concat([basePcm, basePcm, basePcm]);
  await writeFile(TRIPLE_AUDIO_PATH, Buffer.concat([wavHeader(tripled.length), tripled]));
  return tripled;
}

async function main() {
  const results = [];

  // Part A: base-5min.wav, 15s (reference) vs 120s (2분)
  const baseBuffer = await readFile(BASE_AUDIO_PATH);
  const basePcm = readPcmFromWav(baseBuffer);
  const baseAudioSec = basePcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
  console.log(`Part A 기준 오디오: ${baseAudioSec.toFixed(1)}초 (${(baseAudioSec / 60).toFixed(2)}분)`);

  for (const chunkSec of [15, 120]) {
    const result = await testChunkSize(basePcm, chunkSec, "base-5min (Part A)");
    results.push(result);
    await writeFile(RESULT_PATH, JSON.stringify(results, null, 2), "utf8");
  }

  // Part B: 3x concatenated base audio, 120s/240s/360s (2/4/6분)
  console.log("\nPart B용 3배 오디오 생성 중...");
  const triplePcm = await buildTripleAudio();
  const tripleAudioSec = triplePcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
  console.log(`Part B 오디오: ${tripleAudioSec.toFixed(1)}초 (${(tripleAudioSec / 60).toFixed(2)}분) -> ${TRIPLE_AUDIO_PATH}`);

  for (const chunkSec of [120, 240, 360]) {
    const result = await testChunkSize(triplePcm, chunkSec, "triple-3x (Part B)");
    results.push(result);
    await writeFile(RESULT_PATH, JSON.stringify(results, null, 2), "utf8");
  }

  console.log("\n===== 요약 =====");
  console.log("오디오 | chunk(초) | 청크 수 | 실패 | 단어 수 | 글자 수");
  for (const r of results) {
    console.log(`${r.audioLabel}\t${r.chunkSizeSec}\t${r.chunkCount}\t${r.failures}\t${r.wordCount}\t${r.charCount}`);
  }
  console.log(`\n결과 저장: ${path.relative(projectRoot, RESULT_PATH)} (전체 텍스트 포함)`);
}

await main();
