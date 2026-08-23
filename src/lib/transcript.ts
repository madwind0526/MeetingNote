import type { AudioAnalysis } from "../types/domain";

function formatTranscriptTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function formatTranscriptText(audio: AudioAnalysis | null): string {
  if (!audio || audio.transcriptSegments.length === 0) {
    return "";
  }

  return audio.transcriptSegments
    .map((segment) => {
      const speaker = audio.speakerMap[segment.speaker] || segment.speaker || "화자 미상";
      return `[${formatTranscriptTime(segment.startSec)}-${formatTranscriptTime(segment.endSec)}] ${speaker}: ${segment.text}`;
    })
    .join("\n");
}

export function transcriptFileNameFromAudio(fileName: string): string {
  const cleanName = fileName.trim() || "meeting-audio";
  const dotIndex = cleanName.lastIndexOf(".");
  const baseName = dotIndex > 0 ? cleanName.slice(0, dotIndex) : cleanName;
  return `${baseName}-stt-transcript.txt`;
}
