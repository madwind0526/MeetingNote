// Full-flow E2E test, stage 3: uploads the synthesized audio, runs it through the real STT +
// diarization pipeline (local-whisper-cli, HF-token embeddings path, agenda-hint matching), builds
// LLM pipeline via claude-cli, and saves everything back onto the meeting record - all through the
// same HTTP endpoints the React UI itself calls.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const BASE_URL = "http://127.0.0.1:5185";
const projectRoot = process.cwd();
const contextPath = path.join(projectRoot, "data", "test-audio", "e2e-meeting-context.json");
const audioPath = path.join(projectRoot, "data", "test-audio", "meeting-3presenter-2attendee-ko.wav");
const resultPath = path.join(projectRoot, "data", "test-audio", "e2e-result.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(pathname, init) {
  const response = await fetch(`${BASE_URL}${pathname}`, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${pathname} 실패: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function formatMmSs(totalSeconds) {
  const safe = Math.max(0, Math.round(totalSeconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function resolveSpeakerName(speaker, speakerMap) {
  const mapped = speakerMap?.[speaker];
  return mapped && mapped.trim() ? mapped : speaker || "화자 미상";
}

function buildTranscriptText(transcriptSegments, speakerMap) {
  return transcriptSegments
    .map((segment) => `[${formatMmSs(segment.startSec)}-${formatMmSs(segment.endSec)}] ${resolveSpeakerName(segment.speaker, speakerMap)}: ${segment.text}`)
    .join("\n");
}

function sanitizeFileNamePart(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, "_");
}

async function uploadAttachment(meetingTitle, kind, fileName, buffer) {
  return api("/api/attachments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meetingTitle, kind, fileName, contentBase64: buffer.toString("base64") })
  });
}

async function main() {
  const context = JSON.parse(await readFile(contextPath, "utf8"));
  const attendeeNames = [
    ...context.attendees.filter((attendee) => attendee.isPresenter).map((attendee) => attendee.name),
    ...context.attendees.filter((attendee) => attendee.isKeyAttendee && !attendee.isPresenter).map((attendee) => attendee.name)
  ];
  const agendaForHint = context.agenda.map((item) => ({ no: item.no, durationMinutes: item.durationMinutes, presenter: item.presenter }));

  console.log("[1/6] 원본 오디오 업로드 중...");
  const audioBuffer = await readFile(audioPath);
  const audioUpload = await uploadAttachment(context.folderLabel, "audio", path.basename(audioPath), audioBuffer);
  console.log(`  audioPath=${audioUpload.path}`);

  console.log("[2/6] STT 분석 시작 (local-whisper-cli, turbo, 화자분리+agenda 힌트)...");
  const { jobId } = await api("/api/stt/transcribe/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "local-whisper-cli",
      model: "turbo",
      audioBase64: audioBuffer.toString("base64"),
      fileName: path.basename(audioPath),
      durationSec: 0,
      preprocessing: { vocalIsolation: false, noiseRemoval: false, normalize: false },
      attendeeNames,
      agenda: agendaForHint
    })
  });

  let job;
  const startedAt = Date.now();
  for (;;) {
    await sleep(1500);
    job = await api(`/api/stt/transcribe/status?jobId=${encodeURIComponent(jobId)}`);
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    console.log(`  [${elapsed}s] status=${job.status} progress=${Math.round((job.progress ?? 0) * 100)}%`);
    if (job.status === "done" || job.status === "error" || job.status === "cancelled") {
      break;
    }
  }

  if (job.status !== "done" || !job.result) {
    throw new Error(`STT 작업 실패: ${job.status} ${job.error ?? ""}`);
  }

  const analysis = job.result;
  console.log(`  완료: ${analysis.transcriptSegments.length}개 세그먼트, 화자 ${Object.keys(analysis.speakerMap).length}명`);
  console.log("  speakerMap:", JSON.stringify(analysis.speakerMap, null, 2));

  console.log("[3/6] 통합 대본 파일 + 화자별 text 파일 업로드 중...");
  const transcriptText = buildTranscriptText(analysis.transcriptSegments, analysis.speakerMap);
  const transcriptUpload = await uploadAttachment(
    context.folderLabel,
    "audio",
    `${path.basename(audioPath, ".wav")}-stt-transcript.txt`,
    Buffer.from(transcriptText, "utf8")
  );
  console.log(`  transcriptPath=${transcriptUpload.path}`);

  const bySpeaker = new Map();
  for (const segment of analysis.transcriptSegments) {
    const name = resolveSpeakerName(segment.speaker, analysis.speakerMap);
    if (!bySpeaker.has(name)) {
      bySpeaker.set(name, []);
    }
    bySpeaker.get(name).push(segment);
  }

  const speakerFiles = [];
  for (const [name, segments] of bySpeaker) {
    const content = segments.map((segment) => `[${formatMmSs(segment.startSec)}-${formatMmSs(segment.endSec)}] ${segment.text}`).join("\n");
    const fileName = `speaker-${sanitizeFileNamePart(name)}.txt`;
    const upload = await uploadAttachment(context.folderLabel, "audio", fileName, Buffer.from(content, "utf8"));
    console.log(`  ${name}: ${segments.length}개 발화 -> ${upload.path}`);
    speakerFiles.push({ speaker: name, segmentCount: segments.length, path: upload.path });
  }

  console.log("[4/6] 회의록에 오디오 분석 결과 반영 (PUT /api/meetings/:id)...");
  await api(`/api/meetings/${context.meetingId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audio: {
        fileName: path.basename(audioPath),
        durationSec: analysis.durationSec,
        preprocessing: analysis.preprocessing ?? { vocalIsolation: false, noiseRemoval: false, normalize: false },
        transcriptSegments: analysis.transcriptSegments,
        speakerMap: analysis.speakerMap,
        analyzedAt: analysis.analyzedAt ?? new Date().toISOString(),
        audioPath: audioUpload.path,
        transcriptPath: transcriptUpload.path
      }
    })
  });

  console.log("[5/6] 발표별 정리 (B5, claude-cli) - agenda 3건...");
  let meeting = (await api(`/api/meetings`)).meetings.find((candidate) => candidate.id === context.meetingId);
  const summaries = [];

  for (const agendaItem of meeting.agenda) {
    const { summary } = await api("/api/llm/presentation-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "claude-cli", meeting, agendaNo: agendaItem.no })
    });
    console.log(`  Agenda ${agendaItem.no} (${agendaItem.title}): ${summary.slice(0, 60).replace(/\n/g, " ")}...`);
    summaries.push({ no: agendaItem.no, title: agendaItem.title, summary });
  }

  const updatedAgenda = meeting.agenda.map((item) => ({
    ...item,
    presentationSummary: summaries.find((entry) => entry.no === item.no)?.summary ?? item.presentationSummary
  }));

  await api(`/api/meetings/${context.meetingId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agenda: updatedAgenda })
  });

  console.log("[6/6] 전체 회의록 작성 (B6, claude-cli)...");
  meeting = (await api(`/api/meetings`)).meetings.find((candidate) => candidate.id === context.meetingId);
  const { minutes } = await api("/api/llm/minutes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "claude-cli", meeting })
  });

  await api(`/api/meetings/${context.meetingId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ minutes })
  });

  const finalMeeting = (await api(`/api/meetings`)).meetings.find((candidate) => candidate.id === context.meetingId);

  await writeFile(
    resultPath,
    `${JSON.stringify(
      {
        meetingId: context.meetingId,
        speakerMap: analysis.speakerMap,
        transcriptSegmentCount: analysis.transcriptSegments.length,
        speakerFiles,
        presentationSummaries: summaries,
        minutes,
        finalMeeting
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(`완료. 결과 저장: ${path.relative(projectRoot, resultPath)}`);
  console.log("\n=== 회의록 미리보기 ===\n");
  console.log(minutes);
}

await main();
