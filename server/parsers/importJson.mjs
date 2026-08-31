import { randomUUID } from "node:crypto";

// db.mjs normalizes everything anyway, but keep this reasonably shaped so the import preview
// (shown before the user confirms) already looks like a real MeetingDraft.
function toAttendee(item) {
  if (typeof item === "string") {
    return { id: randomUUID(), name: item.trim(), role: "", isKeyAttendee: false, isPresenter: false };
  }

  const source = item && typeof item === "object" ? item : {};

  return {
    id: typeof source.id === "string" && source.id ? source.id : randomUUID(),
    name: typeof source.name === "string" ? source.name : "",
    role: typeof source.role === "string" ? source.role : "",
    isKeyAttendee: Boolean(source.isKeyAttendee),
    isPresenter: Boolean(source.isPresenter)
  };
}

function toAgendaItem(item, index) {
  const source = item && typeof item === "object" ? item : {};

  return {
    no: typeof source.no === "number" ? source.no : index + 1,
    title: typeof source.title === "string" ? source.title : "",
    durationMinutes: typeof source.durationMinutes === "number" ? source.durationMinutes : 10,
    material: typeof source.material === "string" ? source.material : "",
    presenter: typeof source.presenter === "string" ? source.presenter : ""
  };
}

function toActionItem(item, index) {
  const source = item && typeof item === "object" ? item : {};

  return {
    no: typeof source.no === "number" ? source.no : index + 1,
    title: typeof source.title === "string" ? source.title : "",
    material: typeof source.material === "string" ? source.material : "",
    presenter: typeof source.presenter === "string" ? source.presenter : ""
  };
}

function toMeetingDraft(item) {
  const source = item && typeof item === "object" ? item : {};

  return {
    title: typeof source.title === "string" ? source.title : "",
    date: typeof source.date === "string" ? source.date : "",
    startTime: typeof source.startTime === "string" ? source.startTime : "",
    endTime: typeof source.endTime === "string" ? source.endTime : "",
    location: typeof source.location === "string" ? source.location : "",
    organizer: typeof source.organizer === "string" ? source.organizer : "",
    secretary: typeof source.secretary === "string" ? source.secretary : "",
    attendees: Array.isArray(source.attendees) ? source.attendees.map(toAttendee) : [],
    actionItems: Array.isArray(source.actionItems) ? source.actionItems.map(toActionItem) : [],
    agenda: Array.isArray(source.agenda) ? source.agenda.map(toAgendaItem) : [],
    audio: source.audio && typeof source.audio === "object" ? source.audio : null,
    minutes: typeof source.minutes === "string" ? source.minutes : ""
  };
}

// Accepts either this app's own export shape ({ meetings: [...] }, see exportJson.mjs) or a bare
// array of meeting-like objects. Lenient by design - this only feeds an import preview, so
// missing fields default rather than throw.
export function parseJsonMeetings(buffer) {
  const parsed = JSON.parse(buffer.toString("utf8"));
  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.meetings) ? parsed.meetings : [];

  return items.map(toMeetingDraft);
}
