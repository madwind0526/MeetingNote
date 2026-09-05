import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readMeetings, updateMeeting } from "./db.mjs";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, "data/db/dictionary.json");
const EMPTY_DICTIONARY = { abbreviations: [], corrections: [] };

async function ensureDb() {
  try {
    await readFile(DB_PATH, "utf8");
  } catch {
    await mkdir(path.dirname(DB_PATH), { recursive: true });
    await writeFile(DB_PATH, JSON.stringify(EMPTY_DICTIONARY, null, 2), "utf8");
  }
}

function normalizeEntry(draft) {
  const source = draft && typeof draft === "object" ? draft : {};

  return {
    id: source.id || randomUUID(),
    from: source.from ?? "",
    to: source.to ?? "",
    description: source.description ?? ""
  };
}

function normalizeDictionary(draft) {
  const source = draft && typeof draft === "object" ? draft : {};

  return {
    abbreviations: Array.isArray(source.abbreviations) ? source.abbreviations.map((entry) => normalizeEntry(entry)) : [],
    corrections: Array.isArray(source.corrections) ? source.corrections.map((entry) => normalizeEntry(entry)) : []
  };
}

export async function readDictionary() {
  await ensureDb();
  const raw = await readFile(DB_PATH, "utf8");

  return normalizeDictionary(JSON.parse(raw));
}

export async function writeDictionary(draft) {
  const normalized = normalizeDictionary(draft);

  await mkdir(path.dirname(DB_PATH), { recursive: true });
  await writeFile(DB_PATH, JSON.stringify(normalized, null, 2), "utf8");

  return normalized;
}

// Script-aware boundary check, NOT a plain \p{L}/\p{N} check: a first cut at this blocked any
// adjacent letter (Latin or Hangul) on either side, which correctly stopped "CD" from matching
// grammar attaches particles directly to a preceding word with no space, so an English acronym
// immediately followed by a Hangul particle is completely normal and has to still match. The rule
// that actually captures "this is a different term" vs "this is the same acronym plus a Korean
// particle" is same-script continuation: block only when the touching character is in the SAME
// script class (Latin+Latin or Hangul+Hangul) as the entry's own boundary character; a different
// script on the other side (Latin entry butting into Hangul, or vice versa) is always a safe
// boundary.
function scriptCategory(char) {
  if (!char) {
    return null;
  }
  if (/[A-Za-z0-9]/.test(char)) {
    return "latin";
  }
  if (/\p{Script=Hangul}/u.test(char)) {
    return "hangul";
  }
  return null;
}

const KOREAN_PARTICLES = [
  "이라고는", "이라고", "라고는", "라고", "이라서", "라서", "이라는", "라는", "이란", "란",
  "에게서", "한테서", "부터는", "까지는", "에서는", "으로는", "로는",
  "이지만", "인데도", "이면서", "으로써", "로써", "으로서", "로서",
  "에게", "한테", "부터", "까지", "에서", "으로", "처럼", "만큼", "보다",
  "이나", "이랑", "하고", "이며", "이고", "인지", "인데", "입니다", "이다", "였다",
  "은", "는", "이", "가", "을", "를", "의", "에", "로", "와", "과", "도", "만", "나", "랑", "들"
];

function startsWithKoreanParticle(text) {
  return KOREAN_PARTICLES.some((particle) => text.startsWith(particle));
}

function isWholeMatch(text, from, index) {
  const fromFirstCategory = scriptCategory(from[0]);
  const fromLastCategory = scriptCategory(from[from.length - 1]);
  const before = index > 0 ? text[index - 1] : null;
  const matchEnd = index + from.length;
  const after = matchEnd < text.length ? text[matchEnd] : null;
  const blockedBefore = fromFirstCategory !== null && scriptCategory(before) === fromFirstCategory;
  const sameScriptAfter = fromLastCategory !== null && scriptCategory(after) === fromLastCategory;
  const blockedAfter = sameScriptAfter && !(fromLastCategory === "hangul" && startsWithKoreanParticle(text.slice(matchEnd)));

  return !blockedBefore && !blockedAfter;
}

// Longest-from-first, and every entry matches against the ORIGINAL text only - never against a
// result some earlier entry already rewrote. Applying entries one at a time over an accumulating
// "AI (Artificial Intelligence)" would then have its "AI" caught by a separate, shorter "AI" ->
// "Artificial Intelligence" entry, producing "Artificial Intelligence (Artificial Intelligence)".
// Collecting every entry's matches against the same original text and merging them into one pass
// (longer entries claim their span first, so a shorter entry can never match inside a span a
// longer one already took) avoids that entirely.
export function applyEntriesToText(text, entries) {
  const sorted = entries.filter((entry) => entry.from).sort((a, b) => b.from.length - a.from.length);
  const claimed = []; // [start, end) ranges already taken by an earlier (longer) entry's match
  const matches = [];

  const isFree = (start, end) => !claimed.some(([claimedStart, claimedEnd]) => start < claimedEnd && end > claimedStart);

  for (const entry of sorted) {
    let searchFrom = 0;
    for (;;) {
      const index = text.indexOf(entry.from, searchFrom);
      if (index === -1) {
        break;
      }
      const matchEnd = index + entry.from.length;
      searchFrom = index + 1;

      if (isFree(index, matchEnd) && isWholeMatch(text, entry.from, index)) {
        matches.push({ start: index, end: matchEnd, to: entry.to });
        claimed.push([index, matchEnd]);
      }
    }
  }

  matches.sort((a, b) => a.start - b.start);

  let result = "";
  let cursor = 0;
  for (const match of matches) {
    result += text.slice(cursor, match.start) + match.to;
    cursor = match.end;
  }
  result += text.slice(cursor);

  return result;
}

export function applyDictionaryToSegments(segments, abbreviations, corrections) {
  const entries = [...abbreviations, ...corrections];

  return segments.map((segment) => ({ ...segment, text: applyEntriesToText(segment.text, entries) }));
}

// has a transcript, not just newly-analyzed ones (see applyDictionaryToSegments, which is what the
// STT pipeline itself calls right after transcription for the automatic, forward-going case).
export async function applyDictionaryToAllMeetings() {
  const dictionary = await readDictionary();
  const meetings = await readMeetings();
  let updatedCount = 0;

  for (const meeting of meetings) {
    if (meeting.audio && Array.isArray(meeting.audio.transcriptSegments) && meeting.audio.transcriptSegments.length > 0) {
      const nextSegments = applyDictionaryToSegments(meeting.audio.transcriptSegments, dictionary.abbreviations, dictionary.corrections);
      await updateMeeting(meeting.id, { audio: { ...meeting.audio, transcriptSegments: nextSegments } });
      updatedCount += 1;
    }
  }

  return updatedCount;
}
