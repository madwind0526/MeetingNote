import { useState } from "react";
import { ModalShell } from "./ModalShell";

interface SearchModalProps {
  query: string;
  onApply: (query: string) => void;
  onClear: () => void;
  onClose: () => void;
}

export function SearchModal({ query, onApply, onClear, onClose }: SearchModalProps) {
  const [draft, setDraft] = useState(query);

  return (
    <ModalShell
      title="검색"
      onClose={onClose}
      width="medium"
      footer={
        <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
          <button
            className="ghost-action"
            onClick={() => {
              setDraft("");
              onClear();
            }}
            type="button"
          >
            초기화
          </button>
          <button className="primary-action" onClick={() => onApply(draft)} type="button">
            적용
          </button>
        </div>
      }
    >
      <div className="field full">
        <label htmlFor="search-input">전체 내용 검색</label>
        <input
          autoFocus
          id="search-input"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onApply(draft);
            }
          }}
          placeholder="제목, 주관자, 발표자, 참석자, 발표 내용 등으로 검색"
          value={draft}
        />
      </div>
    </ModalShell>
  );
}
