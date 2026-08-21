import { useState } from "react";
import type { CSSProperties } from "react";
import { ModalShell } from "./ModalShell";
import type { MeetingFilters, MeetingStatus } from "../../types/domain";
import { meetingStatusLabels } from "../../types/domain";

interface FilterModalProps {
  // Upper bound for the Connection range slider - the highest tag-connection degree across all
  // meetings right now (see computeMeetingConnectionCounts in types/domain.ts). Computed by the
  // caller from the full, unfiltered meeting set so it can never shrink just because a filter is
  // currently narrowing the visible list.
  connectionMax: number;
  filters: MeetingFilters;
  onApply: (filters: MeetingFilters) => void;
  onClear: () => void;
  onClose: () => void;
}

const STATUS_ORDER: MeetingStatus[] = ["scheduled", "needs_minutes", "completed"];

function clampToRange(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function FilterModal({ connectionMax, filters, onApply, onClear, onClose }: FilterModalProps) {
  const [draft, setDraft] = useState<MeetingFilters>(filters);

  const toggleStatus = (status: MeetingStatus) => {
    setDraft((current) => ({
      ...current,
      statuses: current.statuses.includes(status)
        ? current.statuses.filter((item) => item !== status)
        : [...current.statuses, status]
    }));
  };

  // Everything the Connection slider displays is derived fresh from `draft` on every render -
  // never mirrored into its own useState - so there is no separate label cache that can get out of
  // sync with the slider or fail to reset. `draft.connectionMax === 0` is the "no upper bound"
  // sentinel (see MeetingFilters comment), so the *displayed* upper value substitutes the current
  // connectionLimit whenever that sentinel is set.
  const connectionLimit = Math.max(0, connectionMax);
  const sliderMax = Math.max(1, connectionLimit);
  const connectionMin = Math.min(draft.connectionMin, connectionLimit);
  const connectionUpper =
    connectionLimit === 0 ? 0 : draft.connectionMax > 0 ? Math.min(draft.connectionMax, connectionLimit) : connectionLimit;
  const lowerPercent = (connectionMin / sliderMax) * 100;
  const upperPercent = (connectionUpper / sliderMax) * 100;

  const updateConnectionMin = (value: number) => {
    setDraft((current) => ({
      ...current,
      connectionMin: Math.min(value, current.connectionMax > 0 ? current.connectionMax : connectionLimit)
    }));
  };

  const updateConnectionMax = (value: number) => {
    setDraft((current) => {
      const nextMax = Math.max(value, current.connectionMin);
      return { ...current, connectionMax: nextMax >= connectionLimit ? 0 : nextMax };
    });
  };

  const updateConnectionMinText = (value: string) => {
    const nextValue = Number(value);
    if (Number.isFinite(nextValue)) {
      updateConnectionMin(clampToRange(Math.round(nextValue), 0, connectionLimit));
    }
  };

  const updateConnectionMaxText = (value: string) => {
    const nextValue = Number(value);
    if (Number.isFinite(nextValue)) {
      updateConnectionMax(clampToRange(Math.round(nextValue), 0, connectionLimit));
    }
  };

  const handleApply = () => {
    onApply({
      ...draft,
      connectionMin,
      // Round-trip back to the "unset" sentinel if the thumb sits at the current limit, so a
      // slider left at max behaves identically to "no upper bound" instead of silently freezing
      // out any meeting added later with more connections than today's maximum.
      connectionMax: connectionUpper >= connectionLimit ? 0 : connectionUpper
    });
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
          <button className="primary-action" onClick={handleApply} type="button">
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
        <span className="field-hint">
          Keyword Prefix: [*]필수(AND), [+]또는(OR), [-]제외(NOT), 접두어가 없으면 [*](AND)로 처리
          <br />
          예: [*]김도현, [+]박준혁, [+]최유나, [-]정민석
        </span>
      </div>

      <div className="field full">
        <label htmlFor="filter-title">제목</label>
        <input
          id="filter-title"
          onChange={(event) => setDraft((current) => ({ ...current, titleText: event.target.value }))}
          placeholder="예: 로드맵 리뷰"
          value={draft.titleText}
        />
      </div>

      <div className="form-grid">
        <div className="field">
          <label htmlFor="filter-organizer">주관자</label>
          <input
            id="filter-organizer"
            onChange={(event) => setDraft((current) => ({ ...current, organizerText: event.target.value }))}
            placeholder="예: 김도현"
            value={draft.organizerText}
          />
        </div>
        <div className="field">
          <label htmlFor="filter-presenter">발표자</label>
          <input
            id="filter-presenter"
            onChange={(event) => setDraft((current) => ({ ...current, presenterText: event.target.value }))}
            placeholder="예: 박준혁"
            value={draft.presenterText}
          />
        </div>
      </div>

      <div className="field full">
        <label htmlFor="filter-presentation-summary">발표 내용</label>
        <input
          id="filter-presentation-summary"
          onChange={(event) => setDraft((current) => ({ ...current, presentationSummaryText: event.target.value }))}
          placeholder="예: partial_amount"
          value={draft.presentationSummaryText}
        />
      </div>

      <div className="field full">
        <label htmlFor="filter-tag">TAG</label>
        <input
          id="filter-tag"
          onChange={(event) => setDraft((current) => ({ ...current, tagText: event.target.value }))}
          placeholder="예: 결제시스템"
          value={draft.tagText}
        />
        <span className="field-hint">회의록 마지막의 TAG 섹션에서 검색합니다.</span>
      </div>

      <div className="field full">
        <label>Connection</label>
        <div className="connection-range-row">
          <label className="connection-value-input" aria-label="최소 연결 수">
            <input
              aria-label="최소 연결 수"
              max={connectionLimit}
              min={0}
              onChange={(event) => updateConnectionMinText(event.target.value)}
              type="number"
              value={connectionMin}
            />
          </label>
          <div className="dual-range" style={{ "--range-lower": `${lowerPercent}%`, "--range-upper": `${upperPercent}%` } as CSSProperties}>
            <div className="dual-range-track" />
            <input
              aria-label="최소 연결 수"
              max={sliderMax}
              min={0}
              onChange={(event) => updateConnectionMin(Number(event.target.value))}
              onInput={(event) => updateConnectionMin(Number(event.currentTarget.value))}
              type="range"
              value={connectionMin}
            />
            <input
              aria-label="최대 연결 수"
              max={sliderMax}
              min={0}
              onChange={(event) => updateConnectionMax(Number(event.target.value))}
              onInput={(event) => updateConnectionMax(Number(event.currentTarget.value))}
              type="range"
              value={connectionUpper}
            />
          </div>
          <label className="connection-value-input" aria-label="최대 연결 수">
            <input
              aria-label="최대 연결 수"
              max={connectionLimit}
              min={0}
              onChange={(event) => updateConnectionMaxText(event.target.value)}
              type="number"
              value={connectionUpper}
            />
          </label>
        </div>
        <span className="field-hint">Mesh 보기에서 같은 TAG로 연결된 회의 수 기준입니다.</span>
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
