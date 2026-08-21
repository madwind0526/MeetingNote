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

// Longest-from-first so a longer phrase (e.g. "REST API") is substituted before a shorter one
// that could shadow part of it (e.g. "API") - otherwise the shorter rule fires first and mangles
// the longer phrase's match.
export function applyEntriesToText(text, entries) {
  const sorted = entries.filter((entry) => entry.from).sort((a, b) => b.from.length - a.from.length);
  let result = text;

  for (const entry of sorted) {
    result = result.split(entry.from).join(entry.to);
  }

  return result;
}

export function applyDictionaryToSegments(segments, abbreviations, corrections) {
  const entries = [...abbreviations, ...corrections];

  return segments.map((segment) => ({ ...segment, text: applyEntriesToText(segment.text, entries) }));
}

// Retroactive "적용하기" action - re-runs the current dictionary over every meeting that already
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
