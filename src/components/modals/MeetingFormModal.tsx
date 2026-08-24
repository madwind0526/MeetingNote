import { useRef, useState } from "react";
import { Bot, FileInput, FileText, FolderOpen, Maximize2, Mic, Paperclip, Plus, Trash2, Upload } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { AudioAnalysisModal } from "./AudioAnalysisModal";
import { PresentationSummaryModal } from "./PresentationSummaryModal";
import { TranscriptModal } from "./TranscriptModal";
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
import { fetchAttachmentAsFile, importMeetingsRequest, inferImportFormat, openAttachment, uploadAttachment } from "../../lib/api";
import { pickFileWithConfiguredPicker } from "../../lib/filePicker";
import { isSystemAudioCaptureSupported } from "../../lib/systemAudioCapture";
import { formatTranscriptText, transcriptFileNameFromAudio } from "../../lib/transcript";
import type { DictionaryState } from "../../lib/dictionary";

type MaterialTarget = { kind: "actionItem" | "agenda"; index: number };

const AUDIO_FILE_EXTENSIONS = [".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".webm", ".mp4"];

interface MeetingFormModalProps {
  mode: "create" | "edit";
  initial?: Meeting;
  llmProvider: LlmProviderId;
  ollamaConfig: OllamaConfig;
  sttProvider: SttProviderId;
  // Threaded down to AudioAnalysisModal's word-correction popup so a newly registered 수정 사전
  // entry updates this same shared cache instead of writing to the server behind its back (see
  // App.tsx's `dictionary` state, loaded once per session and otherwise never refetched).
  dictionary: DictionaryState;
  onDictionaryChange: (next: DictionaryState) => void;
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

// Clamps an out-of-range day (e.g. typing "35", or a day that's fine for the previously-selected
// month but not the newly-picked one, like Feb 30) to the nearest real day of that month, and the
// month itself to 1-12 - same rule as normalizeMeeting's clampToNearestValidDate in server/db.mjs,
// duplicated here for immediate feedback as the user edits rather than only after saving.
// Anything not shaped like YYYY-MM-DD (empty string, a partially-typed value) passes through
// untouched - HTML's <input type="date"> only ever fires onChange with either that exact shape or
// an empty string, never a partial one, so this only ever needs to handle those two cases.
function clampToNearestValidDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return value;
  }

  const year = Number(match[1]);
  const month = Math.min(12, Math.max(1, Number(match[2])));
  const maxDay = new Date(year, month, 0).getDate();
  const day = Math.min(maxDay, Math.max(1, Number(match[3])));

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function renumber<T extends { no: number }>(items: T[]): T[] {
  return items.map((item, index) => ({ ...item, no: index + 1 }));
}

function attachmentFolderLabel(draft: MeetingDraft) {
  const date = draft.date.trim() || "no-date";
  const title = draft.title.trim() || "제목 없음";

  return `${date}-${title}`;
}

export function MeetingFormModal({
  mode,
  initial,
  llmProvider,
  ollamaConfig,
  sttProvider,
  dictionary,
  onDictionaryChange,
  onClose,
  onSubmit
}: MeetingFormModalProps) {
  const [draft, setDraft] = useState<MeetingDraft>(() => cloneDraft(initial));
  const [pendingAudioFile, setPendingAudioFile] = useState<File | null>(null);
  const [showAudioAnalysis, setShowAudioAnalysis] = useState(false);
  const [isLoadingExistingAudio, setIsLoadingExistingAudio] = useState(false);
  const [existingAudioLoadError, setExistingAudioLoadError] = useState("");
  const [showTranscriptPopup, setShowTranscriptPopup] = useState(false);
  const [isGeneratingMinutes, setIsGeneratingMinutes] = useState(false);
  const [minutesError, setMinutesError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [isImportingFile, setIsImportingFile] = useState(false);
  const [importFileError, setImportFileError] = useState("");
  // ---------- 오디오 분석 팝업 진입 방식 (파일 업로드 vs 실시간 녹음) ----------
  // Tracks how the currently-open AudioAnalysisModal was entered, independent of whether
  // pendingAudioFile happens to be set - a recording session sets pendingAudioFile too once it
  // finishes (see onRecordingFinalized below), but that shouldn't flip an already-open recording
  // popup back into file mode.
  const [audioSourceMode, setAudioSourceMode] = useState<"file" | "recording" | null>(null);
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
    const result = await pickFileWithConfiguredPicker([".pdf", ".docx", ".pptx", ".md", ".markdown", ".json"], "회의록 파일 선택");
    if (result.handled) {
      if (result.file) {
        await processImportFile(result.file);
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
    const result = await pickFileWithConfiguredPicker(undefined, "첨부할 자료 파일 선택");
    if (result.handled) {
      if (result.file) {
        await processMaterialFile(result.file, target);
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
    const result = await pickFileWithConfiguredPicker(AUDIO_FILE_EXTENSIONS, "회의 음성 파일 선택");
    if (result.handled) {
      if (result.file) {
        setPendingAudioFile(result.file);
      }
      return;
    }

    audioFileInputRef.current?.click();
  };

  // "분석 시작" needs an in-memory File to decode - a freshly picked file already is one, but
  // re-opening analysis on an already-saved meeting's audio (edit mode, nothing picked this
  // session) has to re-fetch the stored attachment first (B5/B6).
  const handleOpenAudioAnalysis = async () => {
    if (pendingAudioFile) {
      setAudioSourceMode("file");
      setShowAudioAnalysis(true);
      return;
    }

    if (!draft.audio?.audioPath) {
      return;
    }

    setIsLoadingExistingAudio(true);
    setExistingAudioLoadError("");

    try {
      const file = await fetchAttachmentAsFile(draft.audio.audioPath, draft.audio.fileName);
      setPendingAudioFile(file);
      setAudioSourceMode("file");
      setShowAudioAnalysis(true);
    } catch (error) {
      setExistingAudioLoadError(error instanceof Error ? error.message : "원본 오디오 파일을 불러오지 못했습니다.");
    } finally {
      setIsLoadingExistingAudio(false);
    }
  };

  // "PC 소리 녹음" now just opens AudioAnalysisModal in recording mode - the popup itself owns
  // starting system-audio capture (on mount), showing the live waveform, and running chunked
  // analysis once the user clicks its own "분석 시작" button (see AudioAnalysisModal).
  const handleOpenRecordingAnalysis = () => {
    setAudioSourceMode("recording");
    setShowAudioAnalysis(true);
  };

  // Mirrors what a picked/fetched file's pendingAudioFile already gives the "완료" flow below -
  // called once AudioAnalysisModal finishes stitching the recorded segments into one file, so
  // handleAudioComplete can upload it as the retained attachment exactly like a picked file.
  const handleRecordingFinalized = (file: File) => {
    setPendingAudioFile(file);
  };

  const handleAudioComplete = async (analysis: AudioAnalysis) => {
    setShowAudioAnalysis(false);
    setAudioSourceMode(null);
    let nextAnalysis: AudioAnalysis = analysis;

    // B7 audio retention policy: keep the original recording alongside the meeting's materials
    // (this app never creates per-speaker sliced audio files, so there's nothing else to retain
    // or delete - see AudioAnalysis.audioPath's comment in domain.ts). Best-effort: a failed
    // upload just means the recording isn't retained this time, never blocks the analysis result
    // the user is already looking at.
    if (pendingAudioFile) {
      try {
        const uploaded = await uploadAttachment(attachmentFolderLabel(draft), "audio", pendingAudioFile);
        nextAnalysis = { ...nextAnalysis, audioPath: uploaded.path };
      } catch {
        // ignore - retention is best-effort
      }
    }

    const transcriptText = formatTranscriptText(nextAnalysis);
    if (transcriptText) {
      try {
        const transcriptFile = new File([transcriptText], transcriptFileNameFromAudio(nextAnalysis.fileName), { type: "text/plain;charset=utf-8" });
        const uploaded = await uploadAttachment(attachmentFolderLabel(draft), "audio", transcriptFile);
        nextAnalysis = { ...nextAnalysis, transcriptPath: uploaded.path };
      } catch {
        // ignore - transcript rows are still persisted in the meeting JSON
      }
    }

    setDraft((current) => ({ ...current, audio: nextAnalysis }));
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
  const transcriptText = formatTranscriptText(draft.audio);
  const currentAudioFileLabel = pendingAudioFile?.name ?? draft.audio?.fileName ?? "";

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
        width="large"
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
            <input
              id="meeting-date"
              onChange={(event) => updateField("date", clampToNearestValidDate(event.target.value))}
              type="date"
              value={draft.date}
            />
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
                  <th style={{ width: "30%" }}>이름</th>
                  <th style={{ width: "30%" }}>역할</th>
                  <th style={{ width: "16%", textAlign: "center" }}>주요 참석자</th>
                  <th style={{ width: "14%", textAlign: "center" }}>발표자</th>
                  <th style={{ width: "10%", textAlign: "center" }}>삭제</th>
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
                    <td style={{ textAlign: "center" }}>
                      <button
                        className="row-icon-button"
                        onClick={() => removeAttendee(index)}
                        style={{ display: "inline-grid" }}
                        title="삭제"
                        type="button"
                      >
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
            <div style={{ display: "grid", gap: 6 }}>
              <span className="field-hint">
                {draft.audio.fileName} · {Math.round(draft.audio.durationSec)}초 · 화자 {Object.keys(draft.audio.speakerMap).length}명
              </span>
              {draft.audio.audioPath && <span className="field-hint">원본 오디오 파일: {draft.audio.audioPath}</span>}
              {draft.audio.transcriptPath && <span className="field-hint">STT 대본 파일: {draft.audio.transcriptPath}</span>}
            </div>
          )}

          <div className="import-drop-zone" onClick={() => void triggerAudioFilePick()} role="button" tabIndex={0}>
            <Upload size={22} />
            <strong>{currentAudioFileLabel || "회의 음성 파일을 선택하세요"}</strong>
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
            <button
              className="ghost-action"
              disabled={!isSystemAudioCaptureSupported()}
              onClick={handleOpenRecordingAnalysis}
              title={isSystemAudioCaptureSupported() ? undefined : "이 환경에서는 PC 소리 녹음을 지원하지 않습니다."}
              type="button"
            >
              <Mic size={15} />
              PC 소리 녹음
            </button>
            <span className="field-hint">스피커로 나오는 소리(상대방 목소리 등 PC가 재생하는 모든 소리)를 실시간으로 녹음합니다.</span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <button
              className="primary-action"
              disabled={(!pendingAudioFile && !draft.audio?.audioPath) || isLoadingExistingAudio}
              onClick={() => void handleOpenAudioAnalysis()}
              type="button"
            >
              {isLoadingExistingAudio ? "불러오는 중..." : "분석 시작"}
            </button>
            <button className="primary-action" disabled={isGeneratingMinutes} onClick={handleGenerateMinutes} type="button">
              {isGeneratingMinutes ? "작성 중..." : "회의록 작성"}
            </button>
            {minutesError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{minutesError}</span>}
          </div>
          {existingAudioLoadError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{existingAudioLoadError}</span>}
          {transcriptText && (
            <div className="audio-transcript-preview">
              <button
                className="audio-transcript-preview-title"
                onClick={() => setShowTranscriptPopup(true)}
                style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", padding: 0 }}
                type="button"
              >
                STT 분석 대본
                <Maximize2 size={13} />
              </button>
              <pre>{transcriptText}</pre>
            </div>
          )}
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

      {showAudioAnalysis && audioSourceMode && (audioSourceMode === "recording" || pendingAudioFile) && (
        <AudioAnalysisModal
          agenda={draft.agenda}
          attendeeNames={audioAttendeeNames()}
          dictionary={dictionary}
          onClose={() => {
            setShowAudioAnalysis(false);
            setAudioSourceMode(null);
          }}
          onComplete={handleAudioComplete}
          onDictionaryChange={onDictionaryChange}
          onRecordingFinalized={handleRecordingFinalized}
          source={audioSourceMode === "recording" ? { kind: "recording" } : { kind: "file", file: pendingAudioFile as File }}
          sttProvider={sttProvider}
        />
      )}

      {showTranscriptPopup && (
        <TranscriptModal
          content={transcriptText}
          onClose={() => setShowTranscriptPopup(false)}
          title={`STT 대본 - ${draft.title.trim() || "제목 없음"}`}
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
