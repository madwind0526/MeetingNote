import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readMeetings, createMeeting, updateMeeting, deleteMeeting, bulkUpsertMeetings, resetToSeed } from "./server/db.mjs";
import { parseJsonMeetings } from "./server/parsers/importJson.mjs";
import { parsePdfMeeting } from "./server/parsers/importPdf.mjs";
import { parseDocxMeeting } from "./server/parsers/importDocx.mjs";
import { parsePptxMeeting } from "./server/parsers/importPptx.mjs";
import { buildJsonExport } from "./server/exporters/exportJson.mjs";
import { buildPdfExport } from "./server/exporters/exportPdf.mjs";
import { buildDocxExport } from "./server/exporters/exportDocx.mjs";
import { buildPptxExport } from "./server/exporters/exportPptx.mjs";
import { readEnvFile, writeEnvUpdates } from "./server/envFile.mjs";
import { saveLogoImage } from "./server/logo.mjs";
import { saveAttachment, resolveAttachmentPath, MAX_ATTACHMENT_BYTES } from "./server/attachments.mjs";
import {
  askAnthropicApi,
  askClaudeCli,
  askOllama,
  checkAnthropicApiKeyConfigured,
  checkClaudeCliAvailable,
  checkOllamaAvailable,
  buildMinutesPrompt,
  buildQueryPrompt
} from "./server/llm.mjs";
import { transcribeMock } from "./server/audio/sttMock.mjs";
import { transcribeWhisper } from "./server/audio/sttOpenAiWhisper.mjs";
import { checkLocalWhisperAvailable, transcribeLocalWhisperCli } from "./server/audio/sttLocalWhisperCli.mjs";
import { checkLocalWhisperXAvailable, transcribeLocalWhisperX } from "./server/audio/sttLocalWhisperX.mjs";
import { diarizeSegments } from "./server/audio/diarize.mjs";
import { isolateVocalsWithDemucs } from "./server/audio/vocalIsolation.mjs";

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

const LLM_SYSTEM_PROMPT = [
  "당신은 사용자의 회의록 저장소를 요약해서 답해주는 도우미입니다.",
  "사용자가 [회의 목록]으로 제공하는 정보만 근거로 삼아 질문에 한국어로 간결하게 답하세요.",
  "목록에 없는 내용은 추측해서 지어내지 말고, 모르면 모른다고 답하세요.",
  "이 요청은 소프트웨어 프로젝트나 코드와 무관하며, 오직 회의록 데이터에 대한 질문입니다."
].join(" ");

const MINUTES_SYSTEM_PROMPT = [
  "당신은 회의 진행자를 도와 회의록을 작성하는 도우미입니다.",
  "제공된 회의 기본정보, A/I List, Agenda, 화자별 발언 대본을 근거로 한국어 회의록을 Markdown으로 작성하세요.",
  "A/I List는 이번 회의가 시작되기 전에 이미 계획된 사전 액션 아이템이므로, 회의록 맨 앞부분에서 그대로 정리해 주세요.",
  "그다음 Agenda 순서대로 논의 내용을 요약하고 결정 사항을 정리하세요.",
  "안건 논의나 발언 대본 중에 A/I List에는 없던 새로운 후속 조치가 언급되면, 이를 A/I List와 절대 섞지 말고 별도의 \"회의 중 추가된 Action Item\" 섹션에 담당자와 함께 정리하세요.",
  "제공되지 않은 내용은 추측해서 지어내지 마세요.",
  "이 요청은 소프트웨어 프로젝트나 코드와 무관하며, 오직 회의록 작성 작업입니다."
].join(" ");

const ONE_MB = 1024 * 1024;
const MAX_SMALL_BODY_BYTES = ONE_MB;
const MAX_IMPORT_BODY_BYTES = 120 * ONE_MB;
const MAX_EXPORT_BODY_BYTES = 40 * ONE_MB;
const MAX_AUDIO_BODY_BYTES = 260 * ONE_MB;

const ATTACHMENT_CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".txt": "text/plain; charset=utf-8",
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

type ImportFormat = "json" | "pdf" | "docx" | "pptx";
type ExportFormat = "json" | "pdf" | "docx" | "pptx";
const STT_MODEL_IDS_BY_PROVIDER: Record<string, Set<string>> = {
  mock: new Set(["mock"]),
  "local-whisper-cli": new Set(["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo", "turbo"]),
  "local-whisperx": new Set(["tiny", "base", "small", "medium", "large-v3"]),
  "openai-whisper": new Set(["whisper-1"])
};

const DEFAULT_STT_MODEL_BY_PROVIDER: Record<string, string> = {
  mock: "mock",
  "local-whisper-cli": "turbo",
  "local-whisperx": "base",
  "openai-whisper": "whisper-1"
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
  pptx: (buffer) => parsePptxMeeting(buffer)
};

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

              if (request.method === "PUT" && meetingId) {
                const body = JSON.parse(await readRequestBody(request, MAX_SMALL_BODY_BYTES)) as Record<string, unknown>;
                const updated = await updateMeeting(meetingId, body);

                if (!updated) {
                  sendJson(response, 404, { error: "Meeting not found." });
                  return;
                }

                sendJson(response, 200, { meeting: updated });
                return;
              }

              if (request.method === "DELETE" && meetingId) {
                const deleted = await deleteMeeting(meetingId);
                sendJson(response, deleted ? 200 : 404, { ok: deleted });
                return;
              }

              sendJson(response, 405, { error: "Method not allowed." });
            } catch (error) {
              sendCaughtError(response, error, "Unknown error.");
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

              const savedPath = await saveAttachment(body.meetingTitle ?? "", body.kind, body.fileName ?? "file", body.contentBase64 ?? "");
              sendJson(response, 201, { path: savedPath, fileName: body.fileName ?? savedPath });
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
                const body = JSON.parse(await readRequestBody(request)) as { anthropicApiKey?: string; openaiApiKey?: string };
                const updates: Record<string, string> = {};

                if (typeof body.anthropicApiKey === "string" && body.anthropicApiKey.trim()) {
                  updates.ANTHROPIC_API_KEY = body.anthropicApiKey.trim();
                }
                if (typeof body.openaiApiKey === "string" && body.openaiApiKey.trim()) {
                  updates.OPENAI_API_KEY = body.openaiApiKey.trim();
                }

                if (Object.keys(updates).length === 0) {
                  sendJson(response, 400, { error: "저장할 API 키를 입력해 주세요." });
                  return;
                }

                await writeEnvUpdates(updates);
                sendJson(response, 200, { ok: true });
                return;
              }

              if (request.method === "DELETE") {
                const body = JSON.parse((await readRequestBody(request)) || "{}") as { provider?: string };
                const key = body.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";

                await writeEnvUpdates({ [key]: "" });
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

          server.middlewares.use("/api/stt/status", async (request, response) => {
            try {
              const [env, localWhisperCli, localWhisperX] = await Promise.all([
                readEnvFile() as Promise<Record<string, string>>,
                checkLocalWhisperAvailable(),
                checkLocalWhisperXAvailable()
              ]);

              sendJson(response, 200, { openaiApiKeySet: Boolean(env.OPENAI_API_KEY), localWhisperCli, localWhisperX });
            } catch (error) {
              sendCaughtError(response, error, "Unknown error.");
            }
          });

          server.middlewares.use("/api/stt/transcribe", async (request, response) => {
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
                preprocessing?: { vocalIsolation?: boolean; noiseRemoval?: boolean; normalize?: boolean };
                attendeeNames?: string[];
              };

              const fileName = body.fileName || "recording.wav";
              const model = normalizeSttModel(body.provider, body.model);
              const attendeeNames = Array.isArray(body.attendeeNames) ? body.attendeeNames : [];
              const preprocessing = {
                vocalIsolation: Boolean(body.preprocessing?.vocalIsolation),
                noiseRemoval: Boolean(body.preprocessing?.noiseRemoval),
                normalize: Boolean(body.preprocessing?.normalize)
              };

              let processedAudioBuffer: Buffer | null = null;
              let raw: { durationSec: number; segments: { startSec: number; endSec: number; text: string }[] };
              if (body.provider === "openai-whisper") {
                let audioBuffer = Buffer.from(body.audioBase64 ?? "", "base64");
                if (preprocessing.vocalIsolation) {
                  audioBuffer = await isolateVocalsWithDemucs(audioBuffer, fileName);
                  processedAudioBuffer = audioBuffer;
                }
                raw = await transcribeWhisper(audioBuffer, fileName, model);
              } else if (body.provider === "local-whisper-cli") {
                let audioBuffer = Buffer.from(body.audioBase64 ?? "", "base64");
                if (preprocessing.vocalIsolation) {
                  audioBuffer = await isolateVocalsWithDemucs(audioBuffer, fileName);
                  processedAudioBuffer = audioBuffer;
                }
                raw = await transcribeLocalWhisperCli(audioBuffer, fileName, model);
              } else if (body.provider === "local-whisperx") {
                let audioBuffer = Buffer.from(body.audioBase64 ?? "", "base64");
                if (preprocessing.vocalIsolation) {
                  audioBuffer = await isolateVocalsWithDemucs(audioBuffer, fileName);
                  processedAudioBuffer = audioBuffer;
                }
                raw = await transcribeLocalWhisperX(audioBuffer, fileName, model);
              } else {
                raw = await transcribeMock(fileName);
              }

              const { transcriptSegments, speakerMap } = diarizeSegments(raw.segments, attendeeNames);

              sendJson(response, 200, {
                fileName,
                durationSec: raw.durationSec,
                preprocessing,
                transcriptSegments,
                speakerMap,
                analyzedAt: new Date().toISOString(),
                ...(processedAudioBuffer
                  ? {
                      processedAudioBase64: processedAudioBuffer.toString("base64"),
                      processedAudioMimeType: "audio/wav",
                      processedFileName: `${path.basename(fileName, path.extname(fileName)) || "recording"}-vocals.wav`
                    }
                  : {})
              });
            } catch (error) {
              sendCaughtError(response, error, "음성 분석에 실패했습니다.");
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
