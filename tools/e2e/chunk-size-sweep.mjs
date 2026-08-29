// Finds a practical max/sweet-spot chunk size: splits the same ~4-minute base audio into chunks
// of several candidate sizes (15/30/60/120s, and the whole file as one chunk), runs each split
// through real STT (local-whisper-cli/turbo, same as the app), and reports total wall-clock time
// per chunk size - not full meeting flow, just the STT timing question in isolation so results
// come back fast.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const BASE_URL = "http://127.0.0.1:5185";
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const BASE_AUDIO_PATH = path.join(projectRoot, "data", "test-audio", "duration-bench", "base-5min.wav");
const RESULT_PATH = path.join(projectRoot, "data", "test-audio", "duration-bench", "chunk-size-sweep-result.json");
const CHUNK_SIZES_SEC = [15, 30, 60, 120, 237];

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
      fileName: "base-5min.wav",
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

async function testChunkSize(pcm, chunkSec) {
  const chunks = sliceIntoChunks(pcm, chunkSec);
  console.log(`\n=== chunk size ${chunkSec}초 (${chunks.length}개 청크) ===`);

  const start = Date.now();
  let totalSegments = 0;
  let failures = 0;

  for (let i = 0; i < chunks.length; i += 1) {
    const chunkStart = Date.now();
    try {
      const result = await transcribeChunk(chunks[i]);
      totalSegments += result.transcriptSegments?.length ?? 0;
      console.log(`  청크 ${i + 1}/${chunks.length}: ${((Date.now() - chunkStart) / 1000).toFixed(1)}초`);
    } catch (error) {
      failures += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  청크 ${i + 1}/${chunks.length}: 실패 (${message.slice(0, 200)})`);
    }
  }

  const totalSec = (Date.now() - start) / 1000;
  const audioSec = pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);

  return {
    chunkSizeSec: chunkSec,
    chunkCount: chunks.length,
    totalProcessingSec: Number(totalSec.toFixed(1)),
    avgPerChunkSec: Number((totalSec / chunks.length).toFixed(1)),
    realtimeMultiplier: Number((audioSec / totalSec).toFixed(2)),
    totalSegments,
    failures
  };
}

async function main() {
  const buffer = await readFile(BASE_AUDIO_PATH);
  const pcm = readPcmFromWav(buffer);
  const audioSec = pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
  console.log(`기준 오디오: ${audioSec.toFixed(1)}초 (${(audioSec / 60).toFixed(2)}분)`);

  const results = [];
  for (const chunkSec of CHUNK_SIZES_SEC) {
    const effectiveChunkSec = Math.min(chunkSec, Math.ceil(audioSec));
    const result = await testChunkSize(pcm, effectiveChunkSec);
    results.push(result);
    await writeFile(RESULT_PATH, JSON.stringify(results, null, 2), "utf8");
  }

  console.log("\n===== 요약 =====");
  console.log("chunk_size(초) | 청크 수 | 총 처리 시간(초) | 청크당 평균(초) | 실시간 배속");
  for (const r of results) {
    console.log(`${r.chunkSizeSec}\t${r.chunkCount}\t${r.totalProcessingSec}\t${r.avgPerChunkSec}\t${r.realtimeMultiplier}x`);
  }
  console.log(`\n결과 저장: ${path.relative(projectRoot, RESULT_PATH)}`);
}

await main();
