import { useMemo, useState } from "react";
import { MessageSquare, Pin, Plus, Send, Trash2, X } from "lucide-react";
import { ModalShell } from "../modals/ModalShell";
import { ConfirmModal } from "../modals/ConfirmModal";
import type { BoardCategory, BoardPost, PublicMember } from "../../types/domain";
import { boardCategories, canDeleteBoardPost } from "../../types/domain";

interface BoardViewProps {
  posts: BoardPost[];
  members: PublicMember[];
  currentMember: PublicMember;
  onSave: (posts: BoardPost[]) => void;
  onSystemMessage: (message: string) => void;
}

type CategoryFilter = "전체" | BoardCategory;

const CATEGORY_FILTERS: CategoryFilter[] = ["전체", ...boardCategories];

// Gives each board category its own badge color (see .status-badge.board-* in app.css) instead of
// every category sharing one color.
const CATEGORY_BADGE_CLASS: Record<BoardCategory, string> = {
  공지: "board-notice",
  일반: "board-general",
  요청: "board-request",
  QnA: "board-qna"
};

function isAdmin(member: PublicMember) {
  return member.role === "admin";
}

function formatDateTime(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ko-KR", { dateStyle: "medium", timeStyle: "short" });
}

function resolveMemberName(members: PublicMember[], authorId: string) {
  return members.find((member) => member.id === authorId)?.name ?? "알 수 없음";
}

export function BoardView({ posts, members, currentMember, onSave, onSystemMessage }: BoardViewProps) {
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>("전체");
  const [selectedPostId, setSelectedPostId] = useState<string | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [composeCategory, setComposeCategory] = useState<BoardCategory>("일반");
  const [composeTitle, setComposeTitle] = useState("");
  const [composeContent, setComposeContent] = useState("");
  const [composePinned, setComposePinned] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [replyTarget, setReplyTarget] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<BoardPost | null>(null);

  const visiblePosts = useMemo(() => {
    const filtered = activeCategory === "전체" ? posts : posts.filter((post) => post.category === activeCategory);

    return [...filtered].sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }

      return b.createdAt.localeCompare(a.createdAt);
    });
  }, [activeCategory, posts]);

  const selectedPost = posts.find((post) => post.id === selectedPostId) ?? null;

  const handleCreatePost = () => {
    if (!composeTitle.trim()) {
      onSystemMessage("제목을 입력해 주세요.");
      return;
    }

    const post: BoardPost = {
      id: crypto.randomUUID(),
      category: composeCategory,
      title: composeTitle.trim(),
      content: composeContent,
      authorId: currentMember.id,
      createdAt: new Date().toISOString(),
      pinned: composeCategory === "공지" && composePinned,
      comments: []
    };

    onSave([post, ...posts]);
    setIsComposing(false);
    setComposeTitle("");
    setComposeContent("");
    setComposeCategory("일반");
    setComposePinned(false);
    onSystemMessage("게시글을 등록했습니다.");
  };

  const togglePin = (postId: string) => {
    onSave(posts.map((post) => (post.id === postId ? { ...post, pinned: !post.pinned } : post)));
    onSystemMessage("공지 고정 상태를 변경했습니다.");
  };

  const handleAddComment = () => {
    if (!selectedPost || !commentDraft.trim()) {
      return;
    }

    const comment = {
      id: crypto.randomUUID(),
      authorId: currentMember.id,
      content: commentDraft.trim(),
      createdAt: new Date().toISOString(),
      parentCommentId: replyTarget ?? undefined
    };

    onSave(posts.map((post) => (post.id === selectedPost.id ? { ...post, comments: [...post.comments, comment] } : post)));
    setCommentDraft("");
    setReplyTarget(null);
  };

  const handleDeleteComment = (commentId: string) => {
    if (!selectedPost) {
      return;
    }

    onSave(
      posts.map((post) =>
        post.id === selectedPost.id ? { ...post, comments: post.comments.filter((comment) => comment.id !== commentId) } : post
      )
    );
  };

  const handleConfirmDeletePost = () => {
    if (!deleteCandidate) {
      return;
    }

    onSave(posts.filter((post) => post.id !== deleteCandidate.id));
    onSystemMessage(`"${deleteCandidate.title}" 게시글을 삭제했습니다.`);
    setDeleteCandidate(null);
    setSelectedPostId(null);
  };

  return (
    <>
      <div className="view-header">
        <div>
          <p className="eyebrow">Board</p>
          <h1>게시판</h1>
        </div>
        <div className="view-header-actions">
          <button className="primary-action" onClick={() => setIsComposing(true)} type="button">
            <Plus size={16} />
            글쓰기
          </button>
        </div>
      </div>

      <div className="board-content">
        <div className="checkbox-grid">
          {CATEGORY_FILTERS.map((category) => (
            <button
              className={activeCategory === category ? "checkbox-chip active" : "checkbox-chip"}
              key={category}
              onClick={() => setActiveCategory(category)}
              type="button"
            >
              {category}
            </button>
          ))}
        </div>

        {visiblePosts.length === 0 ? (
          <div className="empty-state">
            <strong>게시글이 없습니다.</strong>
            <span>글쓰기 버튼으로 첫 게시글을 작성해 보세요.</span>
          </div>
        ) : (
          <div className="board-list">
            {visiblePosts.map((post) => (
              <button className="board-row" key={post.id} onClick={() => setSelectedPostId(post.id)} type="button">
                {post.pinned ? (
                  <span className="status-badge completed">
                    <Pin size={11} /> 고정
                  </span>
                ) : (
                  <span className={`status-badge ${CATEGORY_BADGE_CLASS[post.category]}`}>{post.category}</span>
                )}
                <span className="board-row-title">{post.title}</span>
                <span className="board-row-meta">{resolveMemberName(members, post.authorId)}</span>
                <span className="board-row-meta">{formatDateTime(post.createdAt)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {isComposing && (
        <ModalShell
          title="새 게시글"
          onClose={() => setIsComposing(false)}
          footer={
            <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
              <button className="ghost-action" onClick={() => setIsComposing(false)} type="button">
                취소
              </button>
              <button className="primary-action" onClick={handleCreatePost} type="button">
                등록
              </button>
            </div>
          }
        >
          <div className="field full">
            <label htmlFor="board-compose-category">카테고리</label>
            <select
              id="board-compose-category"
              onChange={(event) => setComposeCategory(event.target.value as BoardCategory)}
              value={composeCategory}
            >
              {boardCategories.map((category) => (
                <option disabled={category === "공지" && !isAdmin(currentMember)} key={category} value={category}>
                  {category}
                  {category === "공지" && !isAdmin(currentMember) ? " (admin 전용)" : ""}
                </option>
              ))}
            </select>
          </div>

          <div className="field full">
            <label htmlFor="board-compose-title">제목</label>
            <input id="board-compose-title" onChange={(event) => setComposeTitle(event.target.value)} value={composeTitle} />
          </div>

          <div className="field full">
            <label htmlFor="board-compose-content">내용</label>
            <textarea
              id="board-compose-content"
              onChange={(event) => setComposeContent(event.target.value)}
              rows={8}
              value={composeContent}
            />
          </div>

          {composeCategory === "공지" && (
            <label className="checkbox-inline">
              <input checked={composePinned} onChange={(event) => setComposePinned(event.target.checked)} type="checkbox" />
              상단 고정
            </label>
          )}
        </ModalShell>
      )}

      {selectedPost && (
        <ModalShell
          title="게시글"
          onClose={() => setSelectedPostId(null)}
          width="wide"
          footer={
            <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
              {canDeleteBoardPost(selectedPost, currentMember) && (
                <button className="danger-action" onClick={() => setDeleteCandidate(selectedPost)} type="button">
                  <Trash2 size={16} />
                  삭제
                </button>
              )}
              {selectedPost.category === "공지" && isAdmin(currentMember) && (
                <button className="ghost-action" onClick={() => togglePin(selectedPost.id)} type="button">
                  <Pin size={16} />
                  {selectedPost.pinned ? "고정 해제" : "상단 고정"}
                </button>
              )}
            </div>
          }
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <strong style={{ fontSize: "1.25rem" }}>{selectedPost.title}</strong>
            <span className={`status-badge ${CATEGORY_BADGE_CLASS[selectedPost.category]}`}>{selectedPost.category}</span>
          </div>
          <span className="field-hint">
            {resolveMemberName(members, selectedPost.authorId)} · {formatDateTime(selectedPost.createdAt)}
          </span>

          <div className="meeting-minutes-body">{selectedPost.content || "(내용 없음)"}</div>

          <div className="field full">
            <label>
              <MessageSquare size={14} /> 댓글 ({selectedPost.comments.length})
            </label>
            {selectedPost.comments.length === 0 ? (
              <span className="field-hint">아직 댓글이 없습니다.</span>
            ) : (
              <div className="comment-list">
                {selectedPost.comments.map((comment) => (
                  <div className={comment.parentCommentId ? "comment-item comment-item-reply" : "comment-item"} key={comment.id}>
                    <div className="comment-meta">
                      <span>
                        {resolveMemberName(members, comment.authorId)} · {formatDateTime(comment.createdAt)}
                      </span>
                      {(currentMember.role === "admin" || comment.authorId === currentMember.id) && (
                        <button className="row-icon-button" onClick={() => handleDeleteComment(comment.id)} title="댓글 삭제" type="button">
                          <X size={13} />
                        </button>
                      )}
                    </div>
                    <div className="comment-content">{comment.content}</div>
                    <button className="ghost-action" onClick={() => setReplyTarget(comment.id)} style={{ minHeight: 24, padding: "0 8px", fontSize: "0.78rem" }} type="button">
                      답글
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="comment-form">
              {replyTarget && (
                <span className="field-hint">
                  답글 작성 중{" "}
                  <button className="ghost-action" onClick={() => setReplyTarget(null)} style={{ minHeight: 22, padding: "0 6px" }} type="button">
                    취소
                  </button>
                </span>
              )}
              <textarea
                onChange={(event) => setCommentDraft(event.target.value)}
                placeholder="댓글을 입력하세요"
                rows={2}
                value={commentDraft}
              />
              <button className="ghost-action" onClick={handleAddComment} style={{ alignSelf: "flex-end" }} type="button">
                <Send size={14} />
                등록
              </button>
            </div>
          </div>
        </ModalShell>
      )}

      {deleteCandidate && (
        <ConfirmModal
          message={`"${deleteCandidate.title}" 게시글을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`}
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={handleConfirmDeletePost}
          title="게시글 삭제"
        />
      )}
    </>
  );
}
