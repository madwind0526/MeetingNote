import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import {
  readMeetings,
  createMeeting,
  updateMeeting,
  deleteMeeting,
  addMeetingComment,
  deleteMeetingComment,
  bulkUpsertMeetings,
  resetToSeed
} from "./server/db.mjs";
import { readMembers, createMember, updateMember, disableMember, verifyLogin, toPublicMember } from "./server/members.mjs";
import { readBoardPosts, writeBoardPosts } from "./server/board.mjs";
import { readDictionary, writeDictionary, applyDictionaryToSegments, applyDictionaryToAllMeetings } from "./server/dictionary.mjs";
import { parseJsonMeetings } from "./server/parsers/importJson.mjs";
import { parsePdfMeeting } from "./server/parsers/importPdf.mjs";
import { parseDocxMeeting } from "./server/parsers/importDocx.mjs";
import { parsePptxMeeting } from "./server/parsers/importPptx.mjs";
import { parseMdMeeting } from "./server/parsers/importMd.mjs";
import { buildJsonExport } from "./server/exporters/exportJson.mjs";
import { buildPdfExport } from "./server/exporters/exportPdf.mjs";
import { buildDocxExport } from "./server/exporters/exportDocx.mjs";
import { buildPptxExport } from "./server/exporters/exportPptx.mjs";
import { buildMdExport } from "./server/exporters/exportMd.mjs";
import { readEnvFile, writeEnvUpdates } from "./server/envFile.mjs";
import { saveLogoImage } from "./server/logo.mjs";
import { saveAttachment, resolveAttachmentPath, toProjectRelativePath, MAX_ATTACHMENT_BYTES } from "./server/attachments.mjs";
import {
  askAnthropicApi,
  askClaudeCli,
  askOllama,
  checkAnthropicApiKeyConfigured,
  checkClaudeCliAvailable,
  checkOllamaAvailable,
  buildMinutesPrompt,
  buildQueryPrompt,
  buildPresentationSummaryPrompt
} from "./server/llm.mjs";
import { transcribeMock } from "./server/audio/sttMock.mjs";
import { transcribeWhisper } from "./server/audio/sttOpenAiWhisper.mjs";
import { transcribeNaverClova } from "./server/audio/sttNaverClova.mjs";
import { checkLocalWhisperAvailable, transcribeLocalWhisperCli } from "./server/audio/sttLocalWhisperCli.mjs";
import { checkLocalWhisperXAvailable, transcribeLocalWhisperX } from "./server/audio/sttLocalWhisperX.mjs";
import { diarizeSegments, assignSpeakersWithProfiles } from "./server/audio/diarize.mjs";
import { registerVoiceProfile } from "./server/voiceProfiles.mjs";
import { preprocessAudio } from "./server/audio/audioPreprocess.mjs";

interface LlmMeeting {
  title?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  organizer?: string;
  attendees?: { name?: string }[];
  agenda?: { title?: string; presenter?: string }[];
  minutes?: string;
}

// Local, deliberately loose shape for /api/llm/presentation-summary's request body - this file
// can't import src/types/domain.ts's real Meeting/AgendaItem types (that would pull a src/ file
// into tsconfig.node.json's composite project, which only lists electron/**, vite.config.mts and
// server/**/*.mjs - same reason LlmMeeting above is a separate lightweight interface instead of
// importing Meeting).
interface PresentationAgendaItem {
  no: number;
  title?: string;
  presenter?: string;
  durationMinutes?: number;
  materialMdPath?: string;
}

interface PresentationMeeting {
  organizer?: string;
  attendees?: { id: string; name: string; isPresenter?: boolean }[];
  agenda?: PresentationAgendaItem[];
  audio?: { transcriptSegments?: { speaker: string; startSec: number; endSec: number; text: string }[]; speakerMap?: Record<string, string> } | null;
}

// Duplicated on purpose from computeAttendeeBadges in src/types/domain.ts (see the comment above -
// this file can't import that module). Keep these in sync if the badge rule ever changes: every
// attendee gets exactly one label, presenters count as "발표N" among presenters only, everyone
// else as "참석N" among non-presenters only.
function computeAttendeeBadgesForPrompt(attendees: PresentationMeeting["attendees"]): Record<string, string> {
  const badges: Record<string, string> = {};
  let presenterIndex = 0;
  let attendeeIndex = 0;

  for (const attendee of attendees ?? []) {
    if (attendee.isPresenter) {
      presenterIndex += 1;
      badges[attendee.id] = `발표${presenterIndex}`;
    } else {
      attendeeIndex += 1;
      badges[attendee.id] = `참석${attendeeIndex}`;
    }
  }

  return badges;
}

const LLM_SYSTEM_PROMPT = [
  "당신은 사용자의 회의록 저장소를 요약해서 답해주는 도우미입니다.",
  "사용자가 [회의 목록]으로 제공하는 정보만 근거로 삼아 질문에 한국어로 간결하게 답하세요.",
  "목록에 없는 내용은 추측해서 지어내지 말고, 모르면 모른다고 답하세요.",
  "이 요청은 소프트웨어 프로젝트나 코드와 무관하며, 오직 회의록 데이터에 대한 질문입니다."
].join(" ");

const MINUTES_SYSTEM_PROMPT = [
  "당신은 회의 진행자를 도와 회의록을 작성하는 도우미입니다.",
  "제공된 회의 기본정보, A/I List, Agenda, 발표별 정리(있는 경우), 화자별 발언 대본을 근거로 한국어 회의록을 Markdown으로 작성하세요.",
  "A/I List는 이번 회의가 시작되기 전에 이미 계획된 사전 액션 아이템이므로, 회의록 맨 앞부분에서 그대로 정리해 주세요.",
  "그다음 Agenda 순서대로 논의 내용을 요약하고 결정 사항을 정리하세요 - 어떤 Agenda 항목에 [발표별 정리] 내용이 제공되어 있으면 그 내용을 우선 근거로 삼고, 제공되지 않은 항목만 [발언 대본]에서 직접 찾아 요약하세요.",
  "회의록 마지막에는 반드시 \"할일\" 섹션을 만들어, 사전 A/I List·안건 논의 중 새로 나온 후속 조치·[발표별 정리]의 (할일) 태그 내용을 전부 모아 마크다운 표로 정리하세요. 표는 정확히 '할일 | 담당자 | 납기' 세 컬럼만 사용하고, 납기가 언급되지 않았으면 '-'로 채우세요. 이 표 하나로 모든 할일을 통합하고, 별도의 \"회의 중 추가된 Action Item\" 같은 산문 섹션은 만들지 마세요.",
  "\"할일\" 표 다음, 회의록의 맨 마지막에는 \"## 태그\" 섹션을 만들어 이 회의의 핵심 주제·안건·키워드를 나타내는 태그를 `#태그` 형식으로 한 줄에 공백으로 나열하세요. 태그 개수는 5개~10개 사이로 하되, 논의 내용이 짧고 단순한 회의는 5개에 가깝게, 안건이 많고 논의가 풍부한 회의는 10개에 가깝게 회의록 분량에 비례해서 정하세요. 각 태그는 공백 없는 한글 명사(구)로 간결하게 작성하세요.",
  "제공되지 않은 내용은 추측해서 지어내지 마세요.",
  "이 요청은 소프트웨어 프로젝트나 코드와 무관하며, 오직 회의록 작성 작업입니다."
].join(" ");

const PRESENTATION_SUMMARY_SYSTEM_PROMPT = [
  "당신은 회의에서 특정 발표(Agenda 항목) 하나에 대한 내용만 정리하는 도우미입니다.",
  "제공된 [발표 정보]와 [발표 자료](있는 경우)를 참고해서, [회의 전체 발언 대본]에서 이 발표와 실제로 관련된 구간만 스스로 찾아 사용하세요 - 다른 발표나 이 발표와 무관한 구간은 무시하세요.",
  "정리 결과는 반드시 다음 4가지 태그만 사용하고, 각 줄은 '(태그) 라벨-이름: 내용' 형식으로 한 줄씩 작성하세요: (질문)=발표 중 누군가 던진 질문, (답변)=그 질문에 대한 답변, (의견)=질문이 아닌 의견/코멘트, (할일)=발표 중 새로 언급된 후속 조치.",
  "라벨은 [참석자 라벨]에 주어진 것을 정확히 그대로 사용하세요(예: 주관자, 발표1, 참석1) - 라벨을 새로 만들어내지 마세요.",
  "해당하는 내용이 없는 태그는 그 줄 자체를 만들지 마세요.",
  "제공되지 않은 내용은 추측해서 지어내지 마세요.",
  "이 요청은 소프트웨어 프로젝트나 코드와 무관하며, 오직 회의 발표 내용 정리 작업입니다."
].join(" ");

const ONE_MB = 1024 * 1024;
const MAX_SMALL_BODY_BYTES = ONE_MB;
const MAX_IMPORT_BODY_BYTES = 120 * ONE_MB;
const MAX_EXPORT_BODY_BYTES = 40 * ONE_MB;
const MAX_AUDIO_BODY_BYTES = 260 * ONE_MB;
const MAX_FILE_NAVIGATOR_READ_BYTES = MAX_AUDIO_BODY_BYTES;
const MAX_FILE_NAVIGATOR_WRITE_BODY_BYTES = Math.ceil(MAX_EXPORT_BODY_BYTES * 1.4) + ONE_MB;

const ATTACHMENT_CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif"
};

function readGitValue(command: string, fallback: string) {
  try {
    return execSync(command, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function buildVersionInfo() {
  const packageJson = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as { version?: string };
  const version = packageJson.version ?? "0.0.0";
  const majorVersion = version.split(".")[0] || "0";
  const commitCount = readGitValue("git rev-list --count HEAD", "0");
  const commitSha = readGitValue("git rev-parse --short HEAD", "unknown");
  const shaPatch = Number.parseInt(commitSha.slice(0, 1), 16);
  const stateLabel = readGitValue("git status --porcelain", "") ? "dirty" : "clean";
  const buildVersion = `${majorVersion}.${commitCount}.${Number.isFinite(shaPatch) ? shaPatch : 0}`;

  return {
    version,
    buildVersion,
    buildLabel: `v${buildVersion}, ${stateLabel}`,
    commitSha,
    commitCount,
    dirty: stateLabel === "dirty"
  };
}

function buildLlmQueryUserPrompt(question: string, meetings: LlmMeeting[]): string {
  const rows = meetings.map((meeting, index) => {
    const attendees = (meeting.attendees ?? []).map((attendee) => attendee.name).filter(Boolean).join(", ");
    const agendaTitles = (meeting.agenda ?? []).map((item) => item.title).filter(Boolean).join(", ");

    return `${index + 1}. 제목: ${meeting.title ?? "-"}, 일시: ${meeting.date ?? "-"} ${meeting.startTime ?? ""}-${meeting.endTime ?? ""}, 주관자: ${meeting.organizer || "-"}, 참석자: ${attendees || "-"}, Agenda: ${agendaTitles || "-"}, 회의록 작성 여부: ${meeting.minutes ? "작성됨" : "미작성"}`;
  });

  return buildQueryPrompt(question, rows);
}

// {name: label} for B5's presentation-summary prompt - organizer gets the literal "주관자" label,
// everyone else gets B1's computed 발표N/참석N badge (same rule the UI badges use). Attendee
// badges are assigned first and the organizer label last, on purpose: the organizer is often also
// listed as a regular attendee (isPresenter: false), and "주관자" must win that name over
// whatever 참석N badge the attendee loop would otherwise assign it.
function buildBadgeLabelsForMeeting(meeting: PresentationMeeting): Record<string, string> {
  const labels: Record<string, string> = {};

  const attendeeBadges = computeAttendeeBadgesForPrompt(meeting.attendees);
  for (const attendee of meeting.attendees ?? []) {
    if (attendee.name) {
      labels[attendee.name] = attendeeBadges[attendee.id];
    }
  }

  if (meeting.organizer) {
    labels[meeting.organizer] = "주관자";
  }

  return labels;
}

class PayloadTooLargeError extends Error {
  statusCode = 413;
}

function readRequestBody(request: IncomingMessage, maxBytes = MAX_SMALL_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let rejected = false;

    request.on("data", (chunk: Buffer) => {
      if (rejected) {
        return;
      }

      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        rejected = true;
        reject(new PayloadTooLargeError(`요청 본문은 ${Math.floor(maxBytes / ONE_MB)}MB 이하여야 합니다.`));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!rejected) {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    request.on("error", (error) => {
      if (!rejected) {
        reject(error);
      }
    });
  });
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload));
}

function sendCaughtError(response: ServerResponse, error: unknown, fallback: string) {
  const statusCode = error instanceof PayloadTooLargeError ? error.statusCode : 500;
  sendJson(response, statusCode, { error: error instanceof Error ? error.message : fallback });
}

// Only this app's own dev-server origin is expected to call these routes - see PhoneBook's
// identical guard for the reasoning (vite.config.mts registers routes ahead of Vite's own CORS
// middleware, so without this a normal browser tab could blind-POST here).
const TRUSTED_API_ORIGINS = new Set(["http://127.0.0.1:5185", "http://localhost:5185"]);

function isTrustedApiRequest(request: IncomingMessage) {
  const secFetchSite = request.headers["sec-fetch-site"];

  if (typeof secFetchSite === "string") {
    return secFetchSite === "same-origin" || secFetchSite === "none";
  }

  const origin = request.headers.origin;

  return !origin || TRUSTED_API_ORIGINS.has(origin);
}

function requireTrusted(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "GET" && !isTrustedApiRequest(request)) {
    sendJson(response, 403, { error: "Cross-origin request blocked." });
    return false;
  }

  return true;
}

function fileNavigatorShortcuts() {
  const home = homedir();

  return [
    { label: "바탕화면", path: path.join(home, "Desktop") },
    { label: "문서", path: path.join(home, "Documents") },
    { label: "다운로드", path: path.join(home, "Downloads") },
    { label: "프로젝트 폴더", path: process.cwd() }
  ];
}

async function listFileNavigatorDirectory(dirPath?: string) {
  const target = dirPath && dirPath.trim() ? path.resolve(dirPath.trim()) : path.join(homedir(), "Documents");
  const shortcuts = fileNavigatorShortcuts();

  try {
    const info = await stat(target);
    if (!info.isDirectory()) {
      throw new Error("폴더가 아닙니다.");
    }

    const rawEntries = await readdir(target, { withFileTypes: true });
    const entries = rawEntries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name, "ko");
      });
    const parent = path.dirname(target);

    return { path: target, parent: parent === target ? null : parent, entries, shortcuts };
  } catch (error) {
    return {
      path: target,
      parent: null,
      entries: [],
      shortcuts,
      error: error instanceof Error ? error.message : "폴더를 열지 못했습니다."
    };
  }
}

async function readFileNavigatorFile(filePath: string) {
  const resolvedPath = path.resolve(filePath);
  const info = await stat(resolvedPath);

  if (info.isDirectory()) {
    throw new Error("파일이 아니라 폴더입니다.");
  }
  if (info.size > MAX_FILE_NAVIGATOR_READ_BYTES) {
    throw new Error(`선택한 파일은 ${Math.floor(MAX_FILE_NAVIGATOR_READ_BYTES / ONE_MB)}MB 이하여야 합니다.`);
  }

  const buffer = await readFile(resolvedPath);
  return { contentBase64: buffer.toString("base64") };
}

type ImportFormat = "json" | "pdf" | "docx" | "pptx" | "md";
type ExportFormat = "json" | "pdf" | "docx" | "pptx" | "md";
const STT_MODEL_IDS_BY_PROVIDER: Record<string, Set<string>> = {
  mock: new Set(["mock"]),
  "local-whisper-cli": new Set(["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo", "turbo"]),
  "local-whisperx": new Set(["tiny", "base", "small", "medium", "large-v3"]),
  "openai-whisper": new Set(["whisper-1"]),
  "naver-clova": new Set(["default"])
};

const DEFAULT_STT_MODEL_BY_PROVIDER: Record<string, string> = {
  mock: "mock",
  "local-whisper-cli": "turbo",
  "local-whisperx": "base",
  "openai-whisper": "whisper-1",
  "naver-clova": "default"
};

function normalizeSttModel(provider: unknown, model: unknown) {
  const providerId = typeof provider === "string" ? provider : "mock";
  const allowedModels = STT_MODEL_IDS_BY_PROVIDER[providerId] ?? STT_MODEL_IDS_BY_PROVIDER.mock;
  return typeof model === "string" && allowedModels.has(model) ? model : DEFAULT_STT_MODEL_BY_PROVIDER[providerId] ?? "mock";
}

const IMPORT_PARSERS: Record<ImportFormat, (buffer: Buffer) => Promise<unknown[]> | unknown[]> = {
  json: (buffer) => parseJsonMeetings(buffer),
  pdf: (buffer) => parsePdfMeeting(buffer),
  docx: (buffer) => parseDocxMeeting(buffer),
  pptx: (buffer) => parsePptxMeeting(buffer),
  md: (buffer) => parseMdMeeting(buffer)
};

interface SttJob {
  status: "running" | "done" | "error" | "cancelled";
  progress: number; // 0-1
  createdAt: number;
  // Whether the displayed progress should fall back to the time-based estimate below - only
  // providers with no real per-segment signal (mock/openai-whisper/naver-clova) need that; for
  // local-whisper-cli/local-whisperx, progress must come from `progress` alone (see status
  // endpoint) so it never races ahead of `partialSegments`, which is what the transcript panel
  // actually shows - a gap between the two was confusing (progress bar further along than the
  // live transcript it's supposedly describing).
  hasRealProgressSignal: boolean;
  // Set by /api/stt/transcribe/cancel; abort() kills whatever child process is currently running
  // for this job (see the AbortController wired up in /api/stt/transcribe/start below). The flag
  // is checked separately in the catch block because a killed subprocess just looks like any other
  // failure from the outside - it's what tells "user cancelled" apart from "actually crashed".
  cancelRequested: boolean;
  abort: () => void;
  // Display floor for providers with no real incremental signal (mock/openai-whisper/naver-clova
  // are single blocking calls) - see estimateProcessingSeconds. Providers with a real signal
  // (local-whisper-cli/local-whisperx, parsed from their own stdout) report actual progress that
  // simply overtakes this estimate.
  estimatedTotalSec: number;
  // Segments parsed live from the local Whisper/WhisperX process's own stdout, before diarization
  // or dictionary substitution run - lets the client show a rough transcript while still running
  // instead of only after the whole job finishes. Empty for providers with no incremental signal
  // (mock/openai-whisper/naver-clova are single blocking calls).
  partialSegments: { startSec: number; endSec: number; text: string }[];
  result?: Record<string, unknown>;
  error?: string;
}

const sttJobs = new Map<string, SttJob>();
const STT_JOB_TTL_MS = 15 * 60 * 1000;

function pruneSttJobs() {
  const cutoff = Date.now() - STT_JOB_TTL_MS;
  for (const [id, job] of sttJobs) {
    if (job.createdAt < cutoff) {
      sttJobs.delete(id);
    }
  }
}

function estimateProcessingSeconds(provider: string, durationSec: number): number {
  if (provider === "mock") {
    return 1;
  }
  if (provider === "openai-whisper" || provider === "naver-clova") {
    return Math.max(4, durationSec * 0.35);
  }
  return Math.max(5, durationSec * 0.6);
}

const EXPORT_BUILDERS: Record<ExportFormat, { build: (meetings: unknown[]) => Promise<Buffer> | Buffer; fileName: string; mimeType: string }> = {
  json: {
    build: (meetings) => buildJsonExport(meetings),
    fileName: "meetingnote-export.json",
    mimeType: "application/json"
  },
  pdf: {
    build: (meetings) => buildPdfExport(meetings),
    fileName: "meetingnote-export.pdf",
    mimeType: "application/pdf"
  },
  docx: {
    build: (meetings) => buildDocxExport(meetings),
    fileName: "meetingnote-export.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  },
  pptx: {
    build: (meetings) => buildPptxExport(meetings),
    fileName: "meetingnote-export.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  },
  md: {
    build: (meetings) => buildMdExport(meetings),
    fileName: "meetingnote-export.md",
    mimeType: "text/markdown"
  }
};

export default defineConfig(() => {
  const settingsFilePath = path.resolve(process.cwd(), process.env.MEETINGNOTE_SETTINGS_FILE ?? "data/runtime/app-settings.json");
  const versionInfo = buildVersionInfo();

  return {
    define: {
      __MEETINGNOTE_VERSION__: JSON.stringify(versionInfo.version),
      __MEETINGNOTE_BUILD_VERSION__: JSON.stringify(versionInfo.buildVersion),
      __MEETINGNOTE_BUILD_LABEL__: JSON.stringify(versionInfo.buildLabel),
      __MEETINGNOTE_COMMIT_SHA__: JSON.stringify(versionInfo.commitSha),
      __MEETINGNOTE_COMMIT_COUNT__: JSON.stringify(versionInfo.commitCount),
      __MEETINGNOTE_GIT_DIRTY__: JSON.stringify(versionInfo.dirty)
    },
    plugins: [
      react(),
      {
        name: "meetingnote-api",
        configureServer(server) {
          server.middlewares.use("/api/meetings", async (request, response) => {
            try {
              if (!requireTrusted(request, response)) {
                return;
              }

              const url = new URL(request.url ?? "/", "http://127.0.0.1");
              const segments = url.pathname.split("/").filter(Boolean);
              const meetingId = segments[0] && segments[0] !== "bulk" && segments[0] !== "reset" ? segments[0] : null;
              const commentId = meetingId && segments[1] === "comments" ? (segments[2] ?? null) : null;

              if (request.method === "POST" && meetingId && segments[1] === "comments" && segments.length === 2) {
                const body = JSON.parse(await readRequestBody(request, MAX_SMALL_BODY_BYTES)) as { authorId?: string; content?: string };
                const updated = await addMeetingComment(meetingId, body);

                if (!updated) {
                  sendJson(response, 404, { error: "Meeting not found." });
                  return;
                }

                sendJson(response, 201, { meeting: updated });
                return;
              }

              if (request.method === "DELETE" && meetingId && commentId && segments.length === 3) {
                const updated = await deleteMeetingComment(meetingId, commentId);

                if (!updated) {
                  sendJson(response, 404, { error: "Meeting not found." });
                  return;
                }

                sendJson(response, 200, { meeting: updated });
                return;
              }

              if (request.method === "GET" && !meetingId) {
                sendJson(response, 200, { meetings: await readMeetings() });
                return;
              }

              if (request.method === "POST" && segments[0] === "bulk") {
                const body = JSON.parse(await readRequestBody(request, MAX_IMPORT_BODY_BYTES)) as { meetings?: unknown[]; duplicateMode?: string };
                const result = await bulkUpsertMeetings(Array.isArray(body.meetings) ? body.meetings : [], body.duplicateMode);
                sendJson(response, 200, result);
                return;
              }

              if (request.method === "POST" && segments[0] === "reset") {
                const meetings = await resetToSeed();
                sendJson(response, 200, { meetings });
                return;
              }

              if (request.method === "POST" && !meetingId) {
                const body = JSON.parse(await readRequestBody(request, MAX_SMALL_BODY_BYTES)) as Record<string, unknown>;
                const meeting = await createMeeting(body);
                sendJson(response, 201, { meeting });
                return;
              }

              if (request.method === "PUT" && meetingId && segments.length === 1) {
                const body = JSON.parse(await readRequestBody(request, MAX_SMALL_BODY_BYTES)) as Record<string, unknown>;
                const updated = await updateMeeting(meetingId, body);

                if (!updated) {
                  sendJson(response, 404, { error: "Meeting not found." });
                  return;
                }

                sendJson(response, 200, { meeting: updated });
                return;
              }

              if (request.method === "DELETE" && meetingId && segments.length === 1) {
                const deleted = await deleteMeeting(meetingId);
                sendJson(response, deleted ? 200 : 404, { ok: deleted });
                return;
              }

              sendJson(response, 405, { error: "Method not allowed." });
            } catch (error) {
              sendCaughtError(response, error, "Unknown error.");
            }
          });

          server.middlewares.use("/api/auth/login", async (request, response) => {
            try {
              if (request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed." });
                return;
              }

              const body = JSON.parse(await readRequestBody(request)) as { loginId?: string; password?: string };
              const result = await verifyLogin(String(body.loginId ?? ""), String(body.password ?? ""));

              sendJson(response, 200, result);
            } catch (error) {
              sendCaughtError(response, error, "로그인에 실패했습니다.");
            }
          });

          // Account management - client-side admin-only gating, same trust model as every other
          // route in this app (a local desktop tool with no server-side authorization layer).
          server.middlewares.use("/api/members", async (request, response) => {
            try {
              if (!requireTrusted(request, response)) {
                return;
              }

              const url = new URL(request.url ?? "/", "http://127.0.0.1");
              const memberId = url.pathname.split("/").filter(Boolean)[0] || null;

              if (request.method === "GET") {
                const members = await readMembers();
                sendJson(response, 200, { members: members.map(toPublicMember) });
                return;
              }

              if (request.method === "POST" && !memberId) {
                const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
                const members = await createMember(body);
                sendJson(response, 201, { members });
                return;
              }

              if (request.method === "PUT" && memberId) {
                const body = JSON.parse(await readRequestBody(request)) as Record<string, unknown>;
                const members = await updateMember(memberId, body);
                sendJson(response, 200, { members });
                return;
              }

              if (request.method === "DELETE" && memberId) {
                const members = await disableMember(memberId);
                sendJson(response, 200, { members });
                return;
              }

              sendJson(response, 405, { error: "Method not allowed." });
            } catch (error) {
              sendCaughtError(response, error, "계정 처리에 실패했습니다.");
            }
          });

          // Board - whole-array read/replace, ported directly from Club's boardStore.ts contract
          // (GET/PUT a raw BoardPost[], no per-post sub-routes). Delete/pin permission is enforced
          // client-side only, same trust model as every other route in this app.
          server.middlewares.use("/api/board", async (request, response) => {
            try {
              if (!requireTrusted(request, response)) {
                return;
              }

              if (request.method === "GET") {
                sendJson(response, 200, await readBoardPosts());
                return;
              }

              if (request.method === "PUT") {
                const body = JSON.parse((await readRequestBody(request, MAX_IMPORT_BODY_BYTES)) || "[]") as unknown[];
                const posts = await writeBoardPosts(body);
                sendJson(response, 200, posts);
                return;
              }

              sendJson(response, 405, { error: "Method not allowed." });
            } catch (error) {
              sendCaughtError(response, error, "게시판 처리에 실패했습니다.");
            }
          });

          // Abbreviation/correction dictionaries - same whole-object GET/PUT contract as
          // /api/board. /apply retroactively re-runs the current dictionary over every already-
          // analyzed meeting's transcript (new analyses apply it automatically - see the
          // /api/stt/transcribe/start handler above).
          server.middlewares.use("/api/dictionary", async (request, response) => {
            try {
              if (!requireTrusted(request, response)) {
                return;
              }

              const url = new URL(request.url ?? "/", "http://127.0.0.1");
              const segments = url.pathname.split("/").filter(Boolean);

              if (request.method === "GET" && segments.length === 0) {
                sendJson(response, 200, await readDictionary());
                return;
              }

              if (request.method === "PUT" && segments.length === 0) {
                const body = JSON.parse((await readRequestBody(request, MAX_IMPORT_BODY_BYTES)) || "{}") as Record<string, unknown>;
                const dictionary = await writeDictionary(body);
                sendJson(response, 200, dictionary);
                return;
              }

              if (request.method === "POST" && segments[0] === "apply") {
                const updatedCount = await applyDictionaryToAllMeetings();
                sendJson(response, 200, { updatedCount });
                return;
              }

              sendJson(response, 405, { error: "Method not allowed." });
            } catch (error) {
              sendCaughtError(response, error, "사전 처리에 실패했습니다.");
            }
          });

          // Registers/reinforces a voice profile - called right after the user renames a
          // "미등록" speaker to a real name in AudioAnalysisModal (see UNREGISTERED_SPEAKER_PREFIX
          // in server/audio/diarize.mjs), using that speaker's embedding from the just-completed
          // analysis. Confirmed matches during diarization itself register automatically server-
          // side (see assignSpeakersWithProfiles) - this route only covers the manual-rename case.
          server.middlewares.use("/api/voice-profiles/register", async (request, response) => {
            try {
              if (!requireTrusted(request, response) || request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed." });
                return;
              }

              const body = JSON.parse(await readRequestBody(request)) as { name?: string; embedding?: number[] };
              const name = typeof body.name === "string" ? body.name.trim() : "";
              const embedding = Array.isArray(body.embedding) ? body.embedding : [];

              if (!name || embedding.length === 0) {
                sendJson(response, 400, { error: "이름과 음성 임베딩이 필요합니다." });
                return;
              }

              await registerVoiceProfile(name, embedding);
              sendJson(response, 200, { ok: true });
            } catch (error) {
              sendCaughtError(response, error, "음성 프로필 등록에 실패했습니다.");
            }
          });

          // Serves files previously saved via POST /api/attachments so the browser fallback of
          // openAttachment() (used when window.meetingNote isn't available, e.g. running in a
          // plain browser tab) can view/download them. The Electron path instead opens the file
          // with the OS's own default app via shell.openPath - see electron/main.ts.
          server.middlewares.use("/attachments/", async (request, response) => {
            try {
              const requestUrl = request.url ?? "";
              const relativePath = decodeURIComponent(requestUrl.replace(/^\//, "").replace(/^attachments\//, ""));
              const filePath = await resolveAttachmentPath(relativePath);

              if (!existsSync(filePath)) {
                response.statusCode = 404;
                response.end();
                return;
              }

              const ext = path.extname(filePath).toLowerCase();
              response.setHeader("Content-Type", ATTACHMENT_CONTENT_TYPES[ext] ?? "application/octet-stream");
              response.setHeader("Content-Length", statSync(filePath).size);
              createReadStream(filePath).pipe(response);
            } catch {
              response.statusCode = 400;
              response.end();
            }
          });

          server.middlewares.use("/api/file-navigator", async (request, response) => {
            try {
              if (!isTrustedApiRequest(request)) {
                sendJson(response, 403, { error: "Cross-origin request blocked." });
                return;
              }

              if (request.method !== "GET" && request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed." });
                return;
              }

              const requestUrl = new URL(request.url ?? "/", "http://localhost");
              const pathname = requestUrl.pathname.replace(/^\/api\/file-navigator/, "");
              const action = pathname.split("/").filter(Boolean)[0];
              const requestedPath = requestUrl.searchParams.get("path") ?? undefined;

              if (action === "list") {
                sendJson(response, 200, await listFileNavigatorDirectory(requestedPath));
                return;
              }

              if (action === "read") {
                if (!requestedPath) {
                  sendJson(response, 400, { error: "파일 경로가 필요합니다." });
                  return;
                }
                sendJson(response, 200, await readFileNavigatorFile(requestedPath));
                return;
              }

              if (action === "to-project-relative") {
                if (!requestedPath) {
                  sendJson(response, 400, { error: "폴더 경로가 필요합니다." });
                  return;
                }

                try {
                  sendJson(response, 200, { path: toProjectRelativePath(path.resolve(requestedPath)) });
                } catch (error) {
                  sendJson(response, 200, { path: null, error: error instanceof Error ? error.message : "잘못된 폴더입니다." });
                }
                return;
              }

              if (action === "write") {
                if (request.method !== "POST") {
                  sendJson(response, 405, { error: "Method not allowed." });
                  return;
                }

                const body = JSON.parse(await readRequestBody(request, MAX_FILE_NAVIGATOR_WRITE_BODY_BYTES)) as {
                  path?: string;
                  contentBase64?: string;
                };
                const filePath = typeof body.path === "string" ? body.path : "";
                const contentBase64 = typeof body.contentBase64 === "string" ? body.contentBase64 : "";

                if (!filePath) {
                  sendJson(response, 400, { error: "파일 경로가 필요합니다." });
                  return;
                }

                const buffer = Buffer.from(contentBase64, "base64");
                if (buffer.length > MAX_EXPORT_BODY_BYTES) {
                  sendJson(response, 413, { error: `저장할 파일은 ${Math.floor(MAX_EXPORT_BODY_BYTES / ONE_MB)}MB 이하여야 합니다.` });
                  return;
                }

                await writeFile(path.resolve(filePath), buffer);
                sendJson(response, 200, { ok: true });
                return;
              }

              sendJson(response, 404, { error: "파일 탐색기 요청을 찾을 수 없습니다." });
            } catch (error) {
              sendCaughtError(response, error, "파일 탐색기 요청에 실패했습니다.");
            }
          });

          server.middlewares.use("/api/attachments", async (request, response) => {
            try {
              if (!requireTrusted(request, response) || request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed." });
                return;
              }

              const body = JSON.parse(await readRequestBody(request, MAX_ATTACHMENT_BYTES + ONE_MB)) as {
                meetingTitle?: string;
                kind?: string;
                fileName?: string;
                contentBase64?: string;
              };

              if (body.kind !== "materials" && body.kind !== "audio") {
                sendJson(response, 400, { error: "잘못된 첨부 종류입니다." });
                return;
              }

              const saved = await saveAttachment(body.meetingTitle ?? "", body.kind, body.fileName ?? "file", body.contentBase64 ?? "");
              sendJson(response, 201, { path: saved.path, mdPath: saved.mdPath, fileName: body.fileName ?? saved.path });
            } catch (error) {
              sendCaughtError(response, error, "첨부파일 저장에 실패했습니다.");
            }
          });

          server.middlewares.use("/api/logo", async (request, response) => {
            try {
              if (!requireTrusted(request, response) || request.method !== "PUT") {
                sendJson(response, 405, { error: "Method not allowed." });
                return;
              }

              const body = JSON.parse(await readRequestBody(request, MAX_SMALL_BODY_BYTES * 8)) as { photoDataUrl?: string };

              await saveLogoImage(body.photoDataUrl);
              sendJson(response, 200, { ok: true });
            } catch (error) {
              sendCaughtError(response, error, "로고 저장에 실패했습니다.");
            }
          });

          server.middlewares.use("/api/env", async (request, response) => {
            try {
              if (!requireTrusted(request, response)) {
                return;
              }

              if (request.method === "GET") {
                const env = (await readEnvFile()) as Record<string, string>;
                sendJson(response, 200, {
                  anthropicApiKeySet: Boolean(env.ANTHROPIC_API_KEY),
                  openaiApiKeySet: Boolean(env.OPENAI_API_KEY)
                });
                return;
              }

              if (request.method === "PUT") {
                const body = JSON.parse(await readRequestBody(request)) as {
                  anthropicApiKey?: string;
                  openaiApiKey?: string;
                  naverClovaInvokeUrl?: string;
                  naverClovaSecretKey?: string;
                  huggingFaceToken?: string;
                };
                const updates: Record<string, string> = {};

                if (typeof body.anthropicApiKey === "string" && body.anthropicApiKey.trim()) {
                  updates.ANTHROPIC_API_KEY = body.anthropicApiKey.trim();
                }
                if (typeof body.openaiApiKey === "string" && body.openaiApiKey.trim()) {
                  updates.OPENAI_API_KEY = body.openaiApiKey.trim();
                }
                if (typeof body.naverClovaInvokeUrl === "string" && body.naverClovaInvokeUrl.trim()) {
                  updates.NAVER_CLOVA_INVOKE_URL = body.naverClovaInvokeUrl.trim();
                }
                if (typeof body.naverClovaSecretKey === "string" && body.naverClovaSecretKey.trim()) {
                  updates.NAVER_CLOVA_SECRET_KEY = body.naverClovaSecretKey.trim();
                }
                if (typeof body.huggingFaceToken === "string" && body.huggingFaceToken.trim()) {
                  updates.HUGGINGFACE_TOKEN = body.huggingFaceToken.trim();
                }

                if (Object.keys(updates).length === 0) {
                  sendJson(response, 400, { error: "저장할 값을 입력해 주세요." });
                  return;
                }

                await writeEnvUpdates(updates);
                sendJson(response, 200, { ok: true });
                return;
              }

              if (request.method === "DELETE") {
                const body = JSON.parse((await readRequestBody(request)) || "{}") as { provider?: string };
                const keysByProvider: Record<string, string[]> = {
                  openai: ["OPENAI_API_KEY"],
                  anthropic: ["ANTHROPIC_API_KEY"],
                  "naver-clova": ["NAVER_CLOVA_INVOKE_URL", "NAVER_CLOVA_SECRET_KEY"],
                  huggingface: ["HUGGINGFACE_TOKEN"]
                };
                const keys = keysByProvider[body.provider ?? "anthropic"] ?? ["ANTHROPIC_API_KEY"];

                await writeEnvUpdates(Object.fromEntries(keys.map((key) => [key, ""])));
                sendJson(response, 200, { ok: true });
                return;
              }

              sendJson(response, 405, { error: "Method not allowed." });
            } catch (error) {
              sendCaughtError(response, error, "Unknown error.");
            }
          });

          server.middlewares.use("/api/llm/status", async (request, response) => {
            try {
              const url = new URL(request.url ?? "/", "http://127.0.0.1");
              const ollamaBaseUrl = url.searchParams.get("ollamaBaseUrl") || undefined;

              const [claudeCli, anthropicApiKeySet, ollama] = await Promise.all([
                checkClaudeCliAvailable(),
                checkAnthropicApiKeyConfigured(),
                ollamaBaseUrl ? checkOllamaAvailable(ollamaBaseUrl) : Promise.resolve({ available: false, models: [] })
              ]);

              sendJson(response, 200, { claudeCli, anthropicApiKeySet, ollama });
            } catch (error) {
              sendCaughtError(response, error, "Unknown error.");
            }
          });

          server.middlewares.use("/api/llm/query", async (request, response) => {
            try {
              if (!requireTrusted(request, response) || request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed." });
                return;
              }

              const body = JSON.parse(await readRequestBody(request, MAX_IMPORT_BODY_BYTES)) as {
                provider?: string;
                question?: string;
                meetings?: LlmMeeting[];
                ollamaBaseUrl?: string;
                ollamaModel?: string;
              };
              const question = (body.question ?? "").trim();

              if (!question) {
                sendJson(response, 400, { error: "질문을 입력해 주세요." });
                return;
              }

              const meetings = Array.isArray(body.meetings) ? body.meetings : [];
              const userPrompt = buildLlmQueryUserPrompt(question, meetings);

              let answer: string;
              if (body.provider === "claude-cli") {
                answer = await askClaudeCli(LLM_SYSTEM_PROMPT, userPrompt);
              } else if (body.provider === "anthropic-api") {
                answer = await askAnthropicApi(LLM_SYSTEM_PROMPT, userPrompt);
              } else if (body.provider === "ollama") {
                answer = await askOllama(LLM_SYSTEM_PROMPT, userPrompt, body.ollamaBaseUrl, body.ollamaModel);
              } else {
                sendJson(response, 400, { error: "지원하지 않는 LLM 제공자입니다." });
                return;
              }

              sendJson(response, 200, { answer });
            } catch (error) {
              sendCaughtError(response, error, "질문 처리에 실패했습니다.");
            }
          });

          server.middlewares.use("/api/llm/minutes", async (request, response) => {
            try {
              if (!requireTrusted(request, response) || request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed." });
                return;
              }

              const body = JSON.parse(await readRequestBody(request, MAX_IMPORT_BODY_BYTES)) as {
                provider?: string;
                meeting?: unknown;
                ollamaBaseUrl?: string;
                ollamaModel?: string;
              };

              if (!body.meeting) {
                sendJson(response, 400, { error: "회의 정보가 없습니다." });
                return;
              }

              const userPrompt = buildMinutesPrompt(body.meeting);

              let minutes: string;
              if (body.provider === "claude-cli") {
                minutes = await askClaudeCli(MINUTES_SYSTEM_PROMPT, userPrompt);
              } else if (body.provider === "anthropic-api") {
                minutes = await askAnthropicApi(MINUTES_SYSTEM_PROMPT, userPrompt);
              } else if (body.provider === "ollama") {
                minutes = await askOllama(MINUTES_SYSTEM_PROMPT, userPrompt, body.ollamaBaseUrl, body.ollamaModel);
              } else {
                sendJson(response, 200, {
                  minutes: "[로컬 검색 모드] 회의록 자동 작성은 Ollama, Claude CLI, Anthropic API 중 하나를 설정에서 선택하면 사용할 수 있습니다."
                });
                return;
              }

              sendJson(response, 200, { minutes });
            } catch (error) {
              sendCaughtError(response, error, "회의록 작성에 실패했습니다.");
            }
          });

          // B5 - per-Agenda-item structured summary. See PRESENTATION_SUMMARY_SYSTEM_PROMPT/
          // buildPresentationSummaryPrompt: the LLM is handed the whole meeting transcript and
          // finds the relevant stretch itself (confirmed design - this app has no per-agenda
          // timestamp data since each meeting has exactly one recording).
          server.middlewares.use("/api/llm/presentation-summary", async (request, response) => {
            try {
              if (!requireTrusted(request, response) || request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed." });
                return;
              }

              const body = JSON.parse(await readRequestBody(request, MAX_IMPORT_BODY_BYTES)) as {
                provider?: string;
                meeting?: PresentationMeeting;
                agendaNo?: number;
                ollamaBaseUrl?: string;
                ollamaModel?: string;
              };

              if (!body.meeting || typeof body.agendaNo !== "number") {
                sendJson(response, 400, { error: "회의/Agenda 정보가 없습니다." });
                return;
              }

              const agendaItem = (body.meeting.agenda ?? []).find((item) => item.no === body.agendaNo);
              if (!agendaItem) {
                sendJson(response, 404, { error: "해당 Agenda 항목을 찾을 수 없습니다." });
                return;
              }

              let materialMarkdown: string | null = null;
              if (agendaItem.materialMdPath) {
                try {
                  materialMarkdown = await readFile(await resolveAttachmentPath(agendaItem.materialMdPath), "utf8");
                } catch {
                  materialMarkdown = null;
                }
              }

              const badgeLabels = buildBadgeLabelsForMeeting(body.meeting);
              const userPrompt = buildPresentationSummaryPrompt(body.meeting, agendaItem, materialMarkdown, badgeLabels);

              let summary: string;
              if (body.provider === "claude-cli") {
                summary = await askClaudeCli(PRESENTATION_SUMMARY_SYSTEM_PROMPT, userPrompt);
              } else if (body.provider === "anthropic-api") {
                summary = await askAnthropicApi(PRESENTATION_SUMMARY_SYSTEM_PROMPT, userPrompt);
              } else if (body.provider === "ollama") {
                summary = await askOllama(PRESENTATION_SUMMARY_SYSTEM_PROMPT, userPrompt, body.ollamaBaseUrl, body.ollamaModel);
              } else {
                sendJson(response, 200, {
                  summary: "[로컬 검색 모드] 발표별 내용 정리는 Ollama, Claude CLI, Anthropic API 중 하나를 설정에서 선택하면 사용할 수 있습니다."
                });
                return;
              }

              sendJson(response, 200, { summary });
            } catch (error) {
              sendCaughtError(response, error, "발표 내용 정리에 실패했습니다.");
            }
          });

          server.middlewares.use("/api/stt/status", async (request, response) => {
            try {
              const [env, localWhisperCli, localWhisperX] = await Promise.all([
                readEnvFile() as Promise<Record<string, string>>,
                checkLocalWhisperAvailable(),
                checkLocalWhisperXAvailable()
              ]);

              sendJson(response, 200, {
                openaiApiKeySet: Boolean(env.OPENAI_API_KEY),
                naverClovaConfigured: Boolean(env.NAVER_CLOVA_INVOKE_URL && env.NAVER_CLOVA_SECRET_KEY),
                huggingFaceTokenSet: Boolean(env.HUGGINGFACE_TOKEN),
                localWhisperCli,
                localWhisperX
              });
            } catch (error) {
              sendCaughtError(response, error, "Unknown error.");
            }
          });

          // Transcription can take minutes for large local models, so it runs as a background job
          // (started here, polled via /api/stt/transcribe/status) instead of one blocking request -
          // that's what lets the client show live progress instead of a frozen button.
          server.middlewares.use("/api/stt/transcribe/start", async (request, response) => {
            try {
              if (!requireTrusted(request, response) || request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed." });
                return;
              }

              const body = JSON.parse(await readRequestBody(request, MAX_AUDIO_BODY_BYTES)) as {
                provider?: string;
                model?: string;
                audioBase64?: string;
                fileName?: string;
                durationSec?: number;
                preprocessing?: { vocalIsolation?: boolean; noiseRemoval?: boolean; normalize?: boolean };
                attendeeNames?: string[];
              };

              pruneSttJobs();

              const jobId = randomUUID();
              const fileName = body.fileName || "recording.wav";
              const provider = body.provider ?? "mock";
              const model = normalizeSttModel(provider, body.model);
              const attendeeNames = Array.isArray(body.attendeeNames) ? body.attendeeNames : [];
              const durationSec = typeof body.durationSec === "number" && body.durationSec > 0 ? body.durationSec : 0;
              const preprocessing = {
                vocalIsolation: Boolean(body.preprocessing?.vocalIsolation),
                noiseRemoval: Boolean(body.preprocessing?.noiseRemoval),
                normalize: Boolean(body.preprocessing?.normalize)
              };

              const abortController = new AbortController();
              const job: SttJob = {
                status: "running",
                progress: 0,
                createdAt: Date.now(),
                hasRealProgressSignal: provider === "local-whisper-cli" || provider === "local-whisperx",
                estimatedTotalSec: estimateProcessingSeconds(provider, durationSec),
                partialSegments: [],
                cancelRequested: false,
                abort: () => abortController.abort()
              };
              sttJobs.set(jobId, job);

              sendJson(response, 200, { jobId });

              void (async () => {
                try {
                  const onProgress = (fraction: number) => {
                    job.progress = Math.max(job.progress, Math.min(0.99, fraction));
                  };
                  const onSegment = (segment: { startSec: number; endSec: number; text: string }) => {
                    if (segment.text) {
                      job.partialSegments.push(segment);
                    }
                  };

                  let processedAudioBuffer: Buffer | null = null;
                  let raw: {
                    durationSec: number;
                    segments: { startSec: number; endSec: number; text: string; speaker?: string }[];
                    embeddings?: Record<string, number[]>;
                  };

                  // Fixed pipeline order Demucs -> 정규화 -> DeNoise, all server-side, so vocal
                  // isolation always sees the untouched original recording (best separation
                  // quality) and 정규화/DeNoise then run on whatever that step produced - see
                  // server/audio/audioPreprocess.mjs. The client no longer pre-processes audio
                  // before upload (see AudioAnalysisModal.tsx's handleAnalyze).
                  let audioBuffer = Buffer.from(body.audioBase64 ?? "", "base64");

                  if (provider !== "mock" && (preprocessing.vocalIsolation || preprocessing.normalize || preprocessing.noiseRemoval)) {
                    const preprocessed = await preprocessAudio(audioBuffer, fileName, preprocessing, abortController.signal);
                    audioBuffer = preprocessed.buffer;
                    if (preprocessed.changed) {
                      processedAudioBuffer = audioBuffer;
                    }
                  }

                  if (provider === "openai-whisper") {
                    raw = await transcribeWhisper(audioBuffer, fileName, model, abortController.signal);
                  } else if (provider === "local-whisper-cli") {
                    raw = (await transcribeLocalWhisperCli(
                      audioBuffer,
                      fileName,
                      model,
                      durationSec,
                      onProgress,
                      attendeeNames,
                      onSegment,
                      abortController.signal
                    )) as typeof raw;
                  } else if (provider === "local-whisperx") {
                    raw = (await transcribeLocalWhisperX(
                      audioBuffer,
                      fileName,
                      model,
                      durationSec,
                      onProgress,
                      attendeeNames,
                      onSegment,
                      abortController.signal
                    )) as typeof raw;
                  } else if (provider === "naver-clova") {
                    raw = await transcribeNaverClova(audioBuffer, fileName, attendeeNames, abortController.signal);
                  } else {
                    raw = await transcribeMock(fileName);
                  }

                  // Embedding-based voice-profile matching (B3) when the local WhisperX/Whisper-CLI
                  // paths produced embeddings (HF token configured); otherwise the existing
                  // positional-attendee-name fallback (Mock/Naver Clova/OpenAI Whisper API, or a
                  // local run without embeddings).
                  const hasEmbeddings = raw.embeddings && Object.keys(raw.embeddings).length > 0;
                  const { transcriptSegments, speakerMap } = hasEmbeddings
                    ? await assignSpeakersWithProfiles(raw.segments, attendeeNames, raw.embeddings)
                    : diarizeSegments(raw.segments, attendeeNames);

                  // Dictionary (약어/수정) substitution happens right after STT produces text, not
                  // during the audio decode/transcribe step itself - see server/dictionary.mjs.
                  const dictionary = await readDictionary();
                  const dictionaryAppliedSegments = applyDictionaryToSegments(transcriptSegments, dictionary.abbreviations, dictionary.corrections);

                  job.status = "done";
                  job.progress = 1;
                  job.result = {
                    fileName,
                    durationSec: raw.durationSec,
                    preprocessing,
                    transcriptSegments: dictionaryAppliedSegments,
                    speakerMap,
                    analyzedAt: new Date().toISOString(),
                    // Transient - not part of the persisted Meeting.audio shape (see domain.ts).
                    // AudioAnalysisModal uses this to register a voice profile the moment the user
                    // renames a "미등록" speaker to a real name, then strips it before saving.
                    ...(hasEmbeddings ? { speakerEmbeddings: raw.embeddings } : {}),
                    ...(processedAudioBuffer
                      ? {
                          processedAudioBase64: processedAudioBuffer.toString("base64"),
                          processedAudioMimeType: "audio/wav",
                          processedFileName: `${path.basename(fileName, path.extname(fileName)) || "recording"}-processed.wav`
                        }
                      : {})
                  };
                } catch (error) {
                  if (job.cancelRequested) {
                    job.status = "cancelled";
                    job.error = "사용자가 분석을 중지했습니다.";
                  } else {
                    job.status = "error";
                    job.error = error instanceof Error ? error.message : "음성 분석에 실패했습니다.";
                  }
                }
              })();
            } catch (error) {
              sendCaughtError(response, error, "음성 분석 시작에 실패했습니다.");
            }
          });

          server.middlewares.use("/api/stt/transcribe/cancel", async (request, response) => {
            try {
              if (!requireTrusted(request, response) || request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed." });
                return;
              }

              const body = JSON.parse(await readRequestBody(request, MAX_AUDIO_BODY_BYTES)) as { jobId?: string };
              const job = sttJobs.get(body.jobId ?? "");

              if (job && job.status === "running") {
                job.cancelRequested = true;
                job.abort();
              }

              sendJson(response, 200, { ok: true });
            } catch (error) {
              sendCaughtError(response, error, "음성 분석 중지에 실패했습니다.");
            }
          });

          server.middlewares.use("/api/stt/transcribe/status", async (request, response) => {
            try {
              if (!requireTrusted(request, response)) {
                return;
              }

              const url = new URL(request.url ?? "/", "http://127.0.0.1");
              const jobId = url.searchParams.get("jobId") ?? "";
              const job = sttJobs.get(jobId);

              if (!job) {
                sendJson(response, 404, { error: "작업을 찾을 수 없습니다." });
                return;
              }

              // Providers with a real per-segment signal must never show more progress than what
              // partialSegments actually backs, so the transcript panel and the progress bar/
              // waveform line always agree - no time-based estimate blended in for those.
              let displayProgress = job.progress;
              if (job.status === "running" && !job.hasRealProgressSignal) {
                const elapsedSec = (Date.now() - job.createdAt) / 1000;
                const estimatedProgress = job.estimatedTotalSec > 0 ? Math.min(0.92, elapsedSec / job.estimatedTotalSec) : 0;
                displayProgress = Math.max(job.progress, estimatedProgress);
              }

              sendJson(response, 200, {
                status: job.status,
                progress: displayProgress,
                partialSegments: job.status === "running" ? job.partialSegments : undefined,
                result: job.status === "done" ? job.result : undefined,
                error: job.status === "error" || job.status === "cancelled" ? job.error : undefined
              });

              if (job.status !== "running") {
                sttJobs.delete(jobId);
              }
            } catch (error) {
              sendCaughtError(response, error, "Unknown error.");
            }
          });

          server.middlewares.use("/api/import", async (request, response) => {
            try {
              if (!requireTrusted(request, response) || request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed." });
                return;
              }

              const body = JSON.parse(await readRequestBody(request, MAX_IMPORT_BODY_BYTES)) as { format?: string; contentBase64?: string };
              const parser = IMPORT_PARSERS[body.format as ImportFormat];

              if (!parser) {
                sendJson(response, 400, { error: "지원하지 않는 가져오기 형식입니다." });
                return;
              }

              const buffer = Buffer.from(body.contentBase64 ?? "", "base64");
              const meetings = await parser(buffer);
              sendJson(response, 200, { meetings });
            } catch (error) {
              sendCaughtError(response, error, "가져오기에 실패했습니다.");
            }
          });

          server.middlewares.use("/api/export", async (request, response) => {
            try {
              if (!requireTrusted(request, response) || request.method !== "POST") {
                sendJson(response, 405, { error: "Method not allowed." });
                return;
              }

              const body = JSON.parse(await readRequestBody(request, MAX_EXPORT_BODY_BYTES)) as { format?: string; meetings?: unknown[] };
              const builder = EXPORT_BUILDERS[body.format as ExportFormat];

              if (!builder) {
                sendJson(response, 400, { error: "지원하지 않는 내보내기 형식입니다." });
                return;
              }

              const meetings = Array.isArray(body.meetings) ? body.meetings : await readMeetings();
              const fileBuffer = await builder.build(meetings);

              sendJson(response, 200, {
                fileName: builder.fileName,
                mimeType: builder.mimeType,
                contentBase64: fileBuffer.toString("base64")
              });
            } catch (error) {
              sendCaughtError(response, error, "내보내기에 실패했습니다.");
            }
          });

          server.middlewares.use("/api/settings", async (request, response) => {
            try {
              if (!requireTrusted(request, response)) {
                return;
              }

              if (request.method === "GET") {
                const raw = await readFile(settingsFilePath, "utf8").catch(() => null);
                sendJson(response, 200, raw ? JSON.parse(raw) : null);
                return;
              }

              if (request.method === "PUT") {
                const body = await readRequestBody(request);
                await mkdir(path.dirname(settingsFilePath), { recursive: true });
                await writeFile(settingsFilePath, body, "utf8");
                sendJson(response, 200, { ok: true });
                return;
              }

              if (request.method === "DELETE") {
                await rm(settingsFilePath, { force: true });
                sendJson(response, 200, { ok: true });
                return;
              }

              sendJson(response, 405, { error: "Method not allowed." });
            } catch (error) {
              sendCaughtError(response, error, "Unknown error.");
            }
          });

          server.middlewares.use("/api/build-info", (request, response) => {
            if (!isTrustedApiRequest(request) || request.method !== "GET") {
              sendJson(response, 405, { error: "Method not allowed." });
              return;
            }

            sendJson(response, 200, buildVersionInfo());
          });
        }
      }
    ],
    publicDir: path.resolve(process.cwd(), "assets"),
    server: {
      host: "127.0.0.1",
      port: 5185,
      strictPort: true
    }
  };
});
