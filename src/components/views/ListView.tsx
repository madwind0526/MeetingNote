import { useMemo } from "react";
import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react";
import type { Meeting, PublicMember } from "../../types/domain";
import { attendeeSummary, canDeleteMeeting, computeMeetingStatus, meetingStatusLabels } from "../../types/domain";

export type ListSortKey = "title" | "date" | "organizer" | "status";

interface ListViewProps {
  meetings: Meeting[];
  currentMember: PublicMember;
  onOpen: (meeting: Meeting) => void;
  onEdit: (meeting: Meeting) => void;
  onDelete: (meeting: Meeting) => void;
  sortKey: ListSortKey;
  sortAsc: boolean;
  onSortChange: (key: ListSortKey, asc: boolean) => void;
}

const SORTABLE_COLUMNS: { key: ListSortKey; label: string }[] = [
  { key: "title", label: "제목" },
  { key: "date", label: "날짜" }
];

function sortValue(meeting: Meeting, key: ListSortKey) {
  if (key === "status") {
    return meetingStatusLabels[computeMeetingStatus(meeting)];
  }

  return meeting[key];
}

export function ListView({ meetings, currentMember, onOpen, onEdit, onDelete, sortKey, sortAsc, onSortChange }: ListViewProps) {
  const sorted = useMemo(() => {
    const copy = [...meetings];
    copy.sort((a, b) => {
      const left = String(sortValue(a, sortKey));
      const right = String(sortValue(b, sortKey));

      return sortAsc ? left.localeCompare(right, "ko") : right.localeCompare(left, "ko");
    });

    return copy;
  }, [meetings, sortKey, sortAsc]);

  const handleHeaderClick = (key: ListSortKey) => {
    onSortChange(key, key === sortKey ? !sortAsc : true);
  };

  if (sorted.length === 0) {
    return (
      <div className="empty-state">
        <strong>표시할 회의록이 없습니다.</strong>
        <span>검색어나 필터 조건을 확인해 주세요.</span>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="meeting-table">
        <thead>
          <tr>
            <th style={{ textAlign: "center" }}>No</th>
            {SORTABLE_COLUMNS.map((column) => (
              <th
                key={column.key}
                onClick={() => handleHeaderClick(column.key)}
                style={column.key === "date" ? { textAlign: "center" } : undefined}
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  {column.label}
                  {sortKey === column.key && (sortAsc ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                </span>
              </th>
            ))}
            <th style={{ textAlign: "center" }}>시간</th>
            <th onClick={() => handleHeaderClick("organizer")} style={{ textAlign: "center" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                주관자
                {sortKey === "organizer" && (sortAsc ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
              </span>
            </th>
            <th>참석자</th>
            <th onClick={() => handleHeaderClick("status")} style={{ textAlign: "center" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                상태
                {sortKey === "status" && (sortAsc ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
              </span>
            </th>
            <th style={{ textAlign: "center" }}>작업</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((meeting, index) => {
            const status = computeMeetingStatus(meeting);

            return (
              <tr className={`status-row status-${status}`} key={meeting.id} onClick={() => onOpen(meeting)}>
                <td style={{ textAlign: "center" }}>{String(index + 1).padStart(4, "0")}</td>
                <td>{meeting.title || "제목 없음"}</td>
                <td style={{ textAlign: "center" }}>{meeting.date || "-"}</td>
                <td style={{ textAlign: "center" }}>
                  {meeting.startTime && meeting.endTime
                    ? `${meeting.startTime} - ${meeting.endTime}`
                    : meeting.startTime || meeting.endTime || "-"}
                </td>
                <td style={{ textAlign: "center" }}>{meeting.organizer || "-"}</td>
                <td>{attendeeSummary(meeting.attendees) || "-"}</td>
                <td style={{ textAlign: "center" }}>
                  <span className={`status-badge ${status}`}>{meetingStatusLabels[status]}</span>
                </td>
                <td>
                  <div className="row-actions" onClick={(event) => event.stopPropagation()}>
                    {canDeleteMeeting(meeting, currentMember) && (
                      <button aria-label="수정" className="row-icon-button" data-tooltip="수정" onClick={() => onEdit(meeting)} type="button">
                        <Pencil size={14} />
                      </button>
                    )}
                    {canDeleteMeeting(meeting, currentMember) && (
                      <button aria-label="삭제" className="row-icon-button" data-tooltip="삭제" onClick={() => onDelete(meeting)} type="button">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
