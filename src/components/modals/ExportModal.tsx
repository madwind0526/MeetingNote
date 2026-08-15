import { useState } from "react";
import { FileJson, FileText, FileType2, Presentation } from "lucide-react";
import { ModalShell } from "./ModalShell";
import type { ExportFormat, Meeting } from "../../types/domain";
import { exportMeetingsRequest, saveExportedFile } from "../../lib/api";

interface ExportModalProps {
  allMeetings: Meeting[];
  visibleMeetings: Meeting[];
  defaultFormat: ExportFormat;
  onClose: () => void;
  onExported: (message: string) => void;
}

const FORMAT_OPTIONS: { format: ExportFormat; label: string; icon: typeof FileJson }[] = [
  { format: "pdf", label: "PDF", icon: FileText },
  { format: "docx", label: "Word", icon: FileType2 },
  { format: "pptx", label: "PowerPoint", icon: Presentation },
  { format: "json", label: "JSON", icon: FileJson }
];

export function ExportModal({ allMeetings, visibleMeetings, defaultFormat, onClose, onExported }: ExportModalProps) {
  const [format, setFormat] = useState<ExportFormat>(defaultFormat);
  const [scope, setScope] = useState<"all" | "visible">("all");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");
  const scopeMeetings = scope === "all" ? allMeetings : visibleMeetings;

  const handleExport = async () => {
    setIsBusy(true);
    setError("");

    try {
      const result = await exportMeetingsRequest(format, scopeMeetings);
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
          <button className="primary-action" disabled={isBusy || scopeMeetings.length === 0} onClick={handleExport} type="button">
            {isBusy ? "내보내는 중..." : "내보내기"}
          </button>
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
              onClick={() => setFormat(option.format)}
              type="button"
            >
              <option.icon size={16} />
              {option.label}
            </button>
          ))}
        </div>
        {format === "pdf" && (
          <span className="field-hint">PDF는 기본 정보/Agenda/A-I List/회의록을 회의별로 출력합니다.</span>
        )}
        {format === "docx" && <span className="field-hint">Word는 회의별로 기본 정보/Agenda/A-I List/회의록을 문서로 출력합니다.</span>}
        {format === "pptx" && <span className="field-hint">PowerPoint는 회의별로 요약 슬라이드를 출력합니다.</span>}
        {format === "json" && <span className="field-hint">JSON은 선택한 회의 전체 데이터를 원본 형태로 백업합니다.</span>}
      </div>

      <div className="field full">
        <label>내보낼 범위</label>
        <div className="format-choice-row">
          <button
            className={scope === "all" ? "format-choice-button active" : "format-choice-button"}
            onClick={() => setScope("all")}
            type="button"
          >
            전체 ({allMeetings.length}건)
          </button>
          <button
            className={scope === "visible" ? "format-choice-button active" : "format-choice-button"}
            onClick={() => setScope("visible")}
            type="button"
          >
            현재 화면에 보이는 목록 ({visibleMeetings.length}건)
          </button>
        </div>
      </div>

      {error && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{error}</span>}
    </ModalShell>
  );
}
