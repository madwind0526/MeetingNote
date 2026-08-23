import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, "data/db/meetings.json");
const SEED_PATH = path.join(ROOT, "data/seed/meetings.sample.json");

async function ensureDb() {
  try {
    await readFile(DB_PATH, "utf8");
  } catch {
    await mkdir(path.dirname(DB_PATH), { recursive: true });

    let seedMeetings = [];
    try {
      seedMeetings = JSON.parse(await readFile(SEED_PATH, "utf8"));
    } catch {
      seedMeetings = [];
    }

    await writeFile(DB_PATH, JSON.stringify(seedMeetings, null, 2), "utf8");
  }
}

export async function readMeetings() {
  await ensureDb();
  const raw = await readFile(DB_PATH, "utf8");
  const meetings = JSON.parse(raw);

  // Backfills fields added after meetings.json already had records - keeps every caller's shape
  // consistent without rewriting the underlying file until the record is next saved.
  return meetings.map((meeting) => ({
    ...meeting,
    secretary: meeting.secretary ?? "",
    authorId: meeting.authorId ?? "",
    comments: Array.isArray(meeting.comments) ? meeting.comments : []
  }));
}

async function writeMeetings(meetings) {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  await writeFile(DB_PATH, JSON.stringify(meetings, null, 2), "utf8");
}

function normalizeAttendee(draft) {
  const source = draft && typeof draft === "object" ? draft : {};

  return {
    id: source.id || randomUUID(),
    name: source.name ?? "",
    role: source.role ?? "",
    isKeyAttendee: Boolean(source.isKeyAttendee),
    isPresenter: Boolean(source.isPresenter)
  };
}

function normalizeMaterialPath(materialPath) {
  return typeof materialPath === "string" && materialPath.trim() ? materialPath : undefined;
}

function normalizeActionItem(draft, index) {
  const source = draft && typeof draft === "object" ? draft : {};
  const no = Number(source.no);

  return {
    no: Number.isFinite(no) ? no : index + 1,
    title: source.title ?? "",
    material: source.material ?? "",
    materialPath: normalizeMaterialPath(source.materialPath),
    materialMdPath: normalizeMaterialPath(source.materialMdPath),
    presenter: source.presenter ?? ""
  };
}

function normalizeAgendaItem(draft, index) {
  const source = draft && typeof draft === "object" ? draft : {};
  const no = Number(source.no);
  const durationMinutes = Number(source.durationMinutes);

  return {
    no: Number.isFinite(no) ? no : index + 1,
    title: source.title ?? "",
    durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : 0,
    material: source.material ?? "",
    materialPath: normalizeMaterialPath(source.materialPath),
    materialMdPath: normalizeMaterialPath(source.materialMdPath),
    presenter: source.presenter ?? "",
    presentationSummary: typeof source.presentationSummary === "string" && source.presentationSummary.trim() ? source.presentationSummary : undefined
  };
}

function normalizeComment(draft) {
  const source = draft && typeof draft === "object" ? draft : {};

  return {
    id: source.id || randomUUID(),
    authorId: source.authorId ?? "",
    content: source.content ?? "",
    createdAt: source.createdAt || new Date().toISOString()
  };
}

function normalizeTranscriptSegment(draft) {
  const source = draft && typeof draft === "object" ? draft : {};
  const startSec = Number(source.startSec);
  const endSec = Number(source.endSec);

  return {
    speaker: source.speaker ?? "",
    startSec: Number.isFinite(startSec) ? startSec : 0,
    endSec: Number.isFinite(endSec) ? endSec : 0,
    text: source.text ?? ""
  };
}

function normalizeAudio(draft) {
  if (!draft || typeof draft !== "object") {
    return null;
  }

  const durationSec = Number(draft.durationSec);
  const preprocessingSource = draft.preprocessing && typeof draft.preprocessing === "object" ? draft.preprocessing : {};

  return {
    fileName: draft.fileName ?? "",
    durationSec: Number.isFinite(durationSec) ? durationSec : 0,
    preprocessing: {
      vocalIsolation: Boolean(preprocessingSource.vocalIsolation),
      noiseRemoval: Boolean(preprocessingSource.noiseRemoval),
      normalize: Boolean(preprocessingSource.normalize)
    },
    transcriptSegments: Array.isArray(draft.transcriptSegments) ? draft.transcriptSegments.map((segment) => normalizeTranscriptSegment(segment)) : [],
    speakerMap: draft.speakerMap && typeof draft.speakerMap === "object" ? draft.speakerMap : {},
    analyzedAt: draft.analyzedAt ?? "",
    audioPath: typeof draft.audioPath === "string" && draft.audioPath.trim() ? draft.audioPath : undefined,
    transcriptPath: typeof draft.transcriptPath === "string" && draft.transcriptPath.trim() ? draft.transcriptPath : undefined
  };
}

// Clamps an out-of-range day (e.g. "2026-08-35", or "2026-02-30" after switching month on an
// already-set day) to the nearest real day of that month instead of persisting a calendar date
// that doesn't exist - month is clamped the same way. Anything not shaped like YYYY-MM-DD (empty
// string, partially-typed value, ...) passes through untouched.
function clampToNearestValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) {
    return value ?? "";
  }

  const year = Number(match[1]);
  const month = Math.min(12, Math.max(1, Number(match[2])));
  const maxDay = new Date(year, month, 0).getDate();
  const day = Math.min(maxDay, Math.max(1, Number(match[3])));

  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function normalizeMeeting(draft) {
  const source = draft && typeof draft === "object" ? draft : {};

  return {
    title: source.title ?? "",
    date: clampToNearestValidDate(source.date ?? ""),
    startTime: source.startTime ?? "",
    endTime: source.endTime ?? "",
    organizer: source.organizer ?? "",
    secretary: source.secretary ?? "",
    attendees: Array.isArray(source.attendees) ? source.attendees.map((attendee) => normalizeAttendee(attendee)) : [],
    actionItems: Array.isArray(source.actionItems) ? source.actionItems.map((item, index) => normalizeActionItem(item, index)) : [],
    agenda: Array.isArray(source.agenda) ? source.agenda.map((item, index) => normalizeAgendaItem(item, index)) : [],
    audio: normalizeAudio(source.audio),
    minutes: source.minutes ?? "",
    authorId: source.authorId ?? "",
    comments: Array.isArray(source.comments) ? source.comments.map((comment) => normalizeComment(comment)) : []
  };
}

export async function createMeeting(draft) {
  const meetings = await readMeetings();
  const now = new Date().toISOString();
  // Honors a client-supplied id when present (MeetingFormModal generates one up front so
  // attachments uploaded before the first save land in the same folder the saved meeting ends up
  // owning - see cloneDraft's folderId) - falls back to a fresh id otherwise, and also falls back
  // if the supplied id happens to collide with an existing meeting.
  const requestedId = typeof draft?.id === "string" ? draft.id.trim() : "";
  const id = requestedId && !meetings.some((item) => item.id === requestedId) ? requestedId : randomUUID();
  const meeting = {
    id,
    ...normalizeMeeting(draft),
    createdAt: now,
    updatedAt: now
  };

  meetings.push(meeting);
  await writeMeetings(meetings);

  return meeting;
}

export async function updateMeeting(id, patch) {
  const meetings = await readMeetings();
  const index = meetings.findIndex((item) => item.id === id);

  if (index === -1) {
    return null;
  }

  const updated = {
    ...meetings[index],
    ...normalizeMeeting({ ...meetings[index], ...patch }),
    id: meetings[index].id,
    createdAt: meetings[index].createdAt,
    updatedAt: new Date().toISOString()
  };

  meetings[index] = updated;
  await writeMeetings(meetings);

  return updated;
}

export async function addMeetingComment(meetingId, draft) {
  const meetings = await readMeetings();
  const index = meetings.findIndex((item) => item.id === meetingId);

  if (index === -1) {
    return null;
  }

  const comment = normalizeComment({ ...draft, id: undefined, createdAt: undefined });
  const updated = {
    ...meetings[index],
    comments: [...meetings[index].comments, comment],
    updatedAt: new Date().toISOString()
  };

  meetings[index] = updated;
  await writeMeetings(meetings);

  return updated;
}

export async function deleteMeetingComment(meetingId, commentId) {
  const meetings = await readMeetings();
  const index = meetings.findIndex((item) => item.id === meetingId);

  if (index === -1) {
    return null;
  }

  const updated = {
    ...meetings[index],
    comments: meetings[index].comments.filter((comment) => comment.id !== commentId),
    updatedAt: new Date().toISOString()
  };

  meetings[index] = updated;
  await writeMeetings(meetings);

  return updated;
}

export async function deleteMeeting(id) {
  const meetings = await readMeetings();
  const next = meetings.filter((item) => item.id !== id);

  await writeMeetings(next);

  return next.length !== meetings.length;
}

function normalizeDuplicateMode(mode) {
  return mode === "add" || mode === "skip" || mode === "replace" ? mode : "replace";
}

// Meetings have no unique contact-like key (no email/phone), so duplicates are matched by
// normalized title (trimmed, case-insensitive) + exact date equality. An empty title+date pair
// never counts as a match, so a batch of blank drafts doesn't collapse into a single row.
function duplicateKey(title, date) {
  const normalizedTitle = String(title ?? "").trim().toLowerCase();
  const normalizedDate = String(date ?? "").trim();

  if (!normalizedTitle && !normalizedDate) {
    return null;
  }

  return `${normalizedTitle}__${normalizedDate}`;
}

export async function bulkUpsertMeetings(drafts, duplicateMode = "replace") {
  const meetings = await readMeetings();
  const now = new Date().toISOString();
  const mode = normalizeDuplicateMode(duplicateMode);
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  for (const draft of drafts) {
    const normalized = normalizeMeeting(draft);
    const key = duplicateKey(normalized.title, normalized.date);
    const existingIndex = key === null ? -1 : meetings.findIndex((item) => duplicateKey(item.title, item.date) === key);

    if (existingIndex !== -1 && mode === "skip") {
      skippedCount += 1;
      continue;
    }

    if (existingIndex === -1 || mode === "add") {
      meetings.push({
        id: randomUUID(),
        ...normalized,
        createdAt: now,
        updatedAt: now
      });
      createdCount += 1;
    } else {
      const existing = meetings[existingIndex];

      meetings[existingIndex] = {
        ...existing,
        ...normalized,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: now
      };
      updatedCount += 1;
    }
  }

  await writeMeetings(meetings);

  return { createdCount, updatedCount, skippedCount, total: meetings.length };
}

export async function resetToSeed() {
  let seedMeetings = [];
  try {
    seedMeetings = JSON.parse(await readFile(SEED_PATH, "utf8"));
  } catch {
    seedMeetings = [];
  }

  await writeMeetings(seedMeetings);

  return seedMeetings;
}
