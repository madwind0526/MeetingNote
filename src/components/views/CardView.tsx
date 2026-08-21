import { Calendar, Users, X } from "lucide-react";
import type { Meeting, PublicMember } from "../../types/domain";
import { attendeeSummary, canDeleteMeeting, computeMeetingStatus, meetingStatusLabels } from "../../types/domain";

interface CardViewProps {
  meetings: Meeting[];
  currentMember: PublicMember;
  onOpen: (meeting: Meeting) => void;
  onDelete: (meeting: Meeting) => void;
}

const SUMMARY_PREVIEW_LENGTH = 80;

function summaryPreview(minutes: string) {
  const trimmed = minutes.trim();
  if (!trimmed) {
    return "회의록이 아직 작성되지 않았습니다.";
  }

  return trimmed.length > SUMMARY_PREVIEW_LENGTH ? `${trimmed.slice(0, SUMMARY_PREVIEW_LENGTH)}...` : trimmed;
}

function formatTimeRange(startTime: string, endTime: string) {
  if (startTime && endTime) {
    return `${startTime} - ${endTime}`;
  }

  return startTime || endTime || "시간 미정";
}

export function CardView({ meetings, currentMember, onOpen, onDelete }: CardViewProps) {
  if (meetings.length === 0) {
    return (
      <div className="empty-state">
        <strong>표시할 회의록이 없습니다.</strong>
        <span>검색어나 필터 조건을 확인해 주세요.</span>
      </div>
    );
  }

  return (
    <div className="card-grid">
      {meetings.map((meeting) => {
        const status = computeMeetingStatus(meeting);

        return (
          <div className={`meeting-card status-${status}`} key={meeting.id} onClick={() => onOpen(meeting)} role="button" tabIndex={0}>
            <div className="meeting-card-top">
              <div className="meeting-card-title">
                <strong>{meeting.title || "제목 없음"}</strong>
                <span>{meeting.date || "날짜 미정"}</span>
              </div>
              {canDeleteMeeting(meeting, currentMember) && (
                <button
                  className="meeting-card-delete"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(meeting);
                  }}
                  title="삭제"
                  type="button"
                >
                  <X size={13} />
                </button>
              )}
            </div>
            <div className="meeting-card-meta">
              <div>
                <Calendar size={14} />
                <span>
                  {meeting.date || "날짜 미정"} {formatTimeRange(meeting.startTime, meeting.endTime)}
                </span>
              </div>
              <div>
                <Users size={14} />
                <span>{attendeeSummary(meeting.attendees) || "참석자 미정"}</span>
              </div>
            </div>
            <p className="meeting-card-summary">{summaryPreview(meeting.minutes)}</p>
            <div className="meeting-card-footer">
              <span className={`status-badge ${status}`}>{meetingStatusLabels[status]}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
