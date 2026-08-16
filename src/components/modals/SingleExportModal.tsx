import { useState } from "react";
import { FileCode2, FileJson, FileText, FileType2, Presentation } from "lucide-react";
import { ModalShell } from "./ModalShell";
import type { ExportFormat, Meeting } from "../../types/domain";
import { exportMeetingsRequest, saveExportedFile } from "../../lib/api";

interface SingleExportModalProps {
  meetings: Meeting[];
  initialMeetingId?: string;
  defaultFormat: ExportFormat;
  onClose: () => void;
  onExported: (message: string) => void;
}

const FORMAT_OPTIONS: { format: ExportFormat; label: string; icon: typeof FileJson }[] = [
  { format: "pdf", label: "PDF", icon: FileText },
  { format: "docx", label: "Word", icon: FileType2 },
  { format: "pptx", label: "PowerPoint", icon: Presentation },
  { format: "md", label: "Markdown", icon: FileCode2 },
  { format: "json", label: "JSON", icon: FileJson }
];

// Single-meeting counterpart to ExportModal (which backs up/restores the whole DB). This exports
// exactly one meeting node, picked from a dropdown - used by the sidebar's 내보내기 button and by
// 회의 상세 > 내보내기 (with that meeting preselected).
export function SingleExportModal({ meetings, initialMeetingId, defaultFormat, onClose, onExported }: SingleExportModalProps) {
  const [meetingId, setMeetingId] = useState(initialMeetingId ?? meetings[0]?.id ?? "");
  const [format, setFormat] = useState<ExportFormat>(defaultFormat);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedMeeting = meetings.find((meeting) => meeting.id === meetingId) ?? null;

  const handleExport = async () => {
    if (!selectedMeeting) {
      setError("내보낼 회의록을 선택해 주세요.");
      return;
    }

    setIsBusy(true);
    setError("");

    try {
      const result = await exportMeetingsRequest(format, [selectedMeeting]);
      const savedPath = await saveExportedFile(result);
      onExported(savedPath ? `${result.fileName} 내보내기를 완료했습니다.` : "내보내기가 취소되었습니다.");
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "내보내기에 실패했습니다.");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <ModalShell
      title="내보내기"
      onClose={onClose}
      footer={
        <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
          <button className="ghost-action" onClick={onClose} type="button">
            취소
          </button>
          <button className="primary-action" disabled={isBusy || !selectedMeeting} onClick={handleExport} type="button">
            {isBusy ? "내보내는 중..." : "내보내기"}
          </button>
        </div>
      }
    >
      <div className="field full">
        <label htmlFor="single-export-meeting">회의 선택</label>
        {meetings.length === 0 ? (
          <span className="field-hint">내보낼 회의록이 없습니다.</span>
        ) : (
          <select id="single-export-meeting" onChange={(event) => setMeetingId(event.target.value)} value={meetingId}>
            {meetings.map((meeting) => (
              <option key={meeting.id} value={meeting.id}>
                {meeting.title || "제목 없음"} ({meeting.date || "날짜 미정"})
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="field full">
        <label>파일 형식</label>
        <div className="format-choice-row">
          {FORMAT_OPTIONS.map((option) => (
            <button
              className={option.format === format ? "format-choice-button active" : "format-choice-button"}
              key={option.format}
              onClick={() => setFormat(option.format)}
              type="button"
            >
              <option.icon size={16} />
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {error && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{error}</span>}
    </ModalShell>
  );
}
