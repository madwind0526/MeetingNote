// Keeps "미등록 화자 N" labels consistent across chunks of the SAME chunked analysis session (see
// useChunkedAudioAnalysis). Each chunk is diarized independently by the server, so an unregistered
// speaker's number resets to 1 every chunk on its own - this module links a new chunk's
// unregistered speakers back to ones already seen earlier in this session via cosine similarity on
// their voice embeddings, renumbering only when no earlier speaker matches closely enough.
//
// Registered speakers (a name resolved via server/voiceProfiles.mjs's persistent, cross-meeting
// registry) never need this: the server already resolves them to the same real name in every
// chunk on its own, so this module only ever touches UNREGISTERED_SPEAKER_PREFIX-prefixed labels.

// Must match server/audio/diarize.mjs's UNREGISTERED_SPEAKER_PREFIX exactly.
export const UNREGISTERED_SPEAKER_PREFIX = "미등록 화자 ";

// Same bar as server/voiceProfiles.mjs's SIMILARITY_THRESHOLD - two distinct speakers in this
// project's test recordings scored ~0.757 against each other (see
// memory-bank/knowledge/trouble-shooting.md), so anything looser risks merging different people.
const SESSION_LINK_THRESHOLD = 0.85;

export interface SessionSpeaker {
  label: string;
  embedding: number[];
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function nextUnregisteredIndex(known: SessionSpeaker[]): number {
  let max = 0;
  for (const speaker of known) {
    const match = /^\d+$/.exec(speaker.label.slice(UNREGISTERED_SPEAKER_PREFIX.length));
    if (match) {
      max = Math.max(max, Number(match[0]));
    }
  }
  return max + 1;
}

// chunkSpeakerMap/chunkEmbeddings are exactly what a single transcribeAudioRequest() call returned
// for one chunk (rawLabel -> display name / embedding). known is this session's accumulated
// unregistered-speaker registry so far (empty on the first chunk). Returns a rawLabel -> sessionLabel
// map covering every key in chunkSpeakerMap (registered names pass through unchanged) plus the
// updated registry to pass into the next chunk's call.
export function reconcileUnregisteredSpeakers(
  chunkSpeakerMap: Record<string, string>,
  chunkEmbeddings: Record<string, number[]> | undefined,
  known: SessionSpeaker[]
): { relabeledMap: Record<string, string>; updatedKnown: SessionSpeaker[] } {
  const relabeledMap: Record<string, string> = {};
  const updatedKnown = [...known];
  let counter = nextUnregisteredIndex(updatedKnown);

  for (const [rawLabel, name] of Object.entries(chunkSpeakerMap)) {
    if (!name.startsWith(UNREGISTERED_SPEAKER_PREFIX)) {
      relabeledMap[rawLabel] = name;
      continue;
    }

    const embedding = chunkEmbeddings?.[rawLabel];
    let matched: SessionSpeaker | null = null;

    if (embedding) {
      let bestScore = SESSION_LINK_THRESHOLD;
      for (const speaker of updatedKnown) {
        const score = cosineSimilarity(embedding, speaker.embedding);
        if (score >= bestScore) {
          bestScore = score;
          matched = speaker;
        }
      }
    }

    if (matched) {
      relabeledMap[rawLabel] = matched.label;
      continue;
    }

    const sessionLabel = `${UNREGISTERED_SPEAKER_PREFIX}${counter}`;
    counter += 1;
    relabeledMap[rawLabel] = sessionLabel;
    if (embedding) {
      updatedKnown.push({ label: sessionLabel, embedding });
    }
  }

  return { relabeledMap, updatedKnown };
}
