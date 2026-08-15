import { ModalShell } from "./ModalShell";

interface ConfirmModalProps {
  title: string;
  message: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmModal({ title, message, confirmLabel = "삭제", onCancel, onConfirm }: ConfirmModalProps) {
  return (
    <ModalShell
      title={title}
      onClose={onCancel}
      width="narrow"
      footer={
        <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
          <button className="ghost-action" onClick={onCancel} type="button">
            취소
          </button>
          <button className="danger-action" onClick={onConfirm} type="button">
            {confirmLabel}
          </button>
        </div>
      }
    >
      <p>{message}</p>
    </ModalShell>
  );
}
