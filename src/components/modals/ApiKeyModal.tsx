import { useState } from "react";
import { ModalShell } from "./ModalShell";

type ApiKeyKind = "anthropic" | "openai";

interface ApiKeyModalProps {
  kind: ApiKeyKind;
  hasExistingKey: boolean;
  onSave: (apiKey: string) => Promise<void> | void;
  onClear: () => Promise<void> | void;
  onClose: () => void;
}

interface KindContent {
  title: string;
  description: string;
  label: string;
  placeholder: string;
}

const KIND_CONTENT: Record<ApiKeyKind, KindContent> = {
  anthropic: {
    title: "Anthropic API 키 설정",
    description: "Claude 모델을 직접 호출하는 \"Anthropic API\" 답변 방식에서 사용됩니다.",
    label: "Anthropic API 키",
    placeholder: "sk-ant-..."
  },
  openai: {
    title: "OpenAI API 키 설정",
    description: "음성 파일을 인식하는 \"OpenAI Whisper API\" 방식에서 사용됩니다.",
    label: "OpenAI API 키",
    placeholder: "sk-..."
  }
};

export function ApiKeyModal({ kind, hasExistingKey, onSave, onClear, onClose }: ApiKeyModalProps) {
  const [apiKey, setApiKey] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");
  const content = KIND_CONTENT[kind];

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setError("API 키를 입력해 주세요.");
      return;
    }

    setIsBusy(true);
    setError("");

    try {
      await onSave(apiKey.trim());
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "저장에 실패했습니다.");
    } finally {
      setIsBusy(false);
    }
  };

  const handleClear = async () => {
    setIsBusy(true);
    setError("");

    try {
      await onClear();
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : "삭제에 실패했습니다.");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <ModalShell
      title={content.title}
      onClose={onClose}
      width="narrow"
      footer={
        <>
          <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{error}</span>
          <div className="modal-footer-actions">
            {hasExistingKey && (
              <button className="danger-action" disabled={isBusy} onClick={handleClear} type="button">
                키 삭제
              </button>
            )}
            <button className="ghost-action" onClick={onClose} type="button">
              취소
            </button>
            <button className="primary-action" disabled={isBusy || !apiKey.trim()} onClick={handleSave} type="button">
              저장
            </button>
          </div>
        </>
      }
    >
      <div className="field full">
        <label htmlFor="api-key-input">{content.label}</label>
        <input
          autoFocus
          id="api-key-input"
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={hasExistingKey ? "저장된 키가 있습니다. 새 값으로 덮어쓰려면 입력하세요." : content.placeholder}
          type="password"
          value={apiKey}
        />
        <span className="field-hint">
          이 프로젝트 폴더의 <code>.env</code> 파일에 저장되며, 서버(로컬 앱)에서만 사용됩니다.
        </span>
        <span className="field-hint">{content.description}</span>
      </div>
    </ModalShell>
  );
}
