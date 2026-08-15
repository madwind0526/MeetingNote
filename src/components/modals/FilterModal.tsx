import { useState } from "react";
import { ModalShell } from "./ModalShell";
import type { MeetingFilters, MeetingStatus } from "../../types/domain";
import { meetingStatusLabels } from "../../types/domain";

interface FilterModalProps {
  filters: MeetingFilters;
  onApply: (filters: MeetingFilters) => void;
  onClear: () => void;
  onClose: () => void;
}

const STATUS_ORDER: MeetingStatus[] = ["scheduled", "needs_minutes", "completed"];

export function FilterModal({ filters, onApply, onClear, onClose }: FilterModalProps) {
  const [draft, setDraft] = useState<MeetingFilters>(filters);

  const toggleStatus = (status: MeetingStatus) => {
    setDraft((current) => ({
      ...current,
      statuses: current.statuses.includes(status)
        ? current.statuses.filter((item) => item !== status)
        : [...current.statuses, status]
    }));
  };

  return (
    <ModalShell
      title="필터"
      onClose={onClose}
      footer={
        <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
          <button className="ghost-action" onClick={onClear} type="button">
            초기화
          </button>
          <button className="primary-action" onClick={() => onApply(draft)} type="button">
            적용
          </button>
        </div>
      }
    >
      <div className="field full">
        <label>상태</label>
        <div className="checkbox-grid">
          {STATUS_ORDER.map((status) => (
            <button
              className={draft.statuses.includes(status) ? "checkbox-chip active" : "checkbox-chip"}
              key={status}
              onClick={() => toggleStatus(status)}
              type="button"
            >
              {meetingStatusLabels[status]}
            </button>
          ))}
        </div>
      </div>

      <div className="field full">
        <label htmlFor="filter-organizer">주관자 포함</label>
        <input
          id="filter-organizer"
          onChange={(event) => setDraft((current) => ({ ...current, organizerText: event.target.value }))}
          placeholder="예: 김도현"
          value={draft.organizerText}
        />
      </div>

      <div className="field full">
        <label htmlFor="filter-attendee">참석자 포함</label>
        <input
          id="filter-attendee"
          onChange={(event) => setDraft((current) => ({ ...current, attendeeText: event.target.value }))}
          placeholder="예: 이수민"
          value={draft.attendeeText}
        />
      </div>

      <div className="field full">
        <label htmlFor="filter-keyword">키워드 (제목 / Agenda / A-I 항목)</label>
        <input
          id="filter-keyword"
          onChange={(event) => setDraft((current) => ({ ...current, keywordText: event.target.value }))}
          placeholder="예: 결제 시스템"
          value={draft.keywordText}
        />
        <span className="field-hint">회의 제목, Agenda 항목 제목, A/I List 항목 제목에서 검색합니다.</span>
      </div>

      <div className="form-grid">
        <div className="field">
          <label htmlFor="filter-date-from">시작일</label>
          <input
            id="filter-date-from"
            onChange={(event) => setDraft((current) => ({ ...current, dateFrom: event.target.value }))}
            type="date"
            value={draft.dateFrom}
          />
        </div>
        <div className="field">
          <label htmlFor="filter-date-to">종료일</label>
          <input
            id="filter-date-to"
            onChange={(event) => setDraft((current) => ({ ...current, dateTo: event.target.value }))}
            type="date"
            value={draft.dateTo}
          />
        </div>
      </div>
    </ModalShell>
  );
}
