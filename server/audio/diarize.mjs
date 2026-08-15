// Speaker labels are preserved when an STT provider returns them. Providers without real
// diarization are treated as a single-speaker transcript instead of inventing extra speakers from
// the attendee list.
const DEFAULT_SPEAKER_LABEL = "A";

export function diarizeSegments(segments, attendeeNames) {
  const names = Array.isArray(attendeeNames) ? attendeeNames : [];
  const explicitLabels = Array.from(new Set(segments.map((segment) => segment.speaker).filter((speaker) => typeof speaker === "string" && speaker)));
  const labels = explicitLabels.length ? explicitLabels : [DEFAULT_SPEAKER_LABEL];

  const transcriptSegments = segments.map((segment) => {
    return {
      speaker: typeof segment.speaker === "string" && segment.speaker ? segment.speaker : DEFAULT_SPEAKER_LABEL,
      startSec: segment.startSec,
      endSec: segment.endSec,
      text: segment.text
    };
  });

  const speakerMap = {};
  labels.forEach((label, index) => {
    speakerMap[label] = names[index] || `화자 ${label}`;
  });

  return { transcriptSegments, speakerMap };
}
