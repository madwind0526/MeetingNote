import { scoreSpeakerProfileMatch, registerVoiceProfile } from "../voiceProfiles.mjs";

// Speaker labels are preserved when an STT provider returns them. Providers without real
// diarization are treated as a single-speaker transcript instead of inventing extra speakers from
// the attendee list.
const DEFAULT_SPEAKER_LABEL = "A";
// Prefix marking a speaker as not yet identified - AudioAnalysisModal's rename flow looks for this
// prefix to know a manual rename should trigger registering a brand-new voice profile (see
// registerVoiceProfile above and the /api/voice-profiles/register route in vite.config.mts).
export const UNREGISTERED_SPEAKER_PREFIX = "미등록 화자 ";

function buildTranscriptSegments(segments) {
  const firstExplicitLabel =
    segments.find((segment) => typeof segment.speaker === "string" && segment.speaker)?.speaker ?? DEFAULT_SPEAKER_LABEL;
  let lastSpeaker = firstExplicitLabel;

  return segments.map((segment) => {
    if (typeof segment.speaker === "string" && segment.speaker) {
      lastSpeaker = segment.speaker;
    }

    return {
      speaker: lastSpeaker,
      startSec: segment.startSec,
      endSec: segment.endSec,
      text: segment.text
    };
  });
}

function uniqueLabels(segments) {
  const explicitLabels = Array.from(new Set(segments.map((segment) => segment.speaker).filter((speaker) => typeof speaker === "string" && speaker)));
  return explicitLabels.length ? explicitLabels : [DEFAULT_SPEAKER_LABEL];
}

// Turns the Agenda table's planned order + `발표 시간(분)` into rough cumulative [start, end]
// windows - an estimate made before the meeting, not real timestamps from the recording. Items
// with no presenter or zero duration contribute no window (nothing to hint from).
function computeAgendaWindows(agenda) {
  if (!Array.isArray(agenda)) {
    return [];
  }

  let cursor = 0;
  const windows = [];

  for (const item of agenda) {
    const durationSec = Math.max(0, Number(item?.durationMinutes) || 0) * 60;
    const startSec = cursor;
    cursor += durationSec;
    const presenter = typeof item?.presenter === "string" ? item.presenter.trim() : "";

    if (presenter && durationSec > 0) {
      windows.push({ startSec, endSec: cursor, presenter });
    }
  }

  return windows;
}

// Picks the presenter whose agenda window overlaps this speaker's segments the most, by total
// overlapping seconds - a soft hint only (see matchSpeakerProfile's `hintedName` param), since the
// agenda is a plan and real meetings drift from it.
function hintedPresenterForLabel(labelSegments, agendaWindows) {
  if (agendaWindows.length === 0 || labelSegments.length === 0) {
    return null;
  }

  const overlapByPresenter = new Map();

  for (const segment of labelSegments) {
    for (const window of agendaWindows) {
      const overlap = Math.min(segment.endSec, window.endSec) - Math.max(segment.startSec, window.startSec);
      if (overlap > 0) {
        overlapByPresenter.set(window.presenter, (overlapByPresenter.get(window.presenter) ?? 0) + overlap);
      }
    }
  }

  if (overlapByPresenter.size === 0) {
    return null;
  }

  return Array.from(overlapByPresenter.entries()).sort((a, b) => b[1] - a[1])[0][0];
}

// No-embedding fallback (Mock/Naver Clova/OpenAI Whisper API, or a local run without an HF
// token/embeddings) - positional attendee-name assignment, same heuristic this project always
// used before B3's voice profiles existed.
export function diarizeSegments(segments, attendeeNames) {
  const names = Array.isArray(attendeeNames) ? attendeeNames : [];
  const labels = uniqueLabels(segments);
  const transcriptSegments = buildTranscriptSegments(segments);

  const speakerMap = {};
  if (labels.length === 1 && labels[0] === DEFAULT_SPEAKER_LABEL) {
    // No diarization signal at all (AUTO_DIARIZE_ON_TRANSCRIBE off, or a provider that never sets
    // `speaker`) - guessing a real attendee name from list position would look like a confirmed
    // match when it's pure luck, so mark it unregistered instead, matching
    // assignSpeakersWithProfiles's UNREGISTERED_SPEAKER_PREFIX naming. The user tags real names via
    // segment-level clip enrollment, or "화자 분리" classifies against registered profiles.
    speakerMap[labels[0]] = `${UNREGISTERED_SPEAKER_PREFIX}1`;
  } else {
    labels.forEach((label, index) => {
      speakerMap[label] = names[index] || `화자 ${label}`;
    });
  }

  return { transcriptSegments, speakerMap };
}

// Embedding-based matching (B3, local WhisperX/Whisper CLI with an HF token). Matching priority:
// (1) agenda-hinted presenter at a relaxed bar, (2) this meeting's own registered attendees at the
// full bar, (3) any other stored profile at the full bar, (4) "미등록 화자 N" - see
// memory-bank/roadmap.md's confirmed design. A confirmed match is immediately reinforced with this
// fresh embedding sample; an unmatched speaker is left unregistered until the user manually
// renames it in the UI (see UNREGISTERED_SPEAKER_PREFIX above).
//
// Two-pass on purpose: score every label first, then claim names by descending score, instead of
// matching+registering one label at a time. Diarization has already told us the labels in this
// recording are different people (that's what makes them separate labels), so if two of them
// independently clear the threshold against the SAME stored profile, only the closer-scoring one
// should actually get that name - matching label-by-label let both claim it, silently merging two
// different speakers into one profile (confirmed via live testing: a synthetic 2-speaker clip had
// both speakers come back as the same registered name on a repeat analysis run).
export async function assignSpeakersWithProfiles(segments, attendeeNames, embeddings, agenda) {
  const names = Array.isArray(attendeeNames) ? attendeeNames : [];
  const labels = uniqueLabels(segments);
  const transcriptSegments = buildTranscriptSegments(segments);
  const agendaWindows = computeAgendaWindows(agenda);

  const candidates = [];
  for (const label of labels) {
    const embedding = embeddings ? embeddings[label] : null;
    if (!embedding) {
      candidates.push({ label, embedding, match: null });
      continue;
    }
    const hintedName = agendaWindows.length
      ? hintedPresenterForLabel(
          segments.filter((segment) => segment.speaker === label),
          agendaWindows
        )
      : null;
    candidates.push({ label, embedding, match: await scoreSpeakerProfileMatch(embedding, names, hintedName) });
  }

  const claimedNames = new Set();
  const speakerMap = {};
  const wonLabels = new Set();

  const byScoreDesc = candidates.filter((candidate) => candidate.match).sort((a, b) => b.match.score - a.match.score);
  for (const { label, embedding, match } of byScoreDesc) {
    if (claimedNames.has(match.name)) {
      continue;
    }
    claimedNames.add(match.name);
    speakerMap[label] = match.name;
    wonLabels.add(label);
    await registerVoiceProfile(match.name, embedding);
  }

  let unregisteredCount = 0;
  for (const label of labels) {
    if (!wonLabels.has(label)) {
      unregisteredCount += 1;
      speakerMap[label] = `${UNREGISTERED_SPEAKER_PREFIX}${unregisteredCount}`;
    }
  }

  return { transcriptSegments, speakerMap };
}
