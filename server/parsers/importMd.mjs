import { randomUUID } from "node:crypto";

// Duplicated from importPdf.mjs / importDocx.mjs on purpose - each parser file stays small and
// self-contained (same convention as PhoneBook's parsers) rather than sharing a parsing module.
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

// Strips common Markdown decoration (heading #, bullet -/*, bold **) so the same label-line
// parsing used by the PDF/Word importers also works on Markdown text. Pairs with the headings
// exportMd.mjs writes.
function stripMdSyntax(line) {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .trim();
}

// Best-effort only: reliably round-trips Markdown produced by our own export (exportMd.mjs),
// guaranteed to have those labels, so this falls back to a plain title/minutes split when neither
function parseSingleMeeting(rawText) {
  const rawLines = rawText.replace(/\r\n/g, "\n").split("\n");
  const firstContentIndex = rawLines.findIndex((line) => line.trim());

  if (firstContentIndex === -1) {
    return null;
  }

  const isHeading = /^#\s+(.+)/.test(rawLines[firstContentIndex]);
  const hasLabelHeader = rawLines.slice(firstContentIndex).some((line) => {
    const match = LABEL_LINE_RE.exec(stripMdSyntax(line));
    return match ? normalizeLabel(match[1]) === "제목" : false;
  });

  if (!isHeading && !hasLabelHeader) {
    const draft = emptyDraft();
    draft.title = stripMdSyntax(rawLines[firstContentIndex]);
    draft.minutes = rawLines.slice(firstContentIndex + 1).join("\n").trim();
    return draft;
  }

  const draft = emptyDraft();
  if (isHeading) {
    draft.title = stripMdSyntax(rawLines[firstContentIndex]);
  }

  const minutesLines = [];
  let section = "header";

  for (let i = firstContentIndex + (isHeading ? 1 : 0); i < rawLines.length; i += 1) {
    const trimmed = stripMdSyntax(rawLines[i]);

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
      minutesLines.push(rawLines[i]);
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

export function parseMdMeeting(buffer) {
  const text = buffer.toString("utf8");

  if (!text.trim()) {
    return [];
  }

  // Our own export (exportMd.mjs) separates multiple meetings with a "---" horizontal rule.
  const chunks = text.split(/\n-{3,}\n/);
  return chunks.map((chunk) => parseSingleMeeting(chunk)).filter(Boolean);
}
