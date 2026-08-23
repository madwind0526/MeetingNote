import { useRef, useState } from "react";
import { Calendar, Clock, Download, FileText, FolderOpen, MessageSquare, Pause, Pencil, Play, Send, Trash2, User, Users, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ModalShell } from "./ModalShell";
import { TranscriptModal } from "./TranscriptModal";
import type { Meeting, PublicMember } from "../../types/domain";
import { canDeleteMeeting, computeAttendeeBadges, computeMeetingStatus, meetingStatusLabels } from "../../types/domain";
import { attachmentUrl, openAttachment } from "../../lib/api";
import { formatTranscriptText } from "../../lib/transcript";

function formatDateTime(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
}

function resolveMemberName(members: PublicMember[], authorId: string) {
  return members.find((member) => member.id === authorId)?.name ?? "알 수 없음";
}

// Renders the "발표 자료" cell as a plain label, or - when a real file was attached via the
// form - a clickable button that opens it (OS default app in Electron, browser tab otherwise),
// plus a second button to open its .md conversion when one exists (B4).
function MaterialCell({
  material,
  materialPath,
  materialMdPath,
  onError
}: {
  material: string;
  materialPath?: string;
  materialMdPath?: string;
  onError: (message: string) => void;
}) {
  if (!materialPath) {
    return <>{material || "-"}</>;
  }

  const handleOpen = async (path: string, errorMessage: string) => {
    try {
      await openAttachment(path);
    } catch (error) {
      onError(error instanceof Error ? error.message : errorMessage);
    }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <button
        className="ghost-action"
        onClick={() => handleOpen(materialPath, "첨부파일을 여는 데 실패했습니다.")}
        style={{ minHeight: 26, padding: "0 8px", fontSize: "0.86rem" }}
        title="첨부파일 열기"
        type="button"
      >
        <FolderOpen size={13} />
        {material || "첨부파일"}
      </button>
      {materialMdPath && (
        <button
          className="row-icon-button"
          onClick={() => handleOpen(materialMdPath, "Markdown 변환본을 여는 데 실패했습니다.")}
          title="Markdown 변환본 열기"
          type="button"
        >
          <FileText size={13} />
        </button>
      )}
    </div>
  );
}

// Plays a stored audio attachment inline (via the /attachments/ streaming route) instead of
// opening/downloading it - shows the file path itself as the clickable label (B2).
function AudioPathPlayer({ path }: { path: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const toggle = () => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }

    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  };

  return (
    <div>
      <button className="ghost-action" onClick={toggle} style={{ justifyContent: "flex-start", textAlign: "left" }} type="button">
        {isPlaying ? <Pause size={14} /> : <Play size={14} />}
        {path}
      </button>
      <audio
        hidden
        onEnded={() => setIsPlaying(false)}
        onPause={() => setIsPlaying(false)}
        onPlay={() => setIsPlaying(true)}
        ref={audioRef}
        src={attachmentUrl(path)}
      />
    </div>
  );
}

interface MeetingDetailModalProps {
  meeting: Meeting;
  currentMember: PublicMember;
  members: PublicMember[];
  onClose: () => void;
  onEdit: (meeting: Meeting) => void;
  onDelete: (meeting: Meeting) => void;
  onExport: (meeting: Meeting) => void;
  onAddComment: (meetingId: string, content: string) => void;
  onDeleteComment: (meetingId: string, commentId: string) => void;
}

function formatTimeRange(startTime: string, endTime: string) {
  if (startTime && endTime) {
    return `${startTime} - ${endTime}`;
  }

  return startTime || endTime || "시간 미정";
}

export function MeetingDetailModal({
  meeting,
  currentMember,
  members,
  onClose,
  onEdit,
  onDelete,
  onExport,
  onAddComment,
  onDeleteComment
}: MeetingDetailModalProps) {
  const status = computeMeetingStatus(meeting);
  const attendeeBadges = computeAttendeeBadges(meeting.attendees);
  const [materialError, setMaterialError] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [showTranscript, setShowTranscript] = useState(false);
  const transcriptText = formatTranscriptText(meeting.audio);

  const handleSubmitComment = () => {
    if (!commentDraft.trim()) {
      return;
    }

    onAddComment(meeting.id, commentDraft.trim());
    setCommentDraft("");
  };

  return (
    <>
    <ModalShell
      title="회의 상세"
      onClose={onClose}
      width="wide"
      footer={
        <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
          {canDeleteMeeting(meeting, currentMember) && (
            <button className="danger-action" onClick={() => onDelete(meeting)} type="button">
              <Trash2 size={16} />
              삭제
            </button>
          )}
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
            <User size={14} /> 간사
          </dt>
          <dd>{meeting.secretary || "-"}</dd>
        </div>
        <div className="meeting-detail-row">
          <dt>
            <Users size={14} /> 참석자
          </dt>
          <dd>
            {meeting.attendees.length === 0 ? (
              "-"
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {meeting.attendees.map((attendee) => (
                  <span key={attendee.id} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <span className={`attendee-badge ${attendee.isPresenter ? "presenter" : "attendee"}`}>
                      {attendeeBadges[attendee.id]}
                    </span>
                    {attendee.name || "-"}
                  </span>
                ))}
              </div>
            )}
          </dd>
        </div>
      </dl>

      {meeting.audio && (
        <div className="field full">
          <label>회의 오디오 / STT 대본</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {meeting.audio.audioPath ? (
              <AudioPathPlayer path={meeting.audio.audioPath} />
            ) : (
              <span className="field-hint">연결된 원본 오디오 파일이 없습니다.</span>
            )}
            {meeting.audio.transcriptPath ? (
              <button
                className="ghost-action"
                onClick={() => setShowTranscript(true)}
                style={{ justifyContent: "flex-start", textAlign: "left" }}
                type="button"
              >
                <FileText size={14} />
                {meeting.audio.transcriptPath}
              </button>
            ) : (
              <span className="field-hint">연결된 STT 대본 파일이 없습니다.</span>
            )}
          </div>
        </div>
      )}

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
                      <MaterialCell
                        material={item.material}
                        materialMdPath={item.materialMdPath}
                        materialPath={item.materialPath}
                        onError={setMaterialError}
                      />
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
                  <th style={{ width: "6%", textAlign: "center" }}>No</th>
                  <th style={{ width: "30%" }}>제목</th>
                  <th style={{ width: "12%", textAlign: "center" }}>발표시간</th>
                  <th style={{ width: "38%" }}>발표자료</th>
                  <th style={{ width: "14%", textAlign: "center" }}>발표자</th>
                </tr>
              </thead>
              <tbody>
                {meeting.agenda.map((item) => (
                  <tr key={item.no}>
                    <td style={{ textAlign: "center" }}>{item.no}</td>
                    <td>{item.title || "-"}</td>
                    <td style={{ textAlign: "center" }}>{item.durationMinutes}분</td>
                    <td>
                      <MaterialCell
                        material={item.material}
                        materialMdPath={item.materialMdPath}
                        materialPath={item.materialPath}
                        onError={setMaterialError}
                      />
                    </td>
                    <td style={{ textAlign: "center" }}>{item.presenter || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="field full">
        <label>회의록</label>
        {meeting.minutes.trim() ? (
          <div className="meeting-minutes-body markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{meeting.minutes}</ReactMarkdown>
          </div>
        ) : (
          <div className="meeting-minutes-body">회의록이 아직 작성되지 않았습니다.</div>
        )}
      </div>

      <div className="field full">
        <label>
          <MessageSquare size={14} /> 댓글 ({meeting.comments.length})
        </label>
        {meeting.comments.length === 0 ? (
          <span className="field-hint">아직 댓글이 없습니다.</span>
        ) : (
          <div className="comment-list">
            {meeting.comments.map((comment) => (
              <div className="comment-item" key={comment.id}>
                <div className="comment-meta">
                  <span>
                    {resolveMemberName(members, comment.authorId)} · {formatDateTime(comment.createdAt)}
                  </span>
                  {(currentMember.role === "admin" || comment.authorId === currentMember.id) && (
                    <button
                      className="row-icon-button"
                      onClick={() => onDeleteComment(meeting.id, comment.id)}
                      title="댓글 삭제"
                      type="button"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
                <div className="comment-content">{comment.content}</div>
              </div>
            ))}
          </div>
        )}

        <div className="comment-form">
          <textarea
            onChange={(event) => setCommentDraft(event.target.value)}
            placeholder="댓글을 입력하세요"
            rows={2}
            value={commentDraft}
          />
          <button className="ghost-action" onClick={handleSubmitComment} style={{ alignSelf: "flex-end" }} type="button">
            <Send size={14} />
            등록
          </button>
        </div>
      </div>

      {transcriptText && (
        <div className="field full">
          <label>STT 분석 대본</label>
          <div className="audio-transcript-preview compact">
            <pre>{transcriptText}</pre>
          </div>
        </div>
      )}
    </ModalShell>
    {showTranscript && (
      <TranscriptModal content={transcriptText} onClose={() => setShowTranscript(false)} title={`STT 대본 - ${meeting.title || "제목 없음"}`} />
    )}
    </>
  );
}
