import { useEffect, useRef, useState } from "react";
import { Bot, FileInput, FileText, FolderOpen, Mic, Paperclip, Plus, Square, Trash2, Upload } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { AudioAnalysisModal } from "./AudioAnalysisModal";
import { PresentationSummaryModal } from "./PresentationSummaryModal";
import { LiveWaveform } from "../LiveWaveform";
import type {
  ActionItem,
  AgendaItem,
  Attendee,
  AudioAnalysis,
  LlmProviderId,
  Meeting,
  MeetingDraft,
  SttProviderId
} from "../../types/domain";
import {
  computeAttendeeBadges,
  computeMeetingStatus,
  emptyActionItem,
  emptyAgendaItem,
  emptyAttendee,
  emptyMeetingDraft,
  meetingStatusLabels
} from "../../types/domain";
import { generateMinutes } from "../../lib/llm";
import type { OllamaConfig } from "../../lib/llm";
import { importMeetingsRequest, inferImportFormat, openAttachment, transcribeAudioRequest, uploadAttachment } from "../../lib/api";
import { pickFileWithNavigator, shouldUseBuiltinFilePicker } from "../../lib/filePicker";
import { decodeAudioFile, encodeWav, mixDownToMono } from "../../lib/audio";
import { isSystemAudioCaptureSupported, startSystemAudioRecording } from "../../lib/systemAudioCapture";
import type { SystemAudioRecording } from "../../lib/systemAudioCapture";

type MaterialTarget = { kind: "actionItem" | "agenda"; index: number };

interface MeetingFormModalProps {
  mode: "create" | "edit";
  initial?: Meeting;
  llmProvider: LlmProviderId;
  ollamaConfig: OllamaConfig;
  sttProvider: SttProviderId;
  onClose: () => void;
  // `presetId` is only passed when `mode === "create"` - see `folderId` below.
  onSubmit: (draft: MeetingDraft, presetId?: string) => Promise<void> | void;
}

// Deep-clones the array fields so edits never mutate `initial` or the shared `emptyMeetingDraft` const.
function cloneDraft(initial?: Meeting): MeetingDraft {
  if (!initial) {
    return {
      ...emptyMeetingDraft,
      attendees: [],
      actionItems: [],
      agenda: []
    };
  }

  return {
    title: initial.title,
    date: initial.date,
    startTime: initial.startTime,
    endTime: initial.endTime,
    organizer: initial.organizer,
    secretary: initial.secretary,
    attendees: initial.attendees.map((attendee) => ({ ...attendee })),
    actionItems: initial.actionItems.map((item) => ({ ...item })),
    agenda: initial.agenda.map((item) => ({ ...item })),
    audio: initial.audio
      ? {
          ...initial.audio,
          preprocessing: {
            vocalIsolation: initial.audio.preprocessing.vocalIsolation ?? false,
            noiseRemoval: initial.audio.preprocessing.noiseRemoval,
            normalize: initial.audio.preprocessing.normalize
          },
          transcriptSegments: initial.audio.transcriptSegments.map((segment) => ({ ...segment })),
          speakerMap: { ...initial.audio.speakerMap }
        }
      : null,
    minutes: initial.minutes
  };
}

function renumber<T extends { no: number }>(items: T[]): T[] {
  return items.map((item, index) => ({ ...item, no: index + 1 }));
}

function attachmentFolderLabel(draft: MeetingDraft) {
  const date = draft.date.trim() || "no-date";
  const title = draft.title.trim() || "제목 없음";

  return `${date}-${title}`;
}

export function MeetingFormModal({ mode, initial, llmProvider, ollamaConfig, sttProvider, onClose, onSubmit }: MeetingFormModalProps) {
  const [draft, setDraft] = useState<MeetingDraft>(() => cloneDraft(initial));
  const [pendingAudioFile, setPendingAudioFile] = useState<File | null>(null);
  const [showAudioAnalysis, setShowAudioAnalysis] = useState(false);
  const [isGeneratingMinutes, setIsGeneratingMinutes] = useState(false);
  const [minutesError, setMinutesError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [isImportingFile, setIsImportingFile] = useState(false);
  const [importFileError, setImportFileError] = useState("");
  // ---------- PC 소리 녹음 (system audio) ----------
  const [isSystemRecording, setIsSystemRecording] = useState(false);
  const [recordingElapsedSec, setRecordingElapsedSec] = useState(0);
  const [liveCaptionLines, setLiveCaptionLines] = useState<string[]>([]);
  const [systemRecordingError, setSystemRecordingError] = useState("");
  const systemRecordingRef = useRef<SystemAudioRecording | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveCaptionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const liveCaptionChunksRef = useRef<Blob[]>([]);
  const liveCaptionBusyRef = useRef(false);
  const audioFileInputRef = useRef<HTMLInputElement | null>(null);
  const materialFileInputRef = useRef<HTMLInputElement | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const [materialAttachTarget, setMaterialAttachTarget] = useState<MaterialTarget | null>(null);
  const [isUploadingMaterial, setIsUploadingMaterial] = useState(false);
  const [materialError, setMaterialError] = useState("");
  // B5 - holds the Agenda item's `no` while its PresentationSummaryModal is open.
  const [summaryTargetNo, setSummaryTargetNo] = useState<number | null>(null);
  // Generated up front for create mode (once, via lazy useState init) so a brand-new meeting
  // already has an id to submit as `presetId` on first save - keeps this meeting's id consistent
  // with whatever App.tsx/db.mjs end up persisting, in case something elsewhere ever needs to
  // reference it before the first save completes.
  const [folderId] = useState(() => initial?.id ?? crypto.randomUUID());

  const status = computeMeetingStatus(draft);

  const updateField = <Key extends keyof MeetingDraft>(key: Key, value: MeetingDraft[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  // ---------- Import from file (create mode only) ----------

  const processImportFile = async (file: File) => {
    const format = inferImportFormat(file.name);
    if (!format) {
      setImportFileError("지원하지 않는 파일 형식입니다. (PDF, Word, PowerPoint, Markdown, JSON)");
      return;
    }

    setIsImportingFile(true);
    setImportFileError("");

    try {
      const parsed = await importMeetingsRequest(format, file);
      const [parsedDraft] = parsed;

      if (!parsedDraft) {
        setImportFileError("파일에서 회의록 내용을 찾지 못했습니다.");
        return;
      }

      setDraft((current) => ({
        ...current,
        title: parsedDraft.title,
        date: parsedDraft.date,
        startTime: parsedDraft.startTime,
        endTime: parsedDraft.endTime,
        organizer: parsedDraft.organizer,
        attendees: parsedDraft.attendees,
        actionItems: parsedDraft.actionItems,
        agenda: parsedDraft.agenda,
        minutes: parsedDraft.minutes
      }));

      if (parsed.length > 1) {
        setImportFileError("여러 회의록이 발견되어 첫 번째 항목만 불러왔습니다.");
      }
    } catch (error) {
      setImportFileError(error instanceof Error ? error.message : "가져오기에 실패했습니다.");
    } finally {
      setIsImportingFile(false);
    }
  };

  const handleImportFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";

    if (file) {
      await processImportFile(file);
    }
  };

  const triggerImportFilePick = async () => {
    if (shouldUseBuiltinFilePicker()) {
      const file = await pickFileWithNavigator([".pdf", ".docx", ".pptx", ".md", ".markdown", ".json"], "회의록 파일 선택");
      if (file) {
        await processImportFile(file);
      }
      return;
    }

    importFileInputRef.current?.click();
  };

  // ---------- Attendees ----------

  const updateAttendee = (index: number, patch: Partial<Attendee>) => {
    setDraft((current) => ({
      ...current,
      attendees: current.attendees.map((attendee, i) => (i === index ? { ...attendee, ...patch } : attendee))
    }));
  };

  const addAttendee = () => {
    setDraft((current) => ({ ...current, attendees: [...current.attendees, emptyAttendee()] }));
  };

  const removeAttendee = (index: number) => {
    setDraft((current) => ({ ...current, attendees: current.attendees.filter((_, i) => i !== index) }));
  };

  // ---------- A/I list ----------

  const updateActionItem = (index: number, patch: Partial<ActionItem>) => {
    setDraft((current) => ({
      ...current,
      actionItems: current.actionItems.map((item, i) => (i === index ? { ...item, ...patch } : item))
    }));
  };

  const addActionItem = () => {
    setDraft((current) => ({
      ...current,
      actionItems: renumber([...current.actionItems, emptyActionItem(current.actionItems.length + 1)])
    }));
  };

  const removeActionItem = (index: number) => {
    setDraft((current) => ({
      ...current,
      actionItems: renumber(current.actionItems.filter((_, i) => i !== index))
    }));
  };

  // ---------- Agenda ----------

  const updateAgendaItem = (index: number, patch: Partial<AgendaItem>) => {
    setDraft((current) => ({
      ...current,
      agenda: current.agenda.map((item, i) => (i === index ? { ...item, ...patch } : item))
    }));
  };

  const addAgendaItem = () => {
    setDraft((current) => ({
      ...current,
      agenda: renumber([...current.agenda, emptyAgendaItem(current.agenda.length + 1)])
    }));
  };

  const removeAgendaItem = (index: number) => {
    setDraft((current) => ({
      ...current,
      agenda: renumber(current.agenda.filter((_, i) => i !== index))
    }));
  };

  // ---------- A/I List & Agenda material attachments ----------

  const processMaterialFile = async (file: File, target: MaterialTarget) => {
    setIsUploadingMaterial(true);
    setMaterialError("");

    try {
      const uploaded = await uploadAttachment(attachmentFolderLabel(draft), "materials", file);

      if (target.kind === "actionItem") {
        updateActionItem(target.index, { material: uploaded.fileName, materialPath: uploaded.path, materialMdPath: uploaded.mdPath });
      } else {
        updateAgendaItem(target.index, { material: uploaded.fileName, materialPath: uploaded.path, materialMdPath: uploaded.mdPath });
      }
    } catch (error) {
      setMaterialError(error instanceof Error ? error.message : "첨부파일 업로드에 실패했습니다.");
    } finally {
      setIsUploadingMaterial(false);
    }
  };

  const handleAttachMaterialClick = async (target: MaterialTarget) => {
    if (shouldUseBuiltinFilePicker()) {
      const file = await pickFileWithNavigator(undefined, "첨부할 자료 파일 선택");
      if (file) {
        await processMaterialFile(file, target);
      }
      return;
    }

    setMaterialAttachTarget(target);
    materialFileInputRef.current?.click();
  };

  const handleMaterialFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    const target = materialAttachTarget;
    event.target.value = "";
    setMaterialAttachTarget(null);

    if (file && target) {
      await processMaterialFile(file, target);
    }
  };

  const handleOpenMaterial = async (materialPath: string) => {
    setMaterialError("");

    try {
      await openAttachment(materialPath);
    } catch (error) {
      setMaterialError(error instanceof Error ? error.message : "첨부파일을 여는 데 실패했습니다.");
    }
  };

  // ---------- Audio ----------

  const handleAudioFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    setPendingAudioFile(file);
  };

  const triggerAudioFilePick = async () => {
    if (shouldUseBuiltinFilePicker()) {
      const file = await pickFileWithNavigator(undefined, "회의 음성 파일 선택");
      if (file) {
        setPendingAudioFile(file);
      }
      return;
    }

    audioFileInputRef.current?.click();
  };

  // 스피커로 나오는 소리(PC 시스템 오디오)를 실시간으로 녹음하는 것과, 지금까지의 파일 업로드는 서로
  // 다른 입력 경로일 뿐 - 녹음이 끝나면 setPendingAudioFile로 합류시켜서, 그 뒤(다시 분석/분석 시작,
  // 첨부파일 업로드, 회의록 저장)는 파일을 직접 선택했을 때와 완전히 동일한 경로를 그대로 탄다.
  const LIVE_CAPTION_WINDOW_MS = 12000;

  const runLiveCaptionWindow = async () => {
    if (liveCaptionBusyRef.current || liveCaptionChunksRef.current.length === 0) {
      return;
    }

    const chunks = liveCaptionChunksRef.current;
    liveCaptionChunksRef.current = [];
    liveCaptionBusyRef.current = true;

    try {
      const windowBlob = new Blob(chunks, { type: "audio/webm" });
      const decoded = await decodeAudioFile(windowBlob);
      const mono = mixDownToMono(decoded);
      const wavBlob = encodeWav(mono, decoded.sampleRate);
      const result = await transcribeAudioRequest({
        provider: sttProvider,
        audioBlob: wavBlob,
        fileName: "live-caption-window.wav",
        durationSec: decoded.duration,
        preprocessing: { vocalIsolation: false, normalize: false, noiseRemoval: false },
        attendeeNames: audioAttendeeNames()
      });

      const text = result.transcriptSegments
        .map((segment) => segment.text)
        .join(" ")
        .trim();

      if (text) {
        setLiveCaptionLines((current) => [...current, text]);
      }
    } catch {
      // Live captions are a best-effort preview, not the authoritative transcript (that comes from
      // "분석 시작" after recording stops) - a failed window is silently skipped rather than
      // surfaced as an error, so one slow/failed chunk doesn't interrupt the recording itself.
    } finally {
      liveCaptionBusyRef.current = false;
    }
  };

  const clearSystemRecordingTimers = () => {
    if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    if (liveCaptionTimerRef.current) {
      clearInterval(liveCaptionTimerRef.current);
      liveCaptionTimerRef.current = null;
    }
  };

  const handleStartSystemRecording = async () => {
    if (isSystemRecording) {
      return;
    }

    setSystemRecordingError("");

    if (!isSystemAudioCaptureSupported()) {
      setSystemRecordingError("이 환경에서는 PC 소리 녹음을 지원하지 않습니다.");
      return;
    }

    try {
      const recording = await startSystemAudioRecording((chunk) => {
        liveCaptionChunksRef.current.push(chunk);
      });

      systemRecordingRef.current = recording;
      liveCaptionChunksRef.current = [];
      setLiveCaptionLines([]);
      setRecordingElapsedSec(0);
      setIsSystemRecording(true);

      elapsedTimerRef.current = setInterval(() => {
        setRecordingElapsedSec((current) => current + 1);
      }, 1000);
      liveCaptionTimerRef.current = setInterval(() => {
        void runLiveCaptionWindow();
      }, LIVE_CAPTION_WINDOW_MS);
    } catch (error) {
      setSystemRecordingError(error instanceof Error ? error.message : "PC 소리 녹음을 시작하지 못했습니다.");
    }
  };

  const handleStopSystemRecording = async () => {
    const recording = systemRecordingRef.current;
    if (!recording) {
      return;
    }

    clearSystemRecordingTimers();
    systemRecordingRef.current = null;
    setIsSystemRecording(false);

    const blob = await recording.stop();
    // Any audio captured after the last live-caption window still gets folded into the final,
    // authoritative "분석 시작" pass below - only the rolling preview text skips it.
    liveCaptionChunksRef.current = [];

    const file = new File([blob], `pc-audio-${Date.now()}.webm`, { type: blob.type });
    setPendingAudioFile(file);
  };

  useEffect(() => {
    return () => {
      clearSystemRecordingTimers();
      void systemRecordingRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAudioComplete = async (analysis: AudioAnalysis) => {
    setDraft((current) => ({ ...current, audio: analysis }));
    setShowAudioAnalysis(false);

    // B7 audio retention policy: keep the original recording alongside the meeting's materials
    // (this app never creates per-speaker sliced audio files, so there's nothing else to retain
    // or delete - see AudioAnalysis.audioPath's comment in domain.ts). Best-effort: a failed
    // upload just means the recording isn't retained this time, never blocks the analysis result
    // the user is already looking at.
    if (pendingAudioFile) {
      try {
        const uploaded = await uploadAttachment(attachmentFolderLabel(draft), "audio", pendingAudioFile);
        setDraft((current) => (current.audio ? { ...current, audio: { ...current.audio, audioPath: uploaded.path } } : current));
      } catch {
        // ignore - retention is best-effort
      }
    }
  };

  // Presenters first, then other key attendees, matching the diarization heuristic's
  // "presenters/key attendees first" speaker-ordering expectation. Dedupes and drops blanks.
  const audioAttendeeNames = () => {
    const presenters = draft.attendees.filter((attendee) => attendee.isPresenter).map((attendee) => attendee.name);
    const otherKeyAttendees = draft.attendees
      .filter((attendee) => attendee.isKeyAttendee && !attendee.isPresenter)
      .map((attendee) => attendee.name);

    return Array.from(new Set([...presenters, ...otherKeyAttendees])).filter(Boolean);
  };

  // ---------- Minutes generation ----------

  const handleGenerateMinutes = async () => {
    setIsGeneratingMinutes(true);
    setMinutesError("");

    try {
      const minutes = await generateMinutes(llmProvider, meetingForGeneration, ollamaConfig);
      setDraft((current) => ({ ...current, minutes }));
    } catch (error) {
      setMinutesError(error instanceof Error ? error.message : "회의록 작성에 실패했습니다.");
    } finally {
      setIsGeneratingMinutes(false);
    }
  };

  // ---------- Save ----------

  const handleSubmit = async () => {
    if (!draft.title.trim()) {
      setSaveError("제목은 필수 입력 항목입니다.");
      return;
    }

    setIsSaving(true);
    setSaveError("");

    try {
      await onSubmit(draft, mode === "create" ? folderId : undefined);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "저장에 실패했습니다.");
    } finally {
      setIsSaving(false);
    }
  };

  const attendeeBadges = computeAttendeeBadges(draft.attendees);

  // Also used by PresentationSummaryModal (B5) - same synthetic Meeting shape as
  // handleGenerateMinutes builds, computed once here so both share it instead of duplicating.
  const meetingForGeneration: Meeting = {
    ...draft,
    id: initial?.id ?? "draft",
    authorId: initial?.authorId ?? "",
    comments: initial?.comments ?? [],
    createdAt: initial?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  return (
    <>
      <ModalShell
        title={mode === "create" ? "새 회의록 등록" : "회의록 수정"}
        onClose={onClose}
        width="wide"
        footer={
          <>
            <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{saveError}</span>
            <div className="modal-footer-actions">
              <button className="ghost-action" onClick={onClose} type="button">
                취소
              </button>
              <button className="primary-action" disabled={isSaving} onClick={handleSubmit} type="button">
                {isSaving ? "저장 중..." : "저장"}
              </button>
            </div>
          </>
        }
      >
        {/* ---------- Import from file ---------- */}
        {mode === "create" && (
          <div className="field full">
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <button
                className="ghost-action"
                disabled={isImportingFile}
                onClick={() => void triggerImportFilePick()}
                type="button"
              >
                <FileInput size={15} />
                {isImportingFile ? "가져오는 중..." : "파일에서 가져오기"}
              </button>
              <span className="field-hint">PDF, Word, PowerPoint, Markdown, JSON 회의록 파일을 선택하면 아래 항목이 자동으로 채워집니다.</span>
            </div>
            <input
              accept=".pdf,.docx,.pptx,.md,.markdown,.json"
              hidden
              onChange={handleImportFileChange}
              ref={importFileInputRef}
              type="file"
            />
            {importFileError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{importFileError}</span>}
          </div>
        )}

        {/* ---------- Basic info ---------- */}
        <div className="form-grid">
          <div className="field full">
            <label htmlFor="meeting-title">제목 *</label>
            <input
              id="meeting-title"
              onChange={(event) => updateField("title", event.target.value)}
              placeholder="회의 제목을 입력하세요"
              value={draft.title}
            />
          </div>
          <div className="field">
            <label htmlFor="meeting-date">날짜</label>
            <input id="meeting-date" onChange={(event) => updateField("date", event.target.value)} type="date" value={draft.date} />
          </div>
          <div className="field">
            <label>상태</label>
            <span className={`status-badge ${status}`}>{meetingStatusLabels[status]}</span>
          </div>
          <div className="field">
            <label htmlFor="meeting-start-time">시작 시간</label>
            <input
              id="meeting-start-time"
              onChange={(event) => updateField("startTime", event.target.value)}
              type="time"
              value={draft.startTime}
            />
          </div>
          <div className="field">
            <label htmlFor="meeting-end-time">종료 시간</label>
            <input
              id="meeting-end-time"
              onChange={(event) => updateField("endTime", event.target.value)}
              type="time"
              value={draft.endTime}
            />
          </div>
          <div className="field">
            <label htmlFor="meeting-organizer">주관자</label>
            <input
              id="meeting-organizer"
              onChange={(event) => updateField("organizer", event.target.value)}
              placeholder="주관자 이름"
              value={draft.organizer}
            />
          </div>
          <div className="field">
            <label htmlFor="meeting-secretary">간사</label>
            <input
              id="meeting-secretary"
              onChange={(event) => updateField("secretary", event.target.value)}
              placeholder="간사 이름"
              value={draft.secretary}
            />
          </div>
        </div>

        {/* ---------- Attendees ---------- */}
        <div className="field full">
          <label>회의 참석자</label>
          <div className="editable-table-wrap">
            <table className="editable-table">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>역할</th>
                  <th>주요 참석자</th>
                  <th>발표자</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {draft.attendees.map((attendee, index) => (
                  <tr key={attendee.id}>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span className={`attendee-badge ${attendee.isPresenter ? "presenter" : "attendee"}`}>
                          {attendeeBadges[attendee.id]}
                        </span>
                        <input
                          onChange={(event) => updateAttendee(index, { name: event.target.value })}
                          placeholder="이름"
                          value={attendee.name}
                        />
                      </div>
                    </td>
                    <td>
                      <input
                        onChange={(event) => updateAttendee(index, { role: event.target.value })}
                        placeholder="역할"
                        value={attendee.role}
                      />
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <input
                        checked={attendee.isKeyAttendee}
                        onChange={(event) => updateAttendee(index, { isKeyAttendee: event.target.checked })}
                        style={{ width: 16, height: 16, minHeight: "auto" }}
                        type="checkbox"
                      />
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <input
                        checked={attendee.isPresenter}
                        onChange={(event) => updateAttendee(index, { isPresenter: event.target.checked })}
                        style={{ width: 16, height: 16, minHeight: "auto" }}
                        type="checkbox"
                      />
                    </td>
                    <td>
                      <button className="row-icon-button" onClick={() => removeAttendee(index)} title="삭제" type="button">
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="editable-table-add-row">
            <button className="ghost-action" onClick={addAttendee} type="button">
              <Plus size={15} />
              참석자 추가
            </button>
          </div>
        </div>

        <input hidden onChange={handleMaterialFileChange} ref={materialFileInputRef} type="file" />
        {materialError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{materialError}</span>}

        {/* ---------- A/I list ---------- */}
        <div className="field full">
          <label>A/I List</label>
          <span className="field-hint">
            회의 전에 사전 계획된 액션 아이템입니다. 회의 중 새로 생긴 항목은 회의록 작성 시 별도로 정리됩니다. 발표 자료는 📎로 첨부하고,
            첨부된 파일은 <FolderOpen size={12} style={{ verticalAlign: "-1px" }} />로 열어 확인할 수 있습니다.
          </span>
          <div className="editable-table-wrap">
            <table className="editable-table">
              <thead>
                <tr>
                  <th style={{ width: "6%" }}>No</th>
                  <th style={{ width: "38%" }}>제목</th>
                  <th style={{ width: "32%" }}>발표 자료</th>
                  <th style={{ width: "16%" }}>발표자</th>
                  <th style={{ width: "8%" }}></th>
                </tr>
              </thead>
              <tbody>
                {draft.actionItems.map((item, index) => (
                  <tr key={index}>
                    <td>{index + 1}</td>
                    <td>
                      <input
                        onChange={(event) => updateActionItem(index, { title: event.target.value })}
                        placeholder="제목"
                        value={item.title}
                      />
                    </td>
                    <td>
                      <div className="material-cell">
                        <input
                          onChange={(event) => updateActionItem(index, { material: event.target.value })}
                          placeholder="발표 자료"
                          value={item.material}
                        />
                        <button
                          className="row-icon-button"
                          disabled={isUploadingMaterial}
                          onClick={() => handleAttachMaterialClick({ kind: "actionItem", index })}
                          title="파일 첨부"
                          type="button"
                        >
                          <Paperclip size={14} />
                        </button>
                        {item.materialPath && (
                          <button
                            className="row-icon-button"
                            onClick={() => handleOpenMaterial(item.materialPath!)}
                            title="첨부파일 열기"
                            type="button"
                          >
                            <FolderOpen size={14} />
                          </button>
                        )}
                        {item.materialMdPath && (
                          <button
                            className="row-icon-button"
                            onClick={() => handleOpenMaterial(item.materialMdPath!)}
                            title="Markdown 변환본 열기"
                            type="button"
                          >
                            <FileText size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                    <td>
                      <input
                        onChange={(event) => updateActionItem(index, { presenter: event.target.value })}
                        placeholder="발표자"
                        value={item.presenter}
                      />
                    </td>
                    <td>
                      <button className="row-icon-button" onClick={() => removeActionItem(index)} title="삭제" type="button">
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="editable-table-add-row">
            <button className="ghost-action" onClick={addActionItem} type="button">
              <Plus size={15} />
              A/I 추가
            </button>
          </div>
        </div>

        {/* ---------- Agenda ---------- */}
        <div className="field full">
          <label>회의 Agenda</label>
          <span className="field-hint">본 회의에서 실제로 다룰 안건입니다.</span>
          <div className="editable-table-wrap">
            <table className="editable-table">
              <thead>
                <tr>
                  <th style={{ width: "5%" }}>No</th>
                  <th style={{ width: "34%" }}>제목</th>
                  <th style={{ width: "12%" }}>발표 시간(분)</th>
                  <th style={{ width: "25%" }}>발표 자료</th>
                  <th style={{ width: "14%" }}>발표자</th>
                  <th style={{ width: "10%" }}></th>
                </tr>
              </thead>
              <tbody>
                {draft.agenda.map((item, index) => (
                  <tr key={index}>
                    <td>{index + 1}</td>
                    <td>
                      <input
                        onChange={(event) => updateAgendaItem(index, { title: event.target.value })}
                        placeholder="제목"
                        value={item.title}
                      />
                    </td>
                    <td>
                      <input
                        min={0}
                        onChange={(event) => {
                          const parsed = Number(event.target.value);
                          updateAgendaItem(index, { durationMinutes: Number.isFinite(parsed) ? Math.max(0, parsed) : 0 });
                        }}
                        type="number"
                        value={item.durationMinutes}
                      />
                    </td>
                    <td>
                      <div className="material-cell">
                        <input
                          onChange={(event) => updateAgendaItem(index, { material: event.target.value })}
                          placeholder="발표 자료"
                          value={item.material}
                        />
                        <button
                          className="row-icon-button"
                          disabled={isUploadingMaterial}
                          onClick={() => handleAttachMaterialClick({ kind: "agenda", index })}
                          title="파일 첨부"
                          type="button"
                        >
                          <Paperclip size={14} />
                        </button>
                        {item.materialPath && (
                          <button
                            className="row-icon-button"
                            onClick={() => handleOpenMaterial(item.materialPath!)}
                            title="첨부파일 열기"
                            type="button"
                          >
                            <FolderOpen size={14} />
                          </button>
                        )}
                        {item.materialMdPath && (
                          <button
                            className="row-icon-button"
                            onClick={() => handleOpenMaterial(item.materialMdPath!)}
                            title="Markdown 변환본 열기"
                            type="button"
                          >
                            <FileText size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                    <td>
                      <input
                        onChange={(event) => updateAgendaItem(index, { presenter: event.target.value })}
                        placeholder="발표자"
                        value={item.presenter}
                      />
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 4 }}>
                        <button
                          className="row-icon-button"
                          onClick={() => setSummaryTargetNo(item.no)}
                          title={item.presentationSummary ? "발표 내용 정리 보기/수정" : "발표 내용 자동 정리"}
                          type="button"
                        >
                          <Bot size={15} color={item.presentationSummary ? "#1f6f68" : undefined} />
                        </button>
                        <button className="row-icon-button" onClick={() => removeAgendaItem(index)} title="삭제" type="button">
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="editable-table-add-row">
            <button className="ghost-action" onClick={addAgendaItem} type="button">
              <Plus size={15} />
              Agenda 추가
            </button>
          </div>
        </div>

        {/* ---------- Audio ---------- */}
        <div className="field full">
          <label>회의 음성 파일</label>

          {draft.audio && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <span className="field-hint">
                {draft.audio.fileName} · {Math.round(draft.audio.durationSec)}초 · 화자 {Object.keys(draft.audio.speakerMap).length}명
              </span>
              {draft.audio.audioPath && (
                <button className="ghost-action" onClick={() => handleOpenMaterial(draft.audio!.audioPath!)} type="button">
                  <FolderOpen size={14} />
                  원본 오디오 열기
                </button>
              )}
              <button className="ghost-action" onClick={() => void triggerAudioFilePick()} type="button">
                다시 분석
              </button>
            </div>
          )}

          <div className="import-drop-zone" onClick={() => void triggerAudioFilePick()} role="button" tabIndex={0}>
            <Upload size={22} />
            <strong>{pendingAudioFile ? pendingAudioFile.name : "회의 음성 파일을 선택하세요"}</strong>
            <input
              accept="audio/*"
              hidden
              onChange={handleAudioFileChange}
              onClick={(event) => event.stopPropagation()}
              ref={audioFileInputRef}
              type="file"
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {isSystemRecording ? (
              <button className="danger-action" onClick={() => void handleStopSystemRecording()} type="button">
                <Square size={15} />
                녹음 중지 (
                {`${Math.floor(recordingElapsedSec / 60)
                  .toString()
                  .padStart(2, "0")}:${(recordingElapsedSec % 60).toString().padStart(2, "0")}`}
                )
              </button>
            ) : (
              <button className="ghost-action" onClick={() => void handleStartSystemRecording()} type="button">
                <Mic size={15} />
                PC 소리 녹음
              </button>
            )}
            <span className="field-hint">스피커로 나오는 소리(상대방 목소리 등 PC가 재생하는 모든 소리)를 실시간으로 녹음합니다.</span>
          </div>
          {systemRecordingError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{systemRecordingError}</span>}

          {(isSystemRecording || liveCaptionLines.length > 0) && (
            <div className="live-caption-panel">
              {isSystemRecording && (
                <LiveWaveform analyser={systemRecordingRef.current?.analyser ?? null} height={56} />
              )}
              <div className="live-caption-panel-header">
                <span>실시간 자막 (미리보기 - 녹음 종료 후 "분석 시작"으로 정확한 대본을 생성합니다)</span>
                {isSystemRecording && <span className="live-caption-recording-dot" />}
              </div>
              <div className="live-caption-panel-body">
                {liveCaptionLines.length === 0 ? (
                  <span className="field-hint">{isSystemRecording ? "자막을 준비하는 중..." : ""}</span>
                ) : (
                  liveCaptionLines.map((line, index) => <p key={index}>{line}</p>)
                )}
              </div>
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button className="primary-action" disabled={!pendingAudioFile} onClick={() => setShowAudioAnalysis(true)} type="button">
              분석 시작
            </button>
            <button className="primary-action" disabled={isGeneratingMinutes} onClick={handleGenerateMinutes} type="button">
              {isGeneratingMinutes ? "작성 중..." : "회의록 작성"}
            </button>
            {minutesError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{minutesError}</span>}
          </div>
        </div>

        <div className="field full">
          <label htmlFor="meeting-minutes">회의록</label>
          <textarea
            id="meeting-minutes"
            onChange={(event) => updateField("minutes", event.target.value)}
            placeholder="회의록 작성 버튼을 누르거나 직접 입력하세요"
            rows={8}
            value={draft.minutes}
          />
        </div>
      </ModalShell>

      {showAudioAnalysis && pendingAudioFile && (
        <AudioAnalysisModal
          attendeeNames={audioAttendeeNames()}
          file={pendingAudioFile}
          onClose={() => setShowAudioAnalysis(false)}
          onComplete={handleAudioComplete}
          sttProvider={sttProvider}
        />
      )}

      {summaryTargetNo !== null &&
        (() => {
          const targetIndex = draft.agenda.findIndex((item) => item.no === summaryTargetNo);
          const targetItem = targetIndex === -1 ? null : draft.agenda[targetIndex];

          if (!targetItem) {
            return null;
          }

          return (
            <PresentationSummaryModal
              agendaItem={targetItem}
              llmProvider={llmProvider}
              meeting={meetingForGeneration}
              ollamaConfig={ollamaConfig}
              onClose={() => setSummaryTargetNo(null)}
              onSave={(summary) => updateAgendaItem(targetIndex, { presentationSummary: summary })}
            />
          );
        })()}
    </>
  );
}
