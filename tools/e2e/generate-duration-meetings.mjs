// Full-flow test at increasing audio length: materials -> MD -> audio -> CHUNKED STT (same ~15s
// per-chunk approach as useChunkedAudioAnalysis.ts, not one giant STT call - a single call on a
// 47-minute file would also blow past TRANSCRIBE_TIMEOUT_MS) -> B5 (발표 내용 자동 정리, windowed)
// -> B6 (회의록 작성). Runs on the 4 duration-bench WAVs built by build-duration-audio.mjs, which
// are the same ~4-minute script repeated 1/2/6/12 times - the point is testing the pipeline holds
// up as length grows, not generating hours of unique dialogue.
//
// Cross-chunk 미등록 화자 identity reconciliation (reconcileUnregisteredSpeakers, client-side
// TypeScript) is intentionally NOT replicated here - out of scope for what this run is checking
// (token limits, B5 windowing, total wall-clock, save/attachment correctness), so speaker labels
// may drift across chunks. Noted in the run summary.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import PDFDocument from "pdfkit";
import pptxgen from "pptxgenjs";

const projectRoot = process.cwd();
const BASE_URL = "http://127.0.0.1:5185";
// Mirrors useChunkedAudioAnalysis.ts's pickChunkSizeBounds tiering (>=30분 -> 5분 청크, >=10분 ->
// 2분 청크, else 1분 청크) so this test exercises the same chunk sizes production would actually
// pick for each meeting length, rather than one fixed size.
function pickChunkSec(totalDurationSec) {
  if (totalDurationSec >= 1800) return 300;
  if (totalDurationSec >= 600) return 120;
  return 60;
}
const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const AUDIO_DIR = path.join(projectRoot, "data", "test-audio", "duration-bench");
const RESULT_PATH = path.join(AUDIO_DIR, "duration-meetings-result.json");

const appSettings = JSON.parse(await readFile(path.join(projectRoot, "data", "runtime", "app-settings.json"), "utf8"));
const sttProvider = "local-whisper-cli";
const sttModel = "turbo";
const llmProvider = appSettings.llmProvider || "ollama";
const ollamaBaseUrl = appSettings.ollamaBaseUrl;
const ollamaModel = appSettings.ollamaModel;

console.log(`설정: LLM=${llmProvider}(${ollamaModel ?? ""}) STT=${sttProvider}(${sttModel}), 청크 길이=회의 길이별 자동 결정(1/2/5분)`);

const ATTENDEES = [
  { name: "김도현", role: "PM", isPresenter: false },
  { name: "박서연", role: "백엔드팀", isPresenter: true },
  { name: "이준호", role: "고객지원팀", isPresenter: true },
  { name: "최유나", role: "인프라팀", isPresenter: true },
  { name: "정하은", role: "간사", isPresenter: false },
  { name: "강민재", role: "참석자", isPresenter: false }
];

const TOPICS = [
  {
    title: "AI 코드리뷰 파일럿",
    presenter: "박서연",
    format: "pptx",
    bullets: ["8월 한 달간 백엔드팀 12명 대상, PR 340건에 적용", "리뷰 대기시간 18시간 → 6시간으로 단축", "스타일 지적의 72%는 자동 처리, 오탐률 15% → 4%로 개선", "다음 분기 프론트엔드팀까지 확대 예정"]
  },
  {
    title: "고객 지원 프로세스 개선",
    presenter: "이준호",
    format: "pdf",
    bullets: ["챗봇 1차 응대 비중 확대, 상담사 배정 로직 개편", "평균 응답 시간 40% 단축", "상담사 이관 비율 35%, 다음 분기 30% 이하 목표", "고객 만족도 조사 점수 전분기 대비 상승"]
  },
  {
    title: "인프라 비용 집행",
    presenter: "최유나",
    format: "pdf",
    bullets: ["예약 인스턴스 전환 + 유휴 리소스 정리로 월 비용 20% 절감", "무중단 전환 완료, 새벽 시간대 단계적 진행", "다음 분기 예산은 유지, 내부 배분만 조정", "모니터링 대시보드로 전 과정 실시간 확인"]
  }
];

const DURATION_FILES = [
  { minutes: 5, fileName: "duration-5min.wav" },
  { minutes: 10, fileName: "duration-10min.wav" },
  { minutes: 30, fileName: "duration-30min.wav" },
  { minutes: 60, fileName: "duration-60min.wav" }
];

// ---------- Material builders (same approach as generate-batch.mjs) ----------
const fontCandidates = ["C:\\Windows\\Fonts\\malgun.ttf", "C:\\Windows\\Fonts\\NanumGothic.ttf", "C:\\Windows\\Fonts\\NotoSansKR-Regular.ttf"];
async function resolveFontPath() {
  for (const candidate of fontCandidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function slug(title) {
  return title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

async function buildPptxBuffer(topic) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = topic.title;
  pptx.lang = "ko-KR";
  pptx.theme = { headFontFace: "Malgun Gothic", bodyFontFace: "Malgun Gothic", lang: "ko-KR" };
  const slide = pptx.addSlide();
  slide.background = { color: "F8FAFC" };
  slide.addText(topic.title, { x: 0.55, y: 0.4, w: 12.2, h: 0.7, fontFace: "Malgun Gothic", fontSize: 28, bold: true, color: "111827" });
  slide.addText(`발표자: ${topic.presenter}`, { x: 0.6, y: 1.15, w: 12, h: 0.45, fontFace: "Malgun Gothic", fontSize: 16, bold: true, color: "2563EB" });
  slide.addText(
    topic.bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
    { x: 0.65, y: 1.8, w: 11.7, h: 4.5, fontFace: "Malgun Gothic", fontSize: 18, color: "1F2937" }
  );
  return pptx.write({ outputType: "nodebuffer" });
}

async function buildPdfBuffer(topic) {
  const fontPath = await resolveFontPath();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    if (fontPath) {
      doc.registerFont("Korean", fontPath);
      doc.font("Korean");
    }
    doc.fontSize(20).text(topic.title);
    doc.moveDown(0.3);
    doc.fontSize(11).fillColor("#2563EB").text(`발표자: ${topic.presenter}`);
    doc.fillColor("#000000").moveDown(1);
    doc.fontSize(12);
    for (const bullet of topic.bullets) {
      doc.text(`- ${bullet}`);
    }
    doc.end();
  });
}

async function buildMaterialBuffer(topic) {
  if (topic.format === "pdf") return { buffer: await buildPdfBuffer(topic), fileName: `${slug(topic.title)}.pdf` };
  return { buffer: await buildPptxBuffer(topic), fileName: `${slug(topic.title)}.pptx` };
}

// ---------- HTTP helpers ----------
async function api(pathname, init) {
  const response = await fetch(`${BASE_URL}${pathname}`, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${pathname} 실패: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function uploadAttachment(meetingTitle, kind, fileName, buffer) {
  return api("/api/attachments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meetingTitle, kind, fileName, contentBase64: buffer.toString("base64") })
  });
}

function formatMmSs(totalSeconds) {
  const safe = Math.max(0, Math.round(totalSeconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function resolveSpeakerName(speaker, speakerMap) {
  const mapped = speakerMap?.[speaker];
  return mapped && mapped.trim() ? mapped : speaker || "화자 미상";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- WAV helpers ----------
function readPcmFromWav(buffer) {
  const dataIdx = buffer.indexOf("data");
  const dataSize = buffer.readUInt32LE(dataIdx + 4);
  return buffer.subarray(dataIdx + 8, dataIdx + 8 + dataSize);
}

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

function sliceIntoChunks(pcm, chunkSec) {
  const chunkBytes = chunkSec * SAMPLE_RATE * BYTES_PER_SAMPLE;
  const chunks = [];
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    const slice = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
    chunks.push({ startSec: offset / (SAMPLE_RATE * BYTES_PER_SAMPLE), pcm: slice });
  }
  return chunks;
}

// ---------- Chunked STT (mirrors useChunkedAudioAnalysis.ts's per-chunk job loop) ----------
async function transcribeChunk(pcm, fileName, agendaHint) {
  const wavBuffer = Buffer.concat([wavHeader(pcm.length), pcm]);
  const { jobId } = await api("/api/stt/transcribe/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: sttProvider,
      model: sttModel,
      audioBase64: wavBuffer.toString("base64"),
      fileName,
      durationSec: pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE),
      preprocessing: { vocalIsolation: false, noiseRemoval: false, normalize: false },
      attendeeNames: ATTENDEES.map((a) => a.name),
      agenda: agendaHint
    })
  });

  let job;
  for (;;) {
    await sleep(1500);
    job = await api(`/api/stt/transcribe/status?jobId=${encodeURIComponent(jobId)}`);
    if (job.status === "done" || job.status === "error" || job.status === "cancelled") break;
  }
  if (job.status !== "done" || !job.result) {
    throw new Error(`청크 STT 실패: ${job.status} ${job.error ?? ""}`);
  }
  return job.result;
}

async function runChunkedStt(wavPath, fileName, agendaHint, chunkSec) {
  const buffer = await readFile(wavPath);
  const pcm = readPcmFromWav(buffer);
  const chunks = sliceIntoChunks(pcm, chunkSec);
  console.log(`  총 ${chunks.length}개 청크 (약 ${chunkSec}초씩, 전체 ${(pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE) / 60).toFixed(1)}분)`);

  let mergedSegments = [];
  let mergedSpeakerMap = {};
  const startedAt = Date.now();

  for (let i = 0; i < chunks.length; i += 1) {
    const chunkStart = Date.now();
    const result = await transcribeChunk(chunks[i].pcm, fileName, agendaHint);
    const offsetSegments = (result.transcriptSegments ?? []).map((seg) => ({
      ...seg,
      startSec: seg.startSec + chunks[i].startSec,
      endSec: seg.endSec + chunks[i].startSec
    }));
    mergedSegments = mergedSegments.concat(offsetSegments);
    mergedSpeakerMap = { ...mergedSpeakerMap, ...(result.speakerMap ?? {}) };

    const chunkElapsedSec = (Date.now() - chunkStart) / 1000;
    const totalElapsedMin = (Date.now() - startedAt) / 60000;
    if ((i + 1) % 5 === 0 || i === chunks.length - 1) {
      console.log(`    청크 ${i + 1}/${chunks.length}: ${chunkElapsedSec.toFixed(1)}초 (누적 ${totalElapsedMin.toFixed(1)}분)`);
    }
  }

  return {
    transcriptSegments: mergedSegments,
    speakerMap: mergedSpeakerMap,
    durationSec: pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE),
    chunkCount: chunks.length,
    totalSttSec: (Date.now() - startedAt) / 1000
  };
}

// ---------- Per-meeting pipeline ----------
async function runOneMeeting(target) {
  const wavPath = path.join(AUDIO_DIR, target.fileName);
  const wavPcmLength = readPcmFromWav(await readFile(wavPath)).length;
  const actualDurationSec = wavPcmLength / (SAMPLE_RATE * BYTES_PER_SAMPLE);
  const actualDurationMin = Math.round(actualDurationSec / 60);
  const chunkSec = pickChunkSec(actualDurationSec);
  const title = `(${actualDurationMin}분) 회의록`;
  const folderLabel = `2026-08-26-${title}`;
  console.log(`\n===== ${title} (목표 ${target.minutes}분, 실측 ${actualDurationMin}분, 청크 ${chunkSec}초) =====`);

  console.log("  발표 자료 생성/업로드 중...");
  const agenda = [];
  for (let i = 0; i < TOPICS.length; i += 1) {
    const topic = TOPICS[i];
    const { buffer, fileName } = await buildMaterialBuffer(topic);
    const upload = await uploadAttachment(folderLabel, "materials", fileName, buffer);
    agenda.push({
      no: i + 1,
      title: topic.title,
      durationMinutes: 2,
      material: fileName,
      materialPath: upload.path,
      materialMdPath: upload.mdPath,
      presenter: topic.presenter,
      presentationSummary: ""
    });
  }

  const { meeting } = await api("/api/meetings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      date: "2026-08-26",
      startTime: "10:00",
      endTime: "10:30",
      organizer: "김도현",
      secretary: "정하은",
      attendees: ATTENDEES,
      actionItems: [],
      agenda,
      audio: null,
      minutes: "",
      authorId: ""
    })
  });

  console.log("  오디오 원본 파일 등록 중...");
  const audioBuffer = await readFile(wavPath);
  const audioUpload = await uploadAttachment(folderLabel, "audio", target.fileName, audioBuffer);

  console.log(`  청크 단위 STT 시작 (${sttProvider}/${sttModel})...`);
  const agendaHint = agenda.map((item) => ({ no: item.no, durationMinutes: item.durationMinutes, presenter: item.presenter }));
  const sttStartedAt = Date.now();
  const stt = await runChunkedStt(wavPath, target.fileName, agendaHint, chunkSec);
  const sttElapsedMin = (Date.now() - sttStartedAt) / 60000;
  console.log(`  STT 완료: ${stt.chunkCount}개 청크, 세그먼트 ${stt.transcriptSegments.length}개, 화자 라벨 ${Object.keys(stt.speakerMap).length}개, 소요 ${sttElapsedMin.toFixed(1)}분`);

  const transcriptText = stt.transcriptSegments
    .map((segment) => `[${formatMmSs(segment.startSec)}-${formatMmSs(segment.endSec)}] ${resolveSpeakerName(segment.speaker, stt.speakerMap)}: ${segment.text}`)
    .join("\n");
  const transcriptUpload = await uploadAttachment(folderLabel, "audio", `${slug(title)}-stt-transcript.txt`, Buffer.from(transcriptText, "utf8"));

  await api(`/api/meetings/${meeting.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audio: {
        fileName: target.fileName,
        durationSec: stt.durationSec,
        preprocessing: { vocalIsolation: false, noiseRemoval: false, normalize: false },
        transcriptSegments: stt.transcriptSegments,
        speakerMap: stt.speakerMap,
        analyzedAt: new Date().toISOString(),
        audioPath: audioUpload.path,
        transcriptPath: transcriptUpload.path
      }
    })
  });

  console.log(`  발표 내용 자동 정리 중 (B5, ${agenda.length}건, ${llmProvider})...`);
  const b5StartedAt = Date.now();
  let meetingForSummary = (await api("/api/meetings")).meetings.find((candidate) => candidate.id === meeting.id);
  for (const item of agenda) {
    const { summary } = await api("/api/llm/presentation-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: llmProvider, meeting: meetingForSummary, agendaNo: item.no, ollamaBaseUrl, ollamaModel })
    });
    item.presentationSummary = summary;
    await uploadAttachment(folderLabel, "materials", `발표내용정리-${slug(item.title)}.md`, Buffer.from(summary, "utf8"));
  }
  const b5ElapsedSec = (Date.now() - b5StartedAt) / 1000;
  console.log(`  B5 완료: ${b5ElapsedSec.toFixed(1)}초`);

  await api(`/api/meetings/${meeting.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agenda })
  });

  console.log(`  회의록 작성 중 (B6, ${llmProvider})...`);
  const b6StartedAt = Date.now();
  const meetingForMinutes = (await api("/api/meetings")).meetings.find((candidate) => candidate.id === meeting.id);
  const { minutes } = await api("/api/llm/minutes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: llmProvider, meeting: meetingForMinutes, ollamaBaseUrl, ollamaModel })
  });
  const b6ElapsedSec = (Date.now() - b6StartedAt) / 1000;
  console.log(`  B6 완료: ${b6ElapsedSec.toFixed(1)}초, 회의록 ${minutes.length}자`);

  await uploadAttachment(folderLabel, "audio", `${slug(title)}-회의록.md`, Buffer.from(minutes, "utf8"));

  await api(`/api/meetings/${meeting.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ minutes })
  });

  return {
    title,
    targetMinutes: target.minutes,
    actualDurationMin,
    chunkCount: stt.chunkCount,
    segmentCount: stt.transcriptSegments.length,
    speakerLabelCount: Object.keys(stt.speakerMap).length,
    sttElapsedMin: Number(sttElapsedMin.toFixed(1)),
    b5ElapsedSec: Number(b5ElapsedSec.toFixed(1)),
    b6ElapsedSec: Number(b6ElapsedSec.toFixed(1)),
    minutesLength: minutes.length,
    totalElapsedMin: Number((sttElapsedMin + (b5ElapsedSec + b6ElapsedSec) / 60).toFixed(1))
  };
}

async function main() {
  const results = [];
  const runStartedAt = Date.now();

  for (const target of DURATION_FILES) {
    try {
      const result = await runOneMeeting(target);
      results.push({ ok: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  !! 실패: ${message.slice(0, 500)}`);
      results.push({ ok: false, targetMinutes: target.minutes, error: message.slice(0, 1000) });
    }
    await writeFile(RESULT_PATH, JSON.stringify(results, null, 2), "utf8");
  }

  const totalElapsedMin = (Date.now() - runStartedAt) / 60000;
  console.log("\n===== 요약 =====");
  for (const result of results) {
    if (result.ok) {
      console.log(
        `- ${result.title}: 청크 ${result.chunkCount}개 | 세그먼트 ${result.segmentCount}개 | STT ${result.sttElapsedMin}분 | B5 ${result.b5ElapsedSec}초 | B6 ${result.b6ElapsedSec}초 | 회의록 ${result.minutesLength}자`
      );
    } else {
      console.log(`- ${result.targetMinutes}분 목표: 실패 (${result.error})`);
    }
  }
  console.log(`\n전체 소요 시간: ${totalElapsedMin.toFixed(1)}분`);
  console.log(`결과 저장: ${path.relative(projectRoot, RESULT_PATH)}`);
}

await main();
