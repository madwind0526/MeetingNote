import type {
  AudioAnalysis,
  AudioPreprocessing,
  ExportFormat,
  ImportDuplicateMode,
  ImportFormat,
  Meeting,
  MeetingDraft
} from "../types/domain";

const MAX_IMPORT_FILE_BYTES = 80 * 1024 * 1024;
const MAX_AUDIO_FILE_BYTES = 200 * 1024 * 1024;

export interface ImportSummary {
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  total: number;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;

  if (!response.ok) {
    throw new Error(payload?.error || `요청이 실패했습니다 (${response.status}).`);
  }

  return payload as T;
}

export async function saveLogoImage(photoDataUrl: string): Promise<void> {
  const response = await fetch("/api/logo", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photoDataUrl })
  });
  await parseJsonResponse<{ ok: boolean }>(response);
}

export async function fetchMeetings(): Promise<Meeting[]> {
  const response = await fetch("/api/meetings");
  const payload = await parseJsonResponse<{ meetings: Meeting[] }>(response);

  return payload.meetings;
}

// `presetId` lets MeetingFormModal keep the same client-generated id it already used while
// uploading attachments during this create session (see cloneDraft's folderId), so the meeting
// record ends up owning the exact folder those files were already copied into.
export async function createMeetingRequest(draft: MeetingDraft, presetId?: string): Promise<Meeting> {
  const response = await fetch("/api/meetings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(presetId ? { ...draft, id: presetId } : draft)
  });
  const payload = await parseJsonResponse<{ meeting: Meeting }>(response);

  return payload.meeting;
}

export async function updateMeetingRequest(id: string, draft: MeetingDraft): Promise<Meeting> {
  const response = await fetch(`/api/meetings/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft)
  });
  const payload = await parseJsonResponse<{ meeting: Meeting }>(response);

  return payload.meeting;
}

export async function deleteMeetingRequest(id: string): Promise<void> {
  const response = await fetch(`/api/meetings/${id}`, { method: "DELETE" });
  await parseJsonResponse<{ ok: boolean }>(response);
}

export async function bulkUpsertMeetingsRequest(
  meetings: MeetingDraft[],
  duplicateMode: ImportDuplicateMode
): Promise<ImportSummary> {
  const response = await fetch("/api/meetings/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meetings, duplicateMode })
  });

  return parseJsonResponse(response);
}

export async function resetMeetingsRequest(): Promise<Meeting[]> {
  const response = await fetch("/api/meetings/reset", { method: "POST" });
  const payload = await parseJsonResponse<{ meetings: Meeting[] }>(response);

  return payload.meetings;
}

function assertFileSize(file: File, maxBytes: number, label: string) {
  if (file.size > maxBytes) {
    throw new Error(`${label} 파일은 ${Math.floor(maxBytes / 1024 / 1024)}MB 이하여야 합니다.`);
  }
}

function readFileAsBase64(file: File | Blob, maxBytes: number, label: string): Promise<string> {
  if (file instanceof File) {
    assertFileSize(file, maxBytes, label);
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.split(",")[1] ?? "");
    };
    reader.onerror = () => reject(reader.error ?? new Error("파일을 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
}

export function readFileAsDataUrl(file: File, maxBytes = 5 * 1024 * 1024): Promise<string> {
  assertFileSize(file, maxBytes, "이미지");

  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("파일을 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
}

const MAX_ATTACHMENT_FILE_BYTES = 50 * 1024 * 1024;

export interface UploadedAttachment {
  path: string;
  fileName: string;
}

// Uploads a material or meeting audio file into
// <configured attachments folder>/<meeting folder label>/<kind>/ and returns the stored relative
// path alongside the original file name. Existing uploads stay at their saved path if the meeting
// date or title changes later.
export async function uploadAttachment(meetingFolderLabel: string, kind: "materials" | "audio", file: File): Promise<UploadedAttachment> {
  const contentBase64 = await readFileAsBase64(file, MAX_ATTACHMENT_FILE_BYTES, "첨부");
  const response = await fetch("/api/attachments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meetingTitle: meetingFolderLabel, kind, fileName: file.name, contentBase64 })
  });

  return parseJsonResponse<UploadedAttachment>(response);
}

// Opens a stored attachment for reading. Inside Electron this opens the file with the OS's own
// default application (Word, PDF viewer, ...) via shell.openPath; in a plain browser tab (no
// window.meetingNote bridge) it falls back to navigating to the /attachments static route, which
// the browser will preview (PDF/images) or download depending on the file type.
export async function openAttachment(relativePath: string): Promise<void> {
  if (window.meetingNote?.openAttachment) {
    const errorMessage = await window.meetingNote.openAttachment(relativePath);
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    return;
  }

  window.open(`/attachments/${relativePath.split("/").map(encodeURIComponent).join("/")}`, "_blank");
}

// Opens the native "select a folder" dialog (Electron only) for Settings' storage-folder picker. The
// returned path is always relative to the project root (C:\Claude\MeetingNote) - the main process
// rejects any folder outside that tree and this throws with its Korean error message in that
// case. Returns null both when running outside Electron and when the user cancels the dialog.
export async function pickAttachmentsFolder(): Promise<string | null> {
  if (!window.meetingNote?.openFolderDialog) {
    return null;
  }

  const result = await window.meetingNote.openFolderDialog();

  if (result.error) {
    throw new Error(result.error);
  }

  return result.path;
}

const IMPORT_EXTENSION_FORMATS: Record<string, ImportFormat> = {
  pdf: "pdf",
  docx: "docx",
  pptx: "pptx",
  md: "md",
  markdown: "md",
  json: "json"
};

export function inferImportFormat(fileName: string): ImportFormat | null {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  return IMPORT_EXTENSION_FORMATS[extension] ?? null;
}

export async function importMeetingsRequest(format: ImportFormat, file: File): Promise<MeetingDraft[]> {
  const contentBase64 = await readFileAsBase64(file, MAX_IMPORT_FILE_BYTES, "가져오기");
  const response = await fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format, contentBase64 })
  });
  const payload = await parseJsonResponse<{ meetings: MeetingDraft[] }>(response);

  return payload.meetings;
}

export interface ExportResult {
  fileName: string;
  mimeType: string;
  contentBase64: string;
}

export async function exportMeetingsRequest(format: ExportFormat, meetings: Meeting[]): Promise<ExportResult> {
  const response = await fetch("/api/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ format, meetings })
  });

  return parseJsonResponse<ExportResult>(response);
}

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);

  for (let index = 0; index < byteChars.length; index += 1) {
    byteNumbers[index] = byteChars.charCodeAt(index);
  }

  return new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
}

export async function saveExportedFile(result: ExportResult): Promise<string> {
  if (window.meetingNote?.saveFileDialog) {
    const filePath = await window.meetingNote.saveFileDialog({ defaultPath: result.fileName });

    if (!filePath) {
      return "";
    }

    await window.meetingNote.writeFile(filePath, result.contentBase64);
    return filePath;
  }

  const blob = base64ToBlob(result.contentBase64, result.mimeType);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = result.fileName;
  anchor.click();
  URL.revokeObjectURL(url);

  return result.fileName;
}

export interface TranscribeRequest {
  provider: "mock" | "local-whisper-cli" | "local-whisperx" | "openai-whisper" | "naver-clova";
  model?: string;
  audioBlob: Blob;
  fileName: string;
  durationSec: number;
  preprocessing: AudioPreprocessing;
  // Attendee names (presenters/key attendees first). Only used when the STT provider itself
  // returns real per-segment speaker labels (currently none do by default) - see
  // server/audio/diarize.mjs; otherwise every segment is treated as a single speaker.
  attendeeNames: string[];
  // Polled roughly every 700ms with a 0-100 percentage while the job is running - see
  // /api/stt/transcribe/status. Local providers report real progress parsed from their own
  // process output; cloud/mock providers get a smooth time-based estimate instead, since a single
  // blocking API call has no real sub-progress to report.
  onProgress?: (percent: number) => void;
}

export type TranscribeResult = AudioAnalysis & {
  processedAudioBase64?: string;
  processedAudioMimeType?: string;
  processedFileName?: string;
};

interface SttJobStatus {
  status: "running" | "done" | "error";
  progress: number;
  result?: TranscribeResult;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function transcribeAudioRequest(request: TranscribeRequest): Promise<TranscribeResult> {
  const audioBase64 = await readFileAsBase64(request.audioBlob, MAX_AUDIO_FILE_BYTES, "오디오");
  const startResponse = await fetch("/api/stt/transcribe/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: request.provider,
      model: request.model,
      audioBase64,
      fileName: request.fileName,
      durationSec: request.durationSec,
      preprocessing: request.preprocessing,
      attendeeNames: request.attendeeNames
    })
  });
  const { jobId } = await parseJsonResponse<{ jobId: string }>(startResponse);

  for (;;) {
    await sleep(700);
    const statusResponse = await fetch(`/api/stt/transcribe/status?jobId=${encodeURIComponent(jobId)}`);
    const job = await parseJsonResponse<SttJobStatus>(statusResponse);

    request.onProgress?.(Math.round(job.progress * 100));

    if (job.status === "done" && job.result) {
      return job.result;
    }
    if (job.status === "error") {
      throw new Error(job.error || "음성 분석에 실패했습니다.");
    }
  }
}
