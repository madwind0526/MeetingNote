// Full-flow E2E sample generator: creates 5 real meetings through the exact same pipeline the
// app's UI drives - material upload (+ auto MD conversion), audio upload, chunked STT, per-agenda
// the current app-settings.json (read at startup, not hardcoded, so this stays consistent with
// whatever Settings currently has configured).
//
// Unlike generate-batch.mjs (which synthesizes fresh TTS audio per meeting), this reuses the
// written to match what's actually said in each recording's ground-truth transcript, so STT and
// the agenda-hint speaker matching stay realistic.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import PDFDocument from "pdfkit";
import pptxgen from "pptxgenjs";

const projectRoot = process.cwd();
const BASE_URL = "http://127.0.0.1:5185";
const resultPath = path.join(projectRoot, "data", "test-audio", "sample-5-result.json");

const appSettings = JSON.parse(await readFile(path.join(projectRoot, "data", "runtime", "app-settings.json"), "utf8"));
const llmProvider = appSettings.llmProvider || "ollama";
const ollamaBaseUrl = appSettings.ollamaBaseUrl;
const ollamaModel = appSettings.ollamaModel;
const sttProvider = appSettings.sttProvider || "local-whisper-cli";
const sttModel = sttProvider === "local-whisperx" ? "base" : "turbo";

console.log(`설정: LLM=${llmProvider}(${ollamaModel ?? ""}) STT=${sttProvider}(${sttModel})`);

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

async function buildMaterialBuffer(topic, presenterName) {
  if (topic.format === "pdf") return { buffer: await buildPdfBuffer(topic, presenterName), fileName: `${slug(topic.title)}.pdf` };
  return { buffer: await buildPptxBuffer(topic, presenterName), fileName: `${slug(topic.title)}.pptx` };
}

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

// ---------- 5 meeting specs, each anchored to a real sample audio file's actual content ----------
const SPECS = [
  {
    date: "2026-08-20",
    title: "3분기 실행 현황 점검 회의",
    organizer: "김도현",
    secretary: "정하은",
    audioFile: "meeting-3presenter-2attendee-ko.wav",
    attendees: [
      { name: "박서연", role: "백엔드팀", isPresenter: true },
      { name: "이준호", role: "고객지원팀", isPresenter: true },
      { name: "최유나", role: "인프라팀", isPresenter: true },
      { name: "정하은", role: "간사", isPresenter: false },
      { name: "강민재", role: "참석자", isPresenter: false }
    ],
    agenda: [
      {
        title: "AI 코드리뷰 파일럿",
        presenter: "박서연",
        format: "pptx",
        bullets: ["8월 한 달간 백엔드팀 12명 대상, PR 340건에 적용", "리뷰 대기시간 18시간 → 6시간으로 단축", "스타일 지적의 72%는 자동 처리"]
      },
      {
        title: "고객 지원 프로세스 개선",
        presenter: "이준호",
        format: "pdf",
        bullets: ["1차 응대 챗봇 도입으로 평균 응답 시간 단축", "상담사 배정 로직 개편", "고객 만족도 조사 점수 상승"]
      },
      {
        title: "인프라 비용 집행",
        presenter: "최유나",
        format: "pdf",
        bullets: ["클라우드 비용 전분기 대비 최적화", "예약 인스턴스 전환으로 절감", "다음 분기 예산안 초안 공유"]
      }
    ]
  },
  {
    date: "2026-08-21",
    title: "3분기 프로젝트 진행 현황 공유 회의",
    organizer: "박지훈",
    secretary: "오유진",
    audioFile: "meeting-8speakers-ko.wav",
    attendees: [
      { name: "김민서", role: "신제품개발팀", isPresenter: true },
      { name: "이수아", role: "마케팅팀", isPresenter: true },
      { name: "정도윤", role: "인프라팀", isPresenter: true },
      { name: "최하은", role: "고객지원팀", isPresenter: true },
      { name: "강태양", role: "참석자", isPresenter: false },
      { name: "오유진", role: "간사", isPresenter: false },
      { name: "배시온", role: "참석자", isPresenter: false }
    ],
    agenda: [
      {
        title: "앱 UI 리뉴얼",
        presenter: "김민서",
        format: "pptx",
        bullets: ["메인 화면 메뉴 구조 단순화", "다크 모드 신규 추가", "베타 테스트 만족도 15% 상승, 4분기 초 정식 배포 목표"]
      },
      {
        title: "SNS/인플루언서 마케팅 캠페인",
        presenter: "이수아",
        format: "pptx",
        bullets: ["SNS 광고 + 인플루언서 협업 중심 캠페인", "앱 다운로드 전분기 대비 30% 증가", "광고비 대비 전환율 목표치 상회"]
      },
      {
        title: "온프레미스 → 클라우드 이전",
        presenter: "정도윤",
        format: "pdf",
        bullets: ["무중단 이전 완료", "평균 응답 속도 40% 개선", "로그 수집 파이프라인 지연 이슈 정상화 완료"]
      },
      {
        title: "고객 문의 대응 프로세스 개선",
        presenter: "최하은",
        format: "pdf",
        bullets: ["챗봇 1차 응대 비중 확대", "상담사 배정 로직 개편으로 응답 시간 40% 단축", "고객 만족도 조사 점수 상승"]
      }
    ]
  },
  {
    date: "2026-08-22",
    title: "결제 모듈 개발 현황 점검",
    organizer: "한지민",
    secretary: "",
    audioFile: "diarize-2speaker-ko-en.wav",
    attendees: [
      { name: "한지민", role: "PM", isPresenter: false },
      { name: "조은우", role: "백엔드팀", isPresenter: true }
    ],
    agenda: [
      {
        title: "결제 모듈 개발 진행 상황",
        presenter: "조은우",
        format: "pdf",
        bullets: ["지난주 결제 모듈 개발 완료", "이번 주부터 테스트 진행 예정", "결제 연동 QA 일정 조율 필요"]
      }
    ]
  },
  {
    date: "2026-08-23",
    title: "4분기 실행 현황 점검 회의",
    organizer: "김도현",
    secretary: "정하은",
    audioFile: "meeting-3presenter-2attendee-ko.wav",
    attendees: [
      { name: "박서연", role: "백엔드팀", isPresenter: true },
      { name: "이준호", role: "고객지원팀", isPresenter: true },
      { name: "최유나", role: "인프라팀", isPresenter: true },
      { name: "정하은", role: "간사", isPresenter: false },
      { name: "강민재", role: "참석자", isPresenter: false }
    ],
    agenda: [
      {
        title: "AI 코드리뷰 파일럿",
        presenter: "박서연",
        format: "pptx",
        bullets: ["8월 한 달간 백엔드팀 12명 대상, PR 340건에 적용", "리뷰 대기시간 18시간 → 6시간으로 단축", "스타일 지적의 72%는 자동 처리"]
      },
      {
        title: "고객 지원 프로세스 개선",
        presenter: "이준호",
        format: "pdf",
        bullets: ["1차 응대 챗봇 도입으로 평균 응답 시간 단축", "상담사 배정 로직 개편", "고객 만족도 조사 점수 상승"]
      },
      {
        title: "인프라 비용 집행",
        presenter: "최유나",
        format: "pdf",
        bullets: ["클라우드 비용 전분기 대비 최적화", "예약 인스턴스 전환으로 절감", "다음 분기 예산안 초안 공유"]
      }
    ]
  },
  {
    date: "2026-08-24",
    title: "4분기 프로젝트 진행 현황 공유 회의",
    organizer: "박지훈",
    secretary: "오유진",
    audioFile: "meeting-8speakers-ko.wav",
    attendees: [
      { name: "김민서", role: "신제품개발팀", isPresenter: true },
      { name: "이수아", role: "마케팅팀", isPresenter: true },
      { name: "정도윤", role: "인프라팀", isPresenter: true },
      { name: "최하은", role: "고객지원팀", isPresenter: true },
      { name: "강태양", role: "참석자", isPresenter: false },
      { name: "오유진", role: "간사", isPresenter: false },
      { name: "배시온", role: "참석자", isPresenter: false }
    ],
    agenda: [
      {
        title: "앱 UI 리뉴얼",
        presenter: "김민서",
        format: "pptx",
        bullets: ["메인 화면 메뉴 구조 단순화", "다크 모드 신규 추가", "베타 테스트 만족도 15% 상승, 4분기 초 정식 배포 목표"]
      },
      {
        title: "SNS/인플루언서 마케팅 캠페인",
        presenter: "이수아",
        format: "pptx",
        bullets: ["SNS 광고 + 인플루언서 협업 중심 캠페인", "앱 다운로드 전분기 대비 30% 증가", "광고비 대비 전환율 목표치 상회"]
      },
      {
        title: "온프레미스 → 클라우드 이전",
        presenter: "정도윤",
        format: "pdf",
        bullets: ["무중단 이전 완료", "평균 응답 속도 40% 개선", "로그 수집 파이프라인 지연 이슈 정상화 완료"]
      },
      {
        title: "고객 문의 대응 프로세스 개선",
        presenter: "최하은",
        format: "pdf",
        bullets: ["챗봇 1차 응대 비중 확대", "상담사 배정 로직 개편으로 응답 시간 40% 단축", "고객 만족도 조사 점수 상승"]
      }
    ]
  }
];

async function runOneMeeting(spec, index) {
  const folderLabel = `${spec.date}-${spec.title}`;
  console.log(`\n===== [${index + 1}/5] ${spec.title} =====`);

  console.log("  발표 자료 생성/업로드 중...");
  const agenda = [];
  for (let i = 0; i < spec.agenda.length; i += 1) {
    const item = spec.agenda[i];
    const { buffer, fileName } = await buildMaterialBuffer(item, item.presenter);
    const upload = await uploadAttachment(folderLabel, "materials", fileName, buffer);
    agenda.push({
      no: i + 1,
      title: item.title,
      durationMinutes: 5,
      material: fileName,
      materialPath: upload.path,
      materialMdPath: upload.mdPath,
      presenter: item.presenter,
      presentationSummary: ""
    });
  }

  const attendees = spec.attendees.map((person) => ({
    id: person.name,
    name: person.name,
    role: person.role,
    isKeyAttendee: true,
    isPresenter: person.isPresenter
  }));

  const { meeting } = await api("/api/meetings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: spec.title,
      date: spec.date,
      startTime: "10:00",
      endTime: "10:30",
      organizer: spec.organizer,
      secretary: spec.secretary,
      attendees,
      actionItems: [],
      agenda,
      audio: null,
      minutes: "",
      authorId: ""
    })
  });

  console.log("  오디오 원본 파일 등록 중...");
  const sourceAudioPath = path.join(projectRoot, "data", "test-audio", spec.audioFile);
  const audioBuffer = await readFile(sourceAudioPath);
  const audioUpload = await uploadAttachment(folderLabel, "audio", spec.audioFile, audioBuffer);

  console.log(`  STT 분석 중 (${sttProvider})...`);
  const attendeeNames = spec.attendees.map((p) => p.name);
  const agendaForHint = agenda.map((item) => ({ no: item.no, durationMinutes: item.durationMinutes, presenter: item.presenter }));

  const { jobId } = await api("/api/stt/transcribe/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: sttProvider,
      model: sttModel,
      audioBase64: audioBuffer.toString("base64"),
      fileName: spec.audioFile,
      durationSec: 0,
      preprocessing: { vocalIsolation: false, noiseRemoval: false, normalize: false },
      attendeeNames,
      agenda: agendaForHint
    })
  });

  let job;
  for (;;) {
    await sleep(2000);
    job = await api(`/api/stt/transcribe/status?jobId=${encodeURIComponent(jobId)}`);
    if (job.status === "done" || job.status === "error" || job.status === "cancelled") break;
  }
  if (job.status !== "done" || !job.result) {
    throw new Error(`STT 실패: ${job.status} ${job.error ?? ""}`);
  }
  const analysis = job.result;
  console.log(`  STT 완료: 세그먼트 ${analysis.transcriptSegments.length}개, 감지된 화자 ${Object.keys(analysis.speakerMap).length}명`);

  const transcriptText = analysis.transcriptSegments
    .map((segment) => `[${formatMmSs(segment.startSec)}-${formatMmSs(segment.endSec)}] ${resolveSpeakerName(segment.speaker, analysis.speakerMap)}: ${segment.text}`)
    .join("\n");
  const transcriptUpload = await uploadAttachment(folderLabel, "audio", `${slug(spec.title)}-stt-transcript.txt`, Buffer.from(transcriptText, "utf8"));

  await api(`/api/meetings/${meeting.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audio: {
        fileName: spec.audioFile,
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

  console.log(`  발표 내용 자동 정리 중 (B5, ${agenda.length}건, ${llmProvider})...`);
  let meetingForSummary = (await api("/api/meetings")).meetings.find((candidate) => candidate.id === meeting.id);
  for (const item of agenda) {
    const { summary } = await api("/api/llm/presentation-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: llmProvider, meeting: meetingForSummary, agendaNo: item.no, ollamaBaseUrl, ollamaModel })
    });
    item.presentationSummary = summary;
    const summaryUpload = await uploadAttachment(folderLabel, "materials", `발표내용정리-${slug(item.title)}.md`, Buffer.from(summary, "utf8"));
    console.log(`    - ${item.title}: ${summary.length}자 (${summaryUpload.path})`);
  }

  await api(`/api/meetings/${meeting.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agenda })
  });

  console.log(`  회의록 작성 중 (B6, ${llmProvider})...`);
  const meetingForMinutes = (await api("/api/meetings")).meetings.find((candidate) => candidate.id === meeting.id);
  const { minutes } = await api("/api/llm/minutes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: llmProvider, meeting: meetingForMinutes, ollamaBaseUrl, ollamaModel })
  });
  console.log(`  회의록 작성 완료 (${minutes.length}자)`);

  const minutesUpload = await uploadAttachment(folderLabel, "audio", `${slug(spec.title)}-회의록.md`, Buffer.from(minutes, "utf8"));

  await api(`/api/meetings/${meeting.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ minutes })
  });

  return {
    meetingId: meeting.id,
    title: spec.title,
    agendaCount: agenda.length,
    detectedSpeakerCount: Object.keys(analysis.speakerMap).length,
    minutesPath: minutesUpload.path,
    minutesLength: minutes.length
  };
}

async function main() {
  const results = [];
  for (let index = 0; index < SPECS.length; index += 1) {
    try {
      const result = await runOneMeeting(SPECS[index], index);
      results.push({ ok: true, ...result });
    } catch (error) {
      console.error(`  !! 실패: ${error instanceof Error ? error.message : String(error)}`);
      results.push({ ok: false, title: SPECS[index].title, error: error instanceof Error ? error.message : String(error) });
    }
    await writeFile(resultPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  }

  console.log("\n===== 요약 =====");
  for (const result of results) {
    if (result.ok) {
      console.log(`- ${result.title}: agenda ${result.agendaCount}건 | 화자 ${result.detectedSpeakerCount}명 | 회의록 ${result.minutesLength}자`);
    } else {
      console.log(`- ${result.title}: 실패 (${result.error})`);
    }
  }
  console.log(`\n결과 저장: ${path.relative(projectRoot, resultPath)}`);
}

await main();
