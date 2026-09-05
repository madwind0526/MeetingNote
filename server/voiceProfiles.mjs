import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, "data/db/voiceProfiles.json");

// Cosine-similarity floor for "this is the same person" - the BASELINE only, at reliabilityScore
// == RELIABILITY_ANCHOR (see effectiveThresholds below, which is what matching actually uses: each
// profile's real threshold shifts a little from this baseline based on how internally consistent
// its own samples are). Measured directly against this project's own synthetic test voices
// (data/test-audio/diarize-2speaker-ko-en.wav, two distinct Windows SAPI voices): same-speaker
// similarity (repeat runs of identical audio) came out ~1.0, but the two genuinely different
// speakers in that same recording measured 0.757 - an initial 0.75 threshold let them falsely
// match. 0.85 leaves real margin above that measured different-speaker score. Still only
// validated against ONE synthetic voice pair, not a broad set of real human voices - if matches
// feel wrong (never matching, or matching the wrong person), this is the first knob to revisit.
// See knowledge/trouble-shooting.md for how the diarization pipeline was debugged before.
const SIMILARITY_THRESHOLD = 0.85;
// Baseline floor for the agenda-hint tie-breaker only (see matchSpeakerProfile's `hintedName`
// param; also shifted per-profile by effectiveThresholds) - real same-speaker samples measured
// against this project's own registered profiles land as low as 0.856-0.900 across different
// recordings (see knowledge/trouble-shooting.md), well under SIMILARITY_THRESHOLD. This lower
// floor still requires genuine acoustic support before trusting the hint - it's not a rubber
// stamp, just less strict than the blind (no-hint) match.
const RELAXED_SIMILARITY_THRESHOLD = 0.75;
// Minimum lead the top candidate must hold over the runner-up before the relaxed-threshold
// attendee search (below) trusts it. This project's own measured different-speaker score on its
// synthetic 2-voice test file was 0.757 - almost exactly at RELAXED_SIMILARITY_THRESHOLD - so a
// bare floor is not enough to rule out two attendees who are acoustically close; only a clear gap
// between the best and second-best score does that. A genuine same-speaker match against the
// wrong attendee scored ~0.6 apart in live testing, so this margin is comfortably below a real
// match's gap while still rejecting a close call.
const RELAXED_MATCH_MARGIN = 0.15;
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

// Reliability score (0-100) == a profile's own samples agreeing with EACH OTHER, expressed on the
// same 0-100 scale as SIMILARITY_THRESHOLD/RELAXED_SIMILARITY_THRESHOLD (0.85 -> 85) so the number
// stays legible next to those constants. A profile contaminated by someone else's clip (the
// single-mistagged-sample incident this was built to catch: one bad sample scoring 0.31-0.79
// against unrelated speakers) drags every pair it's part of down, so a low score is a direct
// signal to delete and re-register via VoiceProfileManagerModal - registerVoiceProfile only ever
// appends, so this is the only way to tell WHEN that's needed instead of just hoping the
// safety-net margin below catches every case.
// Needs at least 2 samples to have a pair to compare at all; a lone sample gets no score (see
// thresholdAdjustment, which treats that null as neutral - no evidence yet, not evidence of a
// problem).
export function reliabilityScore(embeddings) {
  if (!Array.isArray(embeddings) || embeddings.length < 2) {
    return null;
  }

  let total = 0;
  let pairCount = 0;
  for (let i = 0; i < embeddings.length; i += 1) {
    for (let j = i + 1; j < embeddings.length; j += 1) {
      total += cosineSimilarity(embeddings[i], embeddings[j]);
      pairCount += 1;
    }
  }

  return Math.round((total / pairCount) * 100);
}

// reliabilityScore lands exactly on this, its own effective threshold equals the shared
// SIMILARITY_THRESHOLD/RELAXED_SIMILARITY_THRESHOLD unmodified.
const RELIABILITY_ANCHOR = 85;
// How far a single profile's effective threshold may drift from the shared baseline in either
// direction - kept small and symmetric so one unusually clean or noisy profile can't swing far
// outside the range SIMILARITY_THRESHOLD's own comment was validated against.
const THRESHOLD_ADJUST_RANGE = 0.05;
const THRESHOLD_ADJUST_SLOPE = THRESHOLD_ADJUST_RANGE / (100 - RELIABILITY_ANCHOR);

// Positive return value = easier match (lower effective threshold), negative = stricter. A profile
// with no reliability score yet (fewer than 2 samples) gets the NEUTRAL baseline adjustment (0),
// not the worst case - a lone sample is the normal, expected state right after a user tags
// someone's very first segment, not evidence of a problem. An earlier version of this treated "no
// evidence yet" as "worst case" (strict bar raised to 0.90), reasoning that an unverified profile
// is exactly the kind that produced the single-mistagged-sample false-match incident above - but
// real same-speaker matches routinely score 0.756-0.90 against a profile's own centroid (see
// SIMILARITY_THRESHOLD's comment), so a 0.90 bar rejected most genuine matches for the common case
// of a freshly-registered profile, leaving them stuck unclassified even with several profiles
// already on file (confirmed by the user in live use). The tightening this was meant to provide
// only makes sense once there's actual evidence of inconsistency - i.e. 2+ samples that disagree
// with each other - so it now only ever applies there.
function thresholdAdjustment(score) {
  if (score === null) {
    return 0;
  }
  return Math.max(-THRESHOLD_ADJUST_RANGE, Math.min(THRESHOLD_ADJUST_RANGE, (score - RELIABILITY_ANCHOR) * THRESHOLD_ADJUST_SLOPE));
}

// Per-profile strict/relaxed bar, in place of the one flat threshold every profile used to share.
// The 0.10 gap between strict and relaxed (SIMILARITY_THRESHOLD - RELAXED_SIMILARITY_THRESHOLD)
// stays constant; only where that pair sits moves, based on this one profile's own internal
// consistency (see reliabilityScore above).
function effectiveThresholds(embeddings) {
  const adjust = thresholdAdjustment(reliabilityScore(embeddings));
  return { strict: SIMILARITY_THRESHOLD - adjust, relaxed: RELAXED_SIMILARITY_THRESHOLD - adjust };
}

// Matching priority (confirmed design, see memory-bank/roadmap.md - now: attendees are searched
// FIRST, at their own strict per-profile threshold, before the search ever widens to every stored
// profile - previously a stranger from a totally unrelated meeting could outrank a genuine
// attendee sitting just under the shared flat bar, since only entries that already cleared it were
// ever filtered by attendee membership. Only when no attendee clears their own threshold does the
// search widen to the full registry (e.g. a guest not marked as an attendee in this meeting's
// form).
//
// `hintedName` (optional) is a soft, non-acoustic fallback: the agenda presenter whose planned
// speaking window overlaps most with this speaker's segments (see diarize.mjs's
// hintedPresenterForLabel). It is only ever consulted AFTER the blind (no-hint) search above finds
// nothing - two acoustically similar registered voices can each individually clear the relaxed
// floor against the same sample (measured: two genuinely different stored profiles in this project
// scored 0.896 against each other), so checking the hint first would let a wrong agenda guess
// steal a name away from a confident blind match. Only once the blind search comes up empty does
// the hint get a chance, at that profile's own (lower) relaxed threshold, to recover a
// same-speaker match that fell just short of the strict bar.
// Same matching logic as matchSpeakerProfile, but returns the score alongside the name instead of
// just the name. Exists so a caller matching SEVERAL labels from the SAME recording (see
// diarize.mjs's assignSpeakersWithProfiles and vite.config.mts's /api/voice-profiles/rematch) can
// reconcile cross-label conflicts itself: diarization clustering two labels apart already proves
// they're different people, so if both independently clear the threshold against the same stored
// profile, only the closer-scoring one should actually claim that name - matchSpeakerProfile()
// alone can't express that since it only ever sees one label's embedding at a time.
export async function scoreSpeakerProfileMatch(embedding, meetingAttendeeNames, hintedName) {
  if (!Array.isArray(embedding) || embedding.length === 0) {
    return null;
  }

  const profiles = await readVoiceProfiles();
  if (profiles.length === 0) {
    return null;
  }

  // Each profile gets its own strict/relaxed bar based on how internally consistent its own
  // samples are (see effectiveThresholds/reliabilityScore above) instead of one flat threshold
  // shared by every profile regardless of how trustworthy it actually is.
  const allScored = profiles.map((profile) => {
    const { strict, relaxed } = effectiveThresholds(profile.embeddings);
    return { name: profile.name, score: cosineSimilarity(embedding, meanEmbedding(profile.embeddings)), strict, relaxed };
  });

  const attendeeNames = new Set((meetingAttendeeNames || []).filter(Boolean));

  const attendeeStrictMatches = allScored
    .filter((entry) => attendeeNames.has(entry.name) && entry.score >= entry.strict)
    .sort((a, b) => b.score - a.score);
  if (attendeeStrictMatches.length > 0) {
    return attendeeStrictMatches[0];
  }

  const anyStrictMatches = allScored.filter((entry) => entry.score >= entry.strict).sort((a, b) => b.score - a.score);
  if (anyStrictMatches.length > 0) {
    return anyStrictMatches[0];
  }

  if (hintedName) {
    const hinted = allScored.find((entry) => entry.name === hintedName);
    if (hinted && hinted.score >= hinted.relaxed) {
      return hinted;
    }
  }

  // Same-speaker, different-utterance clips routinely score 0.77-0.79 in this project's own
  // measurements (well under SIMILARITY_THRESHOLD) once a profile only has a couple of short
  // samples - live-tested via /api/voice-profiles/classify-clips, which never passes a
  // hintedName, so without this the strict bar rejected every genuinely-correct match and
  // bar helps, but is NOT sufficient on its own - two attendees can plausibly sound closer to each
  // other than the 0.757 different-speaker score already measured on this project's own test file
  // (see RELAXED_SIMILARITY_THRESHOLD's comment). The RELAXED_MATCH_MARGIN check below is the real
  // safeguard: only trust the top attendee candidate when it clearly beats every other profile
  // (attendee or not), not merely when it clears the floor.
  const attendeeRelaxed = allScored
    .filter((entry) => attendeeNames.has(entry.name) && entry.score >= entry.relaxed)
    .sort((a, b) => b.score - a.score);
  if (attendeeRelaxed.length > 0) {
    const top = attendeeRelaxed[0];
    const secondBest = allScored
      .filter((entry) => entry.name !== top.name)
      .sort((a, b) => b.score - a.score)[0];
    const margin = secondBest ? top.score - secondBest.score : Infinity;
    if (margin >= RELAXED_MATCH_MARGIN) {
      return top;
    }
  }

  return null;
}

export async function matchSpeakerProfile(embedding, meetingAttendeeNames, hintedName) {
  const match = await scoreSpeakerProfileMatch(embedding, meetingAttendeeNames, hintedName);
  return match?.name ?? null;
}

// Registers a brand-new profile, or reinforces an existing one with another sample - called both
// automatically (a fresh sample from a confirmed profile match) and on user action (renaming a
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

// Removes a profile entirely (all of its accumulated samples). registerVoiceProfile above only
// ever appends - it has no way to walk back a wrongly-tagged sample, so this is the recovery path
// for a contaminated profile (e.g. a segment mistakenly tagged with someone else's name). Returns
// true if a profile with this name existed and was removed.
export async function deleteVoiceProfile(name) {
  if (!name) {
    return false;
  }

  const profiles = await readVoiceProfiles();
  const next = profiles.filter((profile) => profile.name !== name);
  if (next.length === profiles.length) {
    return false;
  }

  await writeVoiceProfiles(next);

  return true;
}
