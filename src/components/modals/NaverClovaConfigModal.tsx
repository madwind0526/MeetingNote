import { useState } from "react";
import { ModalShell } from "./ModalShell";

interface NaverClovaConfigModalProps {
  hasExistingConfig: boolean;
  onSave: (invokeUrl: string, secretKey: string) => Promise<void> | void;
  onClear: () => Promise<void> | void;
  onClose: () => void;
}

export function NaverClovaConfigModal({ hasExistingConfig, onSave, onClear, onClose }: NaverClovaConfigModalProps) {
  const [invokeUrl, setInvokeUrl] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!invokeUrl.trim() || !secretKey.trim()) {
      setError("Invoke URL과 Secret Key를 모두 입력해 주세요.");
      return;
    }

    setIsBusy(true);
    setError("");

    try {
      await onSave(invokeUrl.trim(), secretKey.trim());
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
      title="Naver Clova Speech 설정"
      onClose={onClose}
      width="narrow"
      footer={
        <>
          <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{error}</span>
          <div className="modal-footer-actions">
            {hasExistingConfig && (
              <button className="danger-action" disabled={isBusy} onClick={handleClear} type="button">
                설정 삭제
              </button>
            )}
            <button className="ghost-action" onClick={onClose} type="button">
              취소
            </button>
            <button className="primary-action" disabled={isBusy || !invokeUrl.trim() || !secretKey.trim()} onClick={handleSave} type="button">
              저장
            </button>
          </div>
        </>
      }
    >
      <div className="field full">
        <label htmlFor="naver-clova-invoke-url">Invoke URL</label>
        <input
          autoFocus
          id="naver-clova-invoke-url"
          onChange={(event) => setInvokeUrl(event.target.value)}
          placeholder={hasExistingConfig ? "저장된 값이 있습니다. 새 값으로 덮어쓰려면 입력하세요." : "https://clovaspeech-gw.ncloud.com/external/v1/..."}
          value={invokeUrl}
        />
        <span className="field-hint">NCP 콘솔의 CLOVA Speech 도메인에서 발급된 API Gateway Invoke URL입니다.</span>
      </div>
      <div className="field full">
        <label htmlFor="naver-clova-secret-key">Secret Key</label>
        <input
          id="naver-clova-secret-key"
          onChange={(event) => setSecretKey(event.target.value)}
          placeholder={hasExistingConfig ? "저장된 값이 있습니다. 새 값으로 덮어쓰려면 입력하세요." : "Secret Key"}
          type="password"
          value={secretKey}
        />
        <span className="field-hint">
          이 프로젝트 폴더의 <code>.env</code> 파일에 저장되며, 서버(로컬 앱)에서만 사용됩니다.
        </span>
      </div>
    </ModalShell>
  );
}
