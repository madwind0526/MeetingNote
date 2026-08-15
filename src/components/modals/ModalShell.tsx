import { X } from "lucide-react";
import type { ReactNode } from "react";

interface ModalShellProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  placement?: "center" | "bottom-right";
  width?: "default" | "wide" | "xwide" | "narrow";
}

export function ModalShell({ title, onClose, children, footer, placement = "center", width = "default" }: ModalShellProps) {
  const widthClass = width === "wide" ? " wide" : width === "xwide" ? " xwide" : width === "narrow" ? " narrow" : "";
  const placementClass = placement === "bottom-right" ? " bottom-right" : "";

  return (
    <div className={`modal-backdrop${placementClass}`} onClick={onClose} role="presentation">
      <div
        className={`modal-shell${widthClass}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close-button" onClick={onClose} title="닫기" type="button">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}
