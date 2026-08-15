import { useState } from "react";
import { ModalShell } from "./ModalShell";

interface OllamaConfigModalProps {
  initialBaseUrl: string;
  initialModel: string;
  availableModels: string[];
  onClose: () => void;
  onSave: (baseUrl: string, model: string) => Promise<void> | void;
}

export function OllamaConfigModal({ initialBaseUrl, initialModel, availableModels, onClose, onSave }: OllamaConfigModalProps) {
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [model, setModel] = useState(initialModel);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!baseUrl.trim() || !model.trim()) {
      setError("서버 주소와 모델을 모두 입력해 주세요.");
      return;
    }

    setIsBusy(true);
    setError("");

    try {
      await onSave(baseUrl.trim(), model.trim());
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "저장에 실패했습니다.");
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <ModalShell
      title="Ollama 설정"
      onClose={onClose}
      width="narrow"
      footer={
        <>
          <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{error}</span>
          <div className="modal-footer-actions">
            <button className="ghost-action" onClick={onClose} type="button">
              취소
            </button>
            <button className="primary-action" disabled={isBusy} onClick={handleSave} type="button">
              저장
            </button>
          </div>
        </>
      }
    >
      <div className="field full">
        <label htmlFor="ollama-base-url">서버 주소</label>
        <input
          id="ollama-base-url"
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="http://127.0.0.1:11434"
          value={baseUrl}
        />
      </div>
      <div className="field full">
        <label htmlFor="ollama-model">모델 이름</label>
        <input
          id="ollama-model"
          list="ollama-model-options"
          onChange={(event) => setModel(event.target.value)}
          placeholder="예: llama3.1, gemma2"
          value={model}
        />
        <datalist id="ollama-model-options">
          {availableModels.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        {availableModels.length > 0 && (
          <span className="field-hint">서버에 설치된 모델: {availableModels.join(", ")}</span>
        )}
      </div>
    </ModalShell>
  );
}
