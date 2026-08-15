import { useState } from "react";
import { Calendar, Clock, Download, FolderOpen, Pencil, Trash2, User, Users } from "lucide-react";
import { ModalShell } from "./ModalShell";
import type { Meeting } from "../../types/domain";
import { attendeeSummary, computeMeetingStatus, meetingStatusLabels } from "../../types/domain";
import { openAttachment } from "../../lib/api";

// Renders the "발표 자료" cell as a plain label, or - when a real file was attached via the
// form - a clickable button that opens it (OS default app in Electron, browser tab otherwise).
function MaterialCell({ material, materialPath, onError }: { material: string; materialPath?: string; onError: (message: string) => void }) {
  if (!materialPath) {
    return <>{material || "-"}</>;
  }

  return (
    <button
      className="ghost-action"
      onClick={async () => {
        try {
          await openAttachment(materialPath);
        } catch (error) {
          onError(error instanceof Error ? error.message : "첨부파일을 여는 데 실패했습니다.");
        }
      }}
      style={{ minHeight: 26, padding: "0 8px", fontSize: "0.86rem" }}
      title="첨부파일 열기"
      type="button"
    >
      <FolderOpen size={13} />
      {material || "첨부파일"}
    </button>
  );
}

interface MeetingDetailModalProps {
  meeting: Meeting;
  onClose: () => void;
  onEdit: (meeting: Meeting) => void;
  onDelete: (meeting: Meeting) => void;
  onExport: (meeting: Meeting) => void;
}

function formatTimeRange(startTime: string, endTime: string) {
  if (startTime && endTime) {
    return `${startTime} - ${endTime}`;
  }

  return startTime || endTime || "시간 미정";
}

export function MeetingDetailModal({ meeting, onClose, onEdit, onDelete, onExport }: MeetingDetailModalProps) {
  const status = computeMeetingStatus(meeting);
  const [materialError, setMaterialError] = useState("");

  return (
    <ModalShell
      title="회의 상세"
      onClose={onClose}
      width="wide"
      footer={
        <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
          <button className="danger-action" onClick={() => onDelete(meeting)} type="button">
            <Trash2 size={16} />
            삭제
          </button>
          <button className="ghost-action" onClick={() => onExport(meeting)} type="button">
            <Download size={16} />
            내보내기
          </button>
          <button className="primary-action" onClick={() => onEdit(meeting)} type="button">
            <Pencil size={16} />
            수정
          </button>
        </div>
      }
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <strong style={{ fontSize: "1.25rem" }}>{meeting.title || "제목 없음"}</strong>
        <span className={`status-badge ${status}`}>{meetingStatusLabels[status]}</span>
      </div>

      <dl className="meeting-detail-fields">
        <div className="meeting-detail-row">
          <dt>
            <Calendar size={14} /> 날짜
          </dt>
          <dd>{meeting.date || "날짜 미정"}</dd>
        </div>
        <div className="meeting-detail-row">
          <dt>
            <Clock size={14} /> 시간
          </dt>
          <dd>{formatTimeRange(meeting.startTime, meeting.endTime)}</dd>
        </div>
        <div className="meeting-detail-row">
          <dt>
            <User size={14} /> 주관자
          </dt>
          <dd>{meeting.organizer || "-"}</dd>
        </div>
        <div className="meeting-detail-row">
          <dt>
            <Users size={14} /> 참석자
          </dt>
          <dd>{attendeeSummary(meeting.attendees) || "-"}</dd>
        </div>
      </dl>

      <div className="field full">
        <label>A/I List</label>
        <span className="field-hint">회의 전에 사전 계획된 액션 아이템입니다.</span>
        {meeting.actionItems.length === 0 ? (
          <span className="field-hint">(A/I List 없음)</span>
        ) : (
          <div className="editable-table-wrap">
            <table className="editable-table">
              <thead>
                <tr>
                  <th style={{ width: "8%" }}>No</th>
                  <th style={{ width: "44%" }}>제목</th>
                  <th style={{ width: "34%" }}>발표자료</th>
                  <th style={{ width: "14%" }}>발표자</th>
                </tr>
              </thead>
              <tbody>
                {meeting.actionItems.map((item) => (
                  <tr key={item.no}>
                    <td>{item.no}</td>
                    <td>{item.title || "-"}</td>
                    <td>
                      <MaterialCell material={item.material} materialPath={item.materialPath} onError={setMaterialError} />
                    </td>
                    <td>{item.presenter || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {materialError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{materialError}</span>}
      </div>

      <div className="field full">
        <label>Agenda</label>
        {meeting.agenda.length === 0 ? (
          <span className="field-hint">(Agenda 없음)</span>
        ) : (
          <div className="editable-table-wrap">
            <table className="editable-table">
              <thead>
                <tr>
                  <th style={{ width: "6%" }}>No</th>
                  <th style={{ width: "40%" }}>제목</th>
                  <th style={{ width: "14%" }}>발표시간</th>
                  <th style={{ width: "26%" }}>발표자료</th>
                  <th style={{ width: "14%" }}>발표자</th>
                </tr>
              </thead>
              <tbody>
                {meeting.agenda.map((item) => (
                  <tr key={item.no}>
                    <td>{item.no}</td>
                    <td>{item.title || "-"}</td>
                    <td>{item.durationMinutes}분</td>
                    <td>
                      <MaterialCell material={item.material} materialPath={item.materialPath} onError={setMaterialError} />
                    </td>
                    <td>{item.presenter || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="field full">
        <label>회의록</label>
        <div className="meeting-minutes-body">{meeting.minutes.trim() || "회의록이 아직 작성되지 않았습니다."}</div>
      </div>
    </ModalShell>
  );
}
