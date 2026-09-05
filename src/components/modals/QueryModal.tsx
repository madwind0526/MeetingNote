import { useState } from "react";
import { Bot } from "lucide-react";
import { ModalShell } from "./ModalShell";
import type { LlmProviderId, Meeting } from "../../types/domain";
import { llmProviders } from "../../types/domain";
import { scoreMeetingsForQuestion } from "../../lib/localSearch";
import type { OllamaConfig } from "../../lib/llm";
import { askLlm } from "../../lib/llm";

interface QueryModalProps {
  meetings: Meeting[];
  ollamaConfig: OllamaConfig;
  provider: LlmProviderId;
  onClose: () => void;
  onOpenMeeting: (meeting: Meeting) => void;
}

interface QueryResult {
  answer: string;
  matches: Meeting[];
}

const LOCAL_MATCH_LIMIT = 8;
const LLM_CONTEXT_LIMIT = 12;

export function QueryModal({ meetings, ollamaConfig, provider, onClose, onOpenMeeting }: QueryModalProps) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [isAsking, setIsAsking] = useState(false);
  const [error, setError] = useState("");
  const providerOption = llmProviders.find((item) => item.id === provider) ?? llmProviders[0];

  const runLocalAnswer = (): QueryResult => {
    const scored = scoreMeetingsForQuestion(question, meetings).slice(0, LOCAL_MATCH_LIMIT);

    return {
      answer:
        scored.length === 0
          ? `"${question}"와 일치하는 회의를 찾지 못했습니다.`
          : `"${question}"에 대해 ${scored.length}건의 회의를 찾았습니다.`,
      matches: scored.map((item) => item.meeting)
    };
  };

  const handleAsk = async () => {
    if (!question.trim()) {
      return;
    }

    if (provider === "local-preview") {
      setResult(runLocalAnswer());
      return;
    }

    setIsAsking(true);
    setError("");

    try {
      // Keyword-scored candidates keep the prompt small and grounded instead of dumping every
      // meeting; if nothing scores, fall back to the full visible list so aggregate questions
      const scored = scoreMeetingsForQuestion(question, meetings);
      const contextMeetings = (scored.length > 0 ? scored.map((item) => item.meeting) : meetings).slice(
        0,
        LLM_CONTEXT_LIMIT
      );

      const answer = await askLlm(provider, question, contextMeetings, provider === "ollama" ? ollamaConfig : undefined);

      setResult({
        answer,
        matches: scored.slice(0, LOCAL_MATCH_LIMIT).map((item) => item.meeting)
      });
    } catch (askError) {
      setError(askError instanceof Error ? askError.message : "질문 처리에 실패했습니다.");
    } finally {
      setIsAsking(false);
    }
  };

  return (
    <ModalShell
      title="질문하기"
      onClose={onClose}
      width="medium"
      footer={
        <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
          <button
            className="ghost-action"
            onClick={() => {
              setQuestion("");
              setResult(null);
              setError("");
            }}
            type="button"
          >
            초기화
          </button>
          <button className="primary-action" disabled={isAsking} onClick={handleAsk} type="button">
            {isAsking ? "생각 중..." : "질문"}
          </button>
        </div>
      }
    >
      <div className="field full">
        <label htmlFor="query-input">회의록에 대해 질문해보세요</label>
        <input
          autoFocus
          id="query-input"
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              void handleAsk();
            }
          }}
          placeholder="예: 다음 주 예정된 회의, 김도현이 주관한 회의"
          value={question}
        />
        <span className="field-hint">
          <Bot size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
          현재 답변 방식: <strong>{providerOption.label}</strong> (설정에서 변경할 수 있습니다)
        </span>
      </div>

      {error && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{error}</span>}

      {result && (
        <div className="field full">
          <p style={{ whiteSpace: "pre-wrap" }}>{result.answer}</p>
          {result.matches.length > 0 && (
            <>
              <label>참고한 회의</label>
              <div style={{ display: "grid", gap: 6 }}>
                {result.matches.map((meeting) => (
                  <button
                    className="ghost-action"
                    key={meeting.id}
                    onClick={() => onOpenMeeting(meeting)}
                    style={{ justifyContent: "space-between", width: "100%" }}
                    type="button"
                  >
                    <span>{meeting.title || "제목 없음"}</span>
                    <span style={{ color: "#8b968f", fontWeight: 500 }}>{meeting.date || "날짜 미정"}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </ModalShell>
  );
}
