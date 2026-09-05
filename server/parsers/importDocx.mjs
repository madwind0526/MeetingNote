import mammoth from "mammoth";
import { randomUUID } from "node:crypto";

// Duplicated from importPdf.mjs on purpose - each parser file stays small and self-contained
// (same convention as PhoneBook's parsers) rather than sharing a parsing module.
const LABEL_LINE_RE = /^([^:：]+)[:：]\s*(.*)$/;
const AGENDA_LINE_RE = /^(\d+)\.\s*(.+?)\s*\(발표시간:\s*(\d+)\s*분\s*,\s*발표자:\s*([^,]*),\s*자료:\s*(.*)\)\s*$/;
const ACTION_LINE_RE = /^(\d+)\.\s*(.+?)\s*\(발표자료:\s*([^,]*),\s*발표자:\s*(.*)\)\s*$/;

function makeAttendee(name) {
  return {
    id: randomUUID(),
    name: name.trim(),
    role: "",
    isKeyAttendee: false,
    isPresenter: false
  };
}

function emptyDraft() {
  return {
    title: "",
    date: "",
    startTime: "",
    endTime: "",
    location: "",
    organizer: "",
    secretary: "",
    attendees: [],
    actionItems: [],
    agenda: [],
    audio: null,
    minutes: ""
  };
}

function normalizeLabel(label) {
  return label.replace(/[\s　]+/g, "");
}

// Best-effort only: reliably round-trips the plain text mammoth extracts from a .docx that used
// PDF export uses. Arbitrary third-party .docx files fall back to a plain title/minutes split.
function parseMeetingText(rawText) {
  const lines = rawText.replace(/\r\n/g, "\n").split("\n");
  const titleLineIndex = lines.findIndex((line) => {
    const match = LABEL_LINE_RE.exec(line.trim());
    return match ? normalizeLabel(match[1]) === "제목" : false;
  });

  if (titleLineIndex === -1) {
    const firstNonEmptyIndex = lines.findIndex((line) => line.trim());
    if (firstNonEmptyIndex === -1) {
      return null;
    }

    const draft = emptyDraft();
    draft.title = lines[firstNonEmptyIndex].trim();
    draft.minutes = lines.slice(firstNonEmptyIndex + 1).join("\n").trim();
    return draft;
  }

  const draft = emptyDraft();
  const minutesLines = [];
  let section = "header";

  for (let i = titleLineIndex; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed && /^Agenda\s*$/i.test(trimmed)) {
      section = "agenda";
      continue;
    }
    if (trimmed && /^A\/I\s*List\s*$/i.test(trimmed)) {
      section = "actionItems";
      continue;
    }
    if (trimmed && /^회의록\s*$/.test(trimmed)) {
      section = "minutes";
      continue;
    }

    if (section === "minutes") {
      minutesLines.push(line);
      continue;
    }

    if (!trimmed) {
      continue;
    }

    if (section === "header") {
      const match = LABEL_LINE_RE.exec(trimmed);
      if (!match) {
        continue;
      }

      const label = normalizeLabel(match[1]);
      const value = match[2].trim();

      if (label === "제목") {
        draft.title = value;
      } else if (label === "날짜") {
        draft.date = value;
      } else if (label === "시작") {
        draft.startTime = value;
      } else if (label === "종료") {
        draft.endTime = value;
      } else if (label === "일시") {
        const combined = /^(\S+)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(value);
        if (combined) {
          draft.date = combined[1];
          draft.startTime = combined[2];
          draft.endTime = combined[3];
        } else {
          draft.date = value;
        }
      } else if (label === "장소") {
        draft.location = value;
      } else if (label === "주관자" || label === "주관") {
        draft.organizer = value;
      } else if (label === "간사") {
        draft.secretary = value;
      } else if (label === "참석자" || label === "참석") {
        draft.attendees = value.split(",").map((name) => name.trim()).filter(Boolean).map(makeAttendee);
      }
    } else if (section === "agenda") {
      const match = AGENDA_LINE_RE.exec(trimmed);
      if (match) {
        draft.agenda.push({
          no: Number(match[1]),
          title: match[2].trim(),
          durationMinutes: Number(match[3]),
          presenter: match[4].trim(),
          material: match[5].trim()
        });
      }
    } else if (section === "actionItems") {
      const match = ACTION_LINE_RE.exec(trimmed);
      if (match) {
        draft.actionItems.push({
          no: Number(match[1]),
          title: match[2].trim(),
          material: match[3].trim(),
          presenter: match[4].trim()
        });
      }
    }
  }

  draft.minutes = minutesLines.join("\n").trim();
  return draft;
}

export async function parseDocxMeeting(buffer) {
  const { value } = await mammoth.extractRawText({ buffer });

  if (!value || !value.trim()) {
    return [];
  }

  const draft = parseMeetingText(value);
  return draft ? [draft] : [];
}
