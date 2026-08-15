import { useRef, useState } from "react";
import { FileJson, FileText, Presentation, Upload } from "lucide-react";
import { ModalShell } from "./ModalShell";
import type { ImportDuplicateMode, ImportFormat, MeetingDraft } from "../../types/domain";
import { attendeeSummary } from "../../types/domain";
import type { ImportSummary } from "../../lib/api";
import { bulkUpsertMeetingsRequest, importMeetingsRequest } from "../../lib/api";

interface ImportModalProps {
  duplicateMode: ImportDuplicateMode;
  onClose: () => void;
  onImported: (summary: ImportSummary) => void;
}

const FORMAT_OPTIONS: { format: ImportFormat; label: string; icon: typeof FileJson; accept: string }[] = [
  { format: "pdf", label: "PDF", icon: FileText, accept: ".pdf" },
  { format: "docx", label: "Word", icon: FileText, accept: ".docx" },
  { format: "pptx", label: "PowerPoint", icon: Presentation, accept: ".pptx" },
  { format: "json", label: "JSON", icon: FileJson, accept: ".json" }
];

const DUPLICATE_MODE_LABELS: Record<ImportDuplicateMode, string> = {
  replace: "중복은 갱신",
  add: "모두 새로 추가",
  skip: "중복은 건너뛰기"
};

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function ImportModal({ duplicateMode, onClose, onImported }: ImportModalProps) {
  const [format, setFormat] = useState<ImportFormat>("pdf");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<MeetingDraft[] | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeOption = FORMAT_OPTIONS.find((option) => option.format === format)!;

  const handleParse = async () => {
    if (!file) {
      setError("가져올 파일을 선택해 주세요.");
      return;
    }

    setIsBusy(true);
    setError("");

    try {
      const meetings = await importMeetingsRequest(format, file);
      setPreview(meetings);
      if (meetings.length === 0) {
        setError("회의록을 찾지 못했습니다.");
      }
    } catch (parseError) {
      setError(errorMessage(parseError, "가져오기에 실패했습니다."));
    } finally {
      setIsBusy(false);
    }
  };

  const handleCommit = async () => {
    if (!preview || preview.length === 0) {
      return;
    }

    setIsBusy(true);
    setError("");

    try {
      const summary = await bulkUpsertMeetingsRequest(preview, duplicateMode);
      onImported(summary);
    } catch (commitError) {
      setError(errorMessage(commitError, "저장에 실패했습니다."));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <ModalShell
      title="가져오기"
      onClose={onClose}
      width="wide"
      footer={
        <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
          <button className="ghost-action" onClick={onClose} type="button">
            취소
          </button>
          {preview ? (
            <button className="primary-action" disabled={isBusy || preview.length === 0} onClick={handleCommit} type="button">
              {isBusy ? "저장 중..." : `${preview.length}건 가져오기 적용`}
            </button>
          ) : (
            <button className="primary-action" disabled={isBusy || !file} onClick={handleParse} type="button">
              {isBusy ? "분석 중..." : "미리보기"}
            </button>
          )}
        </div>
      }
    >
      <div className="field full">
        <label>파일 형식</label>
        <div className="format-choice-row">
          {FORMAT_OPTIONS.map((option) => (
            <button
              className={option.format === format ? "format-choice-button active" : "format-choice-button"}
              key={option.format}
              onClick={() => {
                setFormat(option.format);
                setFile(null);
                setPreview(null);
                setError("");
              }}
              type="button"
            >
              <option.icon size={16} />
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field full">
        <div className="import-drop-zone" onClick={() => fileInputRef.current?.click()} role="button" tabIndex={0}>
          <Upload size={22} />
          <strong>{file ? file.name : `${activeOption.label} 파일을 선택하세요`}</strong>
          <span className="field-hint">
            PDF, Word, PowerPoint 회의록 파일 또는 MeetingNote JSON 백업을 가져올 수 있습니다.
          </span>
          <input
            accept={activeOption.accept}
            hidden
            onChange={(event) => {
              setFile(event.target.files?.[0] ?? null);
              setPreview(null);
              setError("");
            }}
            ref={fileInputRef}
            type="file"
          />
        </div>
      </div>

      <span className="field-hint">현재 중복 처리: {DUPLICATE_MODE_LABELS[duplicateMode]}</span>

      {error && (
        <div className="import-warning-message" role="alert">
          {error}
        </div>
      )}

      {preview && preview.length > 0 && (
        <div className="field full" style={{ minHeight: 0, overflow: "auto" }}>
          <label>미리보기 ({preview.length}건)</label>
          <div className="table-wrap" style={{ maxHeight: 280 }}>
            <table className="import-preview-table">
              <thead>
                <tr>
                  <th>제목</th>
                  <th>날짜</th>
                  <th>시작~종료</th>
                  <th>주관자</th>
                  <th>참석자</th>
                  <th>Agenda 건수</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((meeting, index) => (
                  <tr key={index}>
                    <td>{meeting.title}</td>
                    <td>{meeting.date}</td>
                    <td>
                      {meeting.startTime}~{meeting.endTime}
                    </td>
                    <td>{meeting.organizer}</td>
                    <td>{attendeeSummary(meeting.attendees)}</td>
                    <td>{meeting.agenda.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </ModalShell>
  );
}
