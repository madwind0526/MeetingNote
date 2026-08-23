import { ModalShell } from "./ModalShell";

interface TranscriptModalProps {
  title: string;
  content: string;
  onClose: () => void;
}

// Read-only popup for showing a full STT transcript - opened from a clickable transcript
// path/label instead of inline-only display, per B8 (see MeetingDetailModal/MeetingFormModal).
export function TranscriptModal({ title, content, onClose }: TranscriptModalProps) {
  return (
    <ModalShell onClose={onClose} overlayZIndex={1000} title={title} width="wide">
      <div className="audio-transcript-preview compact">
        <pre>{content || "표시할 대본 내용이 없습니다."}</pre>
      </div>
    </ModalShell>
  );
}
