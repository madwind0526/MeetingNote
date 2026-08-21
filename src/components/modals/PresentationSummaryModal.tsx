import { useState } from "react";
import { Bot } from "lucide-react";
import { ModalShell } from "./ModalShell";
import type { AgendaItem, LlmProviderId, Meeting } from "../../types/domain";
import { generatePresentationSummary } from "../../lib/llm";
import type { OllamaConfig } from "../../lib/llm";

interface PresentationSummaryModalProps {
  agendaItem: AgendaItem;
  llmProvider: LlmProviderId;
  meeting: Meeting;
  ollamaConfig: OllamaConfig;
  onClose: () => void;
  onSave: (summary: string) => void;
}

export function PresentationSummaryModal({ agendaItem, llmProvider, meeting, ollamaConfig, onClose, onSave }: PresentationSummaryModalProps) {
  const [summary, setSummary] = useState(agendaItem.presentationSummary ?? "");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState("");

  const handleGenerate = async () => {
    setIsGenerating(true);
    setError("");

    try {
      const result = await generatePresentationSummary(llmProvider, meeting, agendaItem.no, ollamaConfig);
      setSummary(result);
    } catch (generateError) {
      setError(generateError instanceof Error ? generateError.message : "발표 내용 정리에 실패했습니다.");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSave = () => {
    onSave(summary);
    onClose();
  };

  return (
    <ModalShell
      title={`발표 내용 정리 - ${agendaItem.title || "제목 없음"}`}
      onClose={onClose}
      width="wide"
      footer={
        <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
          <button className="ghost-action" onClick={onClose} type="button">
            취소
          </button>
          <button className="primary-action" onClick={handleSave} type="button">
            저장
          </button>
        </div>
      }
    >
      <div className="field full">
        <label>정리 결과</label>
        <span className="field-hint">
          이 발표의 자료와 회의 전체 대본에서 관련된 부분을 찾아 (질문)/(답변)/(의견)/(할일) 형식으로 자동 정리합니다. 필요하면 직접
          수정할 수 있습니다.
        </span>
        <textarea
          onChange={(event) => setSummary(event.target.value)}
          placeholder="아직 정리된 내용이 없습니다. 아래 &quot;자동 정리&quot; 버튼을 눌러보세요."
          rows={14}
          value={summary}
        />
        <button className="ghost-action" disabled={isGenerating} onClick={handleGenerate} style={{ width: "fit-content" }} type="button">
          <Bot size={15} />
          {isGenerating ? "정리 중..." : "자동 정리"}
        </button>
      </div>

      {error && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{error}</span>}
    </ModalShell>
  );
}
