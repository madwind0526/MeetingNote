import pdfParse from "pdf-parse/lib/pdf-parse.js";
import { randomUUID } from "node:crypto";

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
    organizer: "",
    attendees: [],
    actionItems: [],
    agenda: [],
    audio: null,
    minutes: ""
  };
}

// Best-effort only: this reliably round-trips text produced by our own PDF export
// (exportPdf.mjs), which writes one "제목:/날짜:/시작:/종료:/주관자:/참석자:" header block per
// meeting followed by "Agenda", "A/I List" and "회의록" sections. Arbitrary third-party PDFs are
// not guaranteed to parse - PDF has no structured field data, only laid-out text - so if none of
// the expected labels are found this falls back to a plain title/minutes split.
export function parseMeetingText(rawText) {
  const lines = rawText.replace(/\r\n/g, "\n").split("\n");
  const titleLineIndex = lines.findIndex((line) => /^\s*제목\s*[:：]/.test(line));

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

      const label = match[1].trim();
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
        // Fallback combined form some 3rd-party exports use: "일시: 2024-01-01 10:00-11:00".
        const combined = /^(\S+)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(value);
        if (combined) {
          draft.date = combined[1];
          draft.startTime = combined[2];
          draft.endTime = combined[3];
        } else {
          draft.date = value;
        }
      } else if (label === "주관자") {
        draft.organizer = value;
      } else if (label === "참석자") {
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

export async function parsePdfMeeting(buffer) {
  const { text } = await pdfParse(buffer);

  if (!text || !text.trim()) {
    return [];
  }

  const draft = parseMeetingText(text);
  return draft ? [draft] : [];
}
