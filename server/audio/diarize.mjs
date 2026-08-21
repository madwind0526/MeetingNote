import { matchSpeakerProfile, registerVoiceProfile } from "../voiceProfiles.mjs";

// Speaker labels are preserved when an STT provider returns them. Providers without real
// diarization are treated as a single-speaker transcript instead of inventing extra speakers from
// the attendee list.
const DEFAULT_SPEAKER_LABEL = "A";
// Prefix marking a speaker as not yet identified - AudioAnalysisModal's rename flow looks for this
// prefix to know a manual rename should trigger registering a brand-new voice profile (see
// registerVoiceProfile above and the /api/voice-profiles/register route in vite.config.mts).
export const UNREGISTERED_SPEAKER_PREFIX = "미등록 화자 ";

function buildTranscriptSegments(segments) {
  return segments.map((segment) => ({
    speaker: typeof segment.speaker === "string" && segment.speaker ? segment.speaker : DEFAULT_SPEAKER_LABEL,
    startSec: segment.startSec,
    endSec: segment.endSec,
    text: segment.text
  }));
}

function uniqueLabels(segments) {
  const explicitLabels = Array.from(new Set(segments.map((segment) => segment.speaker).filter((speaker) => typeof speaker === "string" && speaker)));
  return explicitLabels.length ? explicitLabels : [DEFAULT_SPEAKER_LABEL];
}

// No-embedding fallback (Mock/Naver Clova/OpenAI Whisper API, or a local run without an HF
// token/embeddings) - positional attendee-name assignment, same heuristic this project always
// used before B3's voice profiles existed.
export function diarizeSegments(segments, attendeeNames) {
  const names = Array.isArray(attendeeNames) ? attendeeNames : [];
  const labels = uniqueLabels(segments);
  const transcriptSegments = buildTranscriptSegments(segments);

  const speakerMap = {};
  labels.forEach((label, index) => {
    speakerMap[label] = names[index] || `화자 ${label}`;
  });

  return { transcriptSegments, speakerMap };
}

// Embedding-based matching (B3, local WhisperX/Whisper CLI with an HF token). Matching priority:
// (1) this meeting's own registered attendees, (2) any other stored profile, (3) "미등록 화자 N" -
// see memory-bank/roadmap.md's confirmed design. A confirmed match is immediately reinforced with
// this fresh embedding sample; an unmatched speaker is left unregistered until the user manually
// renames it in the UI (see UNREGISTERED_SPEAKER_PREFIX above).
export async function assignSpeakersWithProfiles(segments, attendeeNames, embeddings) {
  const names = Array.isArray(attendeeNames) ? attendeeNames : [];
  const labels = uniqueLabels(segments);
  const transcriptSegments = buildTranscriptSegments(segments);

  const speakerMap = {};
  let unregisteredCount = 0;

  for (const label of labels) {
    const embedding = embeddings ? embeddings[label] : null;
    const matchedName = embedding ? await matchSpeakerProfile(embedding, names) : null;

    if (matchedName) {
      speakerMap[label] = matchedName;
      await registerVoiceProfile(matchedName, embedding);
    } else {
      unregisteredCount += 1;
      speakerMap[label] = `${UNREGISTERED_SPEAKER_PREFIX}${unregisteredCount}`;
    }
  }

  return { transcriptSegments, speakerMap };
}
