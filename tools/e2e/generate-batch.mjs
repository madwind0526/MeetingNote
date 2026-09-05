// Full-flow E2E test, batch mode: generates 10 more meetings with varied presenter counts
// (1-5), each going through the same real pipeline as the single meeting built earlier
// (materials -> md conversion -> TTS audio with interleaved Q&A -> STT/diarization with the
// agenda-hint -> per-speaker text files -> LLM minutes). Draws people from a fixed 10-person
// roster with stable per-person TTS voice configs, reused across meetings in different role
// combinations - this also exercises whether the same voice gets recognized consistently across
// separate meetings, not just within one.
//
// To keep total runtime sane (~10-20 real claude-cli calls instead of ~40), this batch skips the
// presentationSummary - see buildMinutesPrompt in server/llm.mjs. Still a complete, real minutes
// document per meeting, just through the fallback path instead of the B5-enriched one.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import PDFDocument from "pdfkit";
import pptxgen from "pptxgenjs";
import JSZip from "jszip";

const BASE_URL = "http://127.0.0.1:5185";
const projectRoot = process.cwd();
const ffmpegBin = "D:\\ffmpeg\\ffmpeg-7.1.1-full_build-shared\\bin\\ffmpeg.exe";
const pythonBin = path.join(projectRoot, ".venv-whisperx", "Scripts", "python.exe");
const resultPath = path.join(projectRoot, "data", "test-audio", "e2e-batch-result.json");

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const GAP_SEC = 0.6;

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

// ---------- Roster: 10 people, stable voice per person across every meeting ----------
const ROSTER = [
  { name: "윤서진", voice: "ko-KR-SunHiNeural", rate: "+0%", pitch: "+0Hz" },
  { name: "한지민", voice: "ko-KR-SunHiNeural", rate: "-10%", pitch: "-30Hz" },
  { name: "조은우", voice: "ko-KR-SunHiNeural", rate: "+15%", pitch: "+35Hz" },
  { name: "서예린", voice: "ko-KR-InJoonNeural", rate: "+0%", pitch: "+0Hz" },
  { name: "문승현", voice: "ko-KR-InJoonNeural", rate: "-10%", pitch: "-30Hz" },
  { name: "남궁민", voice: "ko-KR-InJoonNeural", rate: "+15%", pitch: "+35Hz" },
  { name: "배수지", voice: "ko-KR-HyunsuMultilingualNeural", rate: "+0%", pitch: "+0Hz" },
  { name: "홍지호", voice: "ko-KR-HyunsuMultilingualNeural", rate: "-10%", pitch: "-30Hz" },
  { name: "임하늘", voice: "ko-KR-HyunsuMultilingualNeural", rate: "+15%", pitch: "+35Hz" },
  { name: "노준영", voice: "ko-KR-SunHiNeural", rate: "+25%", pitch: "-15Hz" }
];

// ---------- Topic pool: cycled across presenters/meetings ----------
const TOPICS = [
  { title: "모바일 앱 성능 개선", format: "pptx", bullets: ["앱 시작 시간 3.2초 → 1.8초로 단축", "크래시율 0.8% → 0.2%로 감소", "메모리 사용량 15% 절감", "다음 분기 목표: 시작 시간 1.2초"] },
  { title: "신규 채용 현황", format: "pdf", bullets: ["채용 공고 12건, 지원자 340명 접수", "최종 합격 8명, 평균 채용 소요 26일", "백엔드/프론트 직군 경쟁률이 가장 높음", "다음 분기 채용 목표 6명"] },
  { title: "보안 점검 결과", format: "xlsx", bullets: ["취약점 총 42건 발견", "심각 3건 즉시 패치 완료", "중간 15건은 2주 내 조치 예정", "외부 침투테스트 통과"] },
  { title: "마케팅 캠페인 성과", format: "pptx", bullets: ["노출 120만회, 클릭률 3.4%", "전환 850건, ROAS 4.2배", "20대 타겟층 반응이 가장 높음", "다음 캠페인은 리타겟팅 강화"] },
  { title: "데이터 파이프라인 안정화", format: "pdf", bullets: ["배치 실패율 12% → 2%로 감소", "평균 지연시간 45분 → 12분", "실패 시 자동 알림 체계 신설", "다음 목표: 실패율 1% 이하"] },
  { title: "사내 헬프데스크 통계", format: "xlsx", bullets: ["이번 분기 문의 620건 접수", "평균 처리 시간 3.1시간", "만족도 82점(100점 만점)", "반복 문의 유형 상위 3개 파악"] },
  { title: "물류센터 자동화 파일럿", format: "pptx", bullets: ["피킹 속도 40% 향상", "오배송률 1.2% → 0.3%로 감소", "투자비 회수 14개월 예상", "2호 물류센터 확대 검토 중"] },
  { title: "구독형 요금제 개편안", format: "pdf", bullets: ["현재 이탈율 6.8%, 목표 4%", "신규 요금제 3종 설계", "예상 매출 증가 약 8%", "베타 테스트 10월 진행 예정"] }
];

// ---------- Material builders (generic: title + bullets -> pptx/pdf/xlsx) ----------
async function buildPptxBuffer(topic, presenterName) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.title = topic.title;
  pptx.lang = "ko-KR";
  pptx.theme = { headFontFace: "Malgun Gothic", bodyFontFace: "Malgun Gothic", lang: "ko-KR" };
  const slide = pptx.addSlide();
  slide.background = { color: "F8FAFC" };
  slide.addText(topic.title, { x: 0.55, y: 0.4, w: 12.2, h: 0.7, fontFace: "Malgun Gothic", fontSize: 28, bold: true, color: "111827" });
  slide.addText(`발표자: ${presenterName}`, { x: 0.6, y: 1.15, w: 12, h: 0.45, fontFace: "Malgun Gothic", fontSize: 16, bold: true, color: "2563EB" });
  slide.addText(
    topic.bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
    { x: 0.65, y: 1.8, w: 11.7, h: 4.5, fontFace: "Malgun Gothic", fontSize: 18, color: "1F2937" }
  );
  return pptx.write({ outputType: "nodebuffer" });
}

async function buildPdfBuffer(topic, presenterName) {
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
    doc.fontSize(11).fillColor("#2563EB").text(`발표자: ${presenterName}`);
    doc.fillColor("#000000").moveDown(1);
    doc.fontSize(12);
    for (const bullet of topic.bullets) {
      doc.text(`- ${bullet}`);
    }
    doc.end();
  });
}

function escXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function buildXlsxBuffer(topic, presenterName) {
  const rows = [["구분", "내용"], ["제목", topic.title], ["발표자", presenterName], ...topic.bullets.map((bullet, index) => [`항목 ${index + 1}`, bullet])];
  const sheetRows = rows
    .map(
      (row, rowIndex) =>
        `<row r="${rowIndex + 1}">${row
          .map((value, colIndex) => `<c r="${String.fromCharCode(65 + colIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${escXml(value)}</t></is></c>`)
          .join("")}</row>`
    )
    .join("");

  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
  );
  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Malgun Gothic"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`
  );
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`);

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function buildMaterialBuffer(topic, presenterName) {
  if (topic.format === "pptx") return { buffer: await buildPptxBuffer(topic, presenterName), fileName: `${slug(topic.title)}.pptx` };
  if (topic.format === "pdf") return { buffer: await buildPdfBuffer(topic, presenterName), fileName: `${slug(topic.title)}.pdf` };
  return { buffer: await buildXlsxBuffer(topic, presenterName), fileName: `${slug(topic.title)}.xlsx` };
}

function slug(title) {
  return title.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

// ---------- TTS ----------
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with ${code}: ${stderr.slice(-500)}`));
        return;
      }
      resolve();
    });
  });
}

async function synthesizeTurn(workDir, index, text, person) {
  const mp3Path = path.join(workDir, `turn-${index}.mp3`);
  const wavPath = path.join(workDir, `turn-${index}.wav`);
  await run(pythonBin, ["-m", "edge_tts", "-t", text, "-v", person.voice, `--rate=${person.rate}`, `--pitch=${person.pitch}`, "--write-media", mp3Path]);
  await run(ffmpegBin, ["-y", "-i", mp3Path, "-ac", "1", "-ar", String(SAMPLE_RATE), "-sample_fmt", "s16", wavPath]);
  return wavPath;
}

async function readPcmData(wavPath) {
  const buffer = await readFile(wavPath);
  const dataChunkStart = buffer.indexOf(Buffer.from("data"));
  const dataSize = buffer.readUInt32LE(dataChunkStart + 4);
  return buffer.subarray(dataChunkStart + 8, dataChunkStart + 8 + dataSize);
}

function writeWavFile(filePath, pcmData) {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * BYTES_PER_SAMPLE;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
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
  header.writeUInt32LE(pcmData.length, 40);
  return writeFile(filePath, Buffer.concat([header, pcmData]));
}

async function synthesizeMeetingAudio(turns, outWavPath) {
  const workDir = await mkdtemp(path.join(tmpdir(), "meetingnote-e2e-batch-"));
  try {
    const silenceBuffer = Buffer.alloc(Math.round(SAMPLE_RATE * GAP_SEC) * BYTES_PER_SAMPLE);
    const pcmChunks = [];
    let cursorSec = 0;

    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index];
      const wavPath = await synthesizeTurn(workDir, index, turn.text, turn.person);
      const pcm = await readPcmData(wavPath);
      const durationSec = pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
      if (index > 0) {
        pcmChunks.push(silenceBuffer);
        cursorSec += GAP_SEC;
      }
      turn.startSec = Math.round(cursorSec * 100) / 100;
      cursorSec += durationSec;
      turn.endSec = Math.round(cursorSec * 100) / 100;
      pcmChunks.push(pcm);
    }

    await mkdir(path.dirname(outWavPath), { recursive: true });
    await writeWavFile(outWavPath, Buffer.concat(pcmChunks));
    return cursorSec;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
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

function sanitizeFileNamePart(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, "_");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- Meeting spec builder ----------
function buildMeetingSpec(index) {
  const presenterCounts = [1, 2, 3, 4, 5, 2, 3, 1, 4, 2];
  const attendeeCounts = [1, 1, 2, 2, 2, 1, 2, 1, 2, 1];
  const presenterCount = presenterCounts[index];
  const attendeeCount = attendeeCounts[index];

  // Rotate the roster start point per meeting so the same people show up in different
  // role combinations across meetings instead of always being "organizer" or always "presenter1".
  const rosterOffset = index * 3;
  const pick = (n) => ROSTER[(rosterOffset + n) % ROSTER.length];

  const organizer = pick(0);
  const presenters = Array.from({ length: presenterCount }, (_, i) => pick(1 + i));
  const attendees = Array.from({ length: attendeeCount }, (_, i) => pick(1 + presenterCount + i));

  const topicOffset = index * 2;
  const agenda = presenters.map((presenter, i) => {
    const topic = TOPICS[(topicOffset + i) % TOPICS.length];
    return { no: i + 1, topic, presenter };
  });

  const date = `2026-08-${String(23 + index).padStart(2, "0")}`;
  const title = `배치테스트 ${index + 1}회차 - ${agenda.map((item) => item.topic.title).join("/")}`;

  return { index, date, title, organizer, presenters, attendees, agenda };
}

function buildTurns(spec) {
  const turns = [];
  const say = (person, text) => turns.push({ person, text });

  say(spec.organizer, `안녕하세요, ${spec.title.split(" - ")[0]} 회의를 시작하겠습니다. 오늘은 ${spec.agenda.map((item) => item.topic.title).join(", ")} 순서로 진행하겠습니다.`);

  spec.agenda.forEach((item, i) => {
    const b = item.topic.bullets;
    say(item.presenter, `안녕하세요, ${item.presenter.name}입니다. ${item.topic.title} 관련해서 말씀드리면, ${b[0]}. ${b[1]}.`);

    const asker = spec.attendees[i % Math.max(1, spec.attendees.length)] ?? spec.organizer;
    say(asker, `${b[2] ?? "관련해서"} 부분은 좀 더 자세히 설명해 주실 수 있나요?`);
    say(item.presenter, `네, ${b[2] ?? "관련 내용은 다음 보고에서"} 부분이고, ${b[3] ?? "추가로 확인해서 공유드리겠습니다"}.`);

    if (i < spec.agenda.length - 1) {
      say(spec.organizer, `감사합니다. 다음은 ${spec.agenda[i + 1].presenter.name} 님, ${spec.agenda[i + 1].topic.title} 발표 부탁드립니다.`);
    }
  });

  say(spec.organizer, "모두 수고하셨습니다. 오늘 논의된 내용은 회의록으로 정리해서 공유드리겠습니다. 이상으로 회의를 마치겠습니다.");
  return turns;
}

// ---------- Per-meeting pipeline ----------
async function runOneMeeting(spec) {
  const folderLabel = `${spec.date}-${spec.title}`;
  console.log(`\n===== [${spec.index + 1}/10] ${spec.title} (발표자 ${spec.presenters.length}명, 참석자 ${spec.attendees.length}명) =====`);

  console.log("  자료 생성/업로드 중...");
  const agenda = [];
  for (const item of spec.agenda) {
    const { buffer, fileName } = await buildMaterialBuffer(item.topic, item.presenter.name);
    const upload = await uploadAttachment(folderLabel, "materials", fileName, buffer);
    agenda.push({
      no: item.no,
      title: item.topic.title,
      durationMinutes: 1,
      material: fileName,
      materialPath: upload.path,
      materialMdPath: upload.mdPath,
      presenter: item.presenter.name
    });
  }

  const attendees = [
    ...spec.presenters.map((person) => ({ id: person.name, name: person.name, role: "", isKeyAttendee: true, isPresenter: true })),
    ...spec.attendees.map((person) => ({ id: person.name, name: person.name, role: "", isKeyAttendee: true, isPresenter: false }))
  ];

  const { meeting } = await api("/api/meetings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: spec.title,
      date: spec.date,
      startTime: "10:00",
      endTime: "10:30",
      organizer: spec.organizer.name,
      secretary: "",
      attendees,
      actionItems: [],
      agenda,
      audio: null,
      minutes: "",
      authorId: ""
    })
  });

  console.log("  음성 합성 중 (edge-tts)...");
  const turns = buildTurns(spec);
  const audioFileName = `${slug(spec.title)}.wav`;
  const tempAudioPath = path.join(projectRoot, "data", "test-audio", "_batch-tmp", audioFileName);
  const totalDurationSec = await synthesizeMeetingAudio(turns, tempAudioPath);
  console.log(`  합성 완료: ${turns.length}턴, ${totalDurationSec.toFixed(1)}초`);

  const audioBuffer = await readFile(tempAudioPath);
  const audioUpload = await uploadAttachment(folderLabel, "audio", audioFileName, audioBuffer);

  console.log("  STT 분석 중...");
  const attendeeNames = [...spec.presenters.map((p) => p.name), ...spec.attendees.map((p) => p.name)];
  const agendaForHint = agenda.map((item) => ({ no: item.no, durationMinutes: item.durationMinutes, presenter: item.presenter }));

  const { jobId } = await api("/api/stt/transcribe/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: "local-whisper-cli",
      model: "turbo",
      audioBase64: audioBuffer.toString("base64"),
      fileName: audioFileName,
      durationSec: 0,
      preprocessing: { vocalIsolation: false, noiseRemoval: false, normalize: false },
      attendeeNames,
      agenda: agendaForHint
    })
  });

  let job;
  for (;;) {
    await sleep(1500);
    job = await api(`/api/stt/transcribe/status?jobId=${encodeURIComponent(jobId)}`);
    if (job.status === "done" || job.status === "error" || job.status === "cancelled") break;
  }
  if (job.status !== "done" || !job.result) {
    throw new Error(`STT 실패: ${job.status} ${job.error ?? ""}`);
  }
  const analysis = job.result;
  console.log(`  STT 완료: 세그먼트 ${analysis.transcriptSegments.length}개, 감지된 화자 ${Object.keys(analysis.speakerMap).length}명 (실제 ${attendeeNames.length + 1}명)`);
  console.log(`  speakerMap: ${JSON.stringify(analysis.speakerMap)}`);

  const transcriptText = analysis.transcriptSegments
    .map((segment) => `[${formatMmSs(segment.startSec)}-${formatMmSs(segment.endSec)}] ${resolveSpeakerName(segment.speaker, analysis.speakerMap)}: ${segment.text}`)
    .join("\n");
  const transcriptUpload = await uploadAttachment(folderLabel, "audio", `${slug(spec.title)}-stt-transcript.txt`, Buffer.from(transcriptText, "utf8"));

  const bySpeaker = new Map();
  for (const segment of analysis.transcriptSegments) {
    const name = resolveSpeakerName(segment.speaker, analysis.speakerMap);
    if (!bySpeaker.has(name)) bySpeaker.set(name, []);
    bySpeaker.get(name).push(segment);
  }
  const speakerFiles = [];
  for (const [name, segments] of bySpeaker) {
    const content = segments.map((segment) => `[${formatMmSs(segment.startSec)}-${formatMmSs(segment.endSec)}] ${segment.text}`).join("\n");
    const upload = await uploadAttachment(folderLabel, "audio", `speaker-${sanitizeFileNamePart(name)}.txt`, Buffer.from(content, "utf8"));
    speakerFiles.push({ speaker: name, segmentCount: segments.length, path: upload.path });
  }

  await api(`/api/meetings/${meeting.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audio: {
        fileName: audioFileName,
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

  console.log("  회의록 작성 중 (claude-cli, B6)...");
  const meetingForMinutes = (await api("/api/meetings")).meetings.find((candidate) => candidate.id === meeting.id);
  const minutesStartedAt = Date.now();
  const { minutes } = await api("/api/llm/minutes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "claude-cli", meeting: meetingForMinutes })
  });
  console.log(`  회의록 작성 완료 (${((Date.now() - minutesStartedAt) / 1000).toFixed(1)}s)`);

  await api(`/api/meetings/${meeting.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ minutes })
  });

  await rm(tempAudioPath, { force: true });

  return {
    meetingId: meeting.id,
    title: spec.title,
    presenterCount: spec.presenters.length,
    attendeeCount: spec.attendees.length,
    expectedSpeakerCount: attendeeNames.length + 1,
    detectedSpeakerCount: Object.keys(analysis.speakerMap).length,
    speakerMap: analysis.speakerMap,
    speakerFiles,
    minutesLength: minutes.length
  };
}

async function main() {
  const results = [];
  for (let index = 0; index < 10; index += 1) {
    const spec = buildMeetingSpec(index);
    try {
      const result = await runOneMeeting(spec);
      results.push({ ok: true, ...result });
    } catch (error) {
      console.error(`  !! 실패: ${error instanceof Error ? error.message : String(error)}`);
      results.push({ ok: false, title: spec.title, error: error instanceof Error ? error.message : String(error) });
    }
    await writeFile(resultPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  }

  console.log("\n===== 배치 요약 =====");
  for (const result of results) {
    if (result.ok) {
      console.log(`- ${result.title}: 발표자${result.presenterCount}/참석자${result.attendeeCount} | 예상 화자 ${result.expectedSpeakerCount} vs 감지 ${result.detectedSpeakerCount} | 회의록 ${result.minutesLength}자`);
    } else {
      console.log(`- ${result.title}: 실패 (${result.error})`);
    }
  }
  console.log(`\n결과 저장: ${path.relative(projectRoot, resultPath)}`);
}

await main();
