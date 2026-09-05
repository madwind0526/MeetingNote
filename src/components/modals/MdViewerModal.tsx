import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ModalShell } from "./ModalShell";
import { fetchAttachmentText } from "../../lib/api";

interface MdViewerModalProps {
  title: string;
  path: string;
  onClose: () => void;
}

// opened instead of openAttachment(), which would hand it off to the OS's default text editor or a
// browser tab.
export function MdViewerModal({ title, path, onClose }: MdViewerModalProps) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setError("");

    fetchAttachmentText(path)
      .then((text) => {
        if (!cancelled) {
          setContent(text);
        }
      })
      .catch((fetchError: unknown) => {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : "Markdown 파일을 불러오지 못했습니다.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <ModalShell onClose={onClose} overlayZIndex={1000} title={title} width="wide">
      {error && <div className="audio-analysis-status error">{error}</div>}
      {!error && content === null && <div className="audio-analysis-status">불러오는 중...</div>}
      {!error && content !== null && (
        <div className="meeting-minutes-body markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || "표시할 내용이 없습니다."}</ReactMarkdown>
        </div>
      )}
    </ModalShell>
  );
}
