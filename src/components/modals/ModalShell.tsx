import { X } from "lucide-react";
import type { ReactNode } from "react";

interface ModalShellProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  placement?: "center" | "bottom-right";
  width?: "default" | "wide" | "xwide" | "narrow";
  // Overrides the backdrop's stacking order (default z-index: 50, shared by every ModalShell).
  // Only needed for a modal that must always stay above other already-open modals - e.g.
  // FileNavigatorModal, which can be triggered from inside any other modal and must not end up
  // sandwiched underneath it just because that modal happens to appear later in the JSX tree
  // (same z-index siblings stack by DOM order, not by which one opened more recently).
  overlayZIndex?: number;
  // Defaults to false: every modal in this app requires an explicit close (the header's X button,
  // or a footer action) rather than an accidental outside click - a stray click shouldn't be able
  // to drop an in-progress form or a running analysis. Set true only for a modal where an outside
  // click closing it is actually the expected, low-stakes behavior.
  closeOnBackdropClick?: boolean;
}

export function ModalShell({
  title,
  onClose,
  children,
  footer,
  placement = "center",
  width = "default",
  overlayZIndex,
  closeOnBackdropClick = false
}: ModalShellProps) {
  const widthClass = width === "wide" ? " wide" : width === "xwide" ? " xwide" : width === "narrow" ? " narrow" : "";
  const placementClass = placement === "bottom-right" ? " bottom-right" : "";

  return (
    <div
      className={`modal-backdrop${placementClass}`}
      onClick={closeOnBackdropClick ? onClose : undefined}
      role="presentation"
      style={overlayZIndex ? { zIndex: overlayZIndex } : undefined}
    >
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
