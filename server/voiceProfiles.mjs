import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, "data/db/voiceProfiles.json");

// Cosine-similarity floor for "this is the same person". Measured directly against this
// project's own synthetic test voices (data/test-audio/diarize-2speaker-ko-en.wav, two distinct
// Windows SAPI voices): same-speaker similarity (repeat runs of identical audio) came out ~1.0,
// but the two genuinely different speakers in that same recording measured 0.757 - an initial
// 0.75 threshold let them falsely match. 0.85 leaves real margin above that measured
// different-speaker score. Still only validated against ONE synthetic voice pair, not a broad set
// of real human voices - if matches feel wrong (never matching, or matching the wrong person),
// this is the first knob to revisit. See knowledge/trouble-shooting.md for how the diarization
// pipeline was debugged before.
const SIMILARITY_THRESHOLD = 0.85;
// Caps how many embedding samples accumulate per profile so the JSON file doesn't grow unbounded
// across many meetings - a rolling window is enough to average out per-recording noise.
const MAX_SAMPLES_PER_PROFILE = 20;

async function ensureDb() {
  try {
    await readFile(DB_PATH, "utf8");
  } catch {
    await mkdir(path.dirname(DB_PATH), { recursive: true });
    await writeFile(DB_PATH, "[]", "utf8");
  }
}

export async function readVoiceProfiles() {
  await ensureDb();
  const raw = await readFile(DB_PATH, "utf8");

  return JSON.parse(raw);
}

async function writeVoiceProfiles(profiles) {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  await writeFile(DB_PATH, JSON.stringify(profiles, null, 2), "utf8");
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return -1;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (normA === 0 || normB === 0) {
    return -1;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function meanEmbedding(samples) {
  const length = samples[0]?.length ?? 0;
  const sum = new Array(length).fill(0);

  for (const sample of samples) {
    for (let index = 0; index < length; index += 1) {
      sum[index] += sample[index];
    }
  }

  return sum.map((value) => value / samples.length);
}

// Matching priority (confirmed design, see memory-bank/roadmap.md): a profile among this
// meeting's own registered attendees wins even if a stranger profile scored higher - only when no
// attendee profile clears the threshold does the search widen to every stored profile. Returns
// the matched name, or null (caller falls back to "미등록").
export async function matchSpeakerProfile(embedding, meetingAttendeeNames) {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    return null;
  }

  const profiles = await readVoiceProfiles();
  if (profiles.length === 0) {
    return null;
  }

  const scored = profiles
    .map((profile) => ({ profile, score: cosineSimilarity(embedding, meanEmbedding(profile.embeddings)) }))
    .filter((entry) => entry.score >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return null;
  }

  const attendeeNames = new Set((meetingAttendeeNames || []).filter(Boolean));
  const attendeeMatch = scored.find((entry) => attendeeNames.has(entry.profile.name));

  return (attendeeMatch ?? scored[0]).profile.name;
}

// Registers a brand-new profile, or reinforces an existing one with another sample - called both
// automatically (a fresh sample from a confirmed profile match) and on user action (renaming a
// "미등록" speaker to a real name registers that name for the first time).
export async function registerVoiceProfile(name, embedding) {
  if (!name || !Array.isArray(embedding) || embedding.length === 0) {
    return null;
  }

  const profiles = await readVoiceProfiles();
  const existing = profiles.find((profile) => profile.name === name);

  if (existing) {
    existing.embeddings.push(embedding);
    if (existing.embeddings.length > MAX_SAMPLES_PER_PROFILE) {
      existing.embeddings = existing.embeddings.slice(-MAX_SAMPLES_PER_PROFILE);
    }
    existing.updatedAt = new Date().toISOString();
  } else {
    profiles.push({ id: randomUUID(), name, embeddings: [embedding], updatedAt: new Date().toISOString() });
  }

  await writeVoiceProfiles(profiles);

  return profiles;
}
