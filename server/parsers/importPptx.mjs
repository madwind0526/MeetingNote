import JSZip from "jszip";
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

// Third-party notes sometimes space out label characters for visual alignment (e.g. "제 목",
// "주 관", "장 소") - stripping all whitespace (including fullwidth U+3000) before comparing lets
// "제 목" still match "제목".
function normalizeLabel(label) {
  return label.replace(/[\s　]+/g, "");
}

// Only used when the combined slide text contains a recognizable "제목:" label line - unlike the
// PDF/docx parsers, plain slide-shaped decks (no labels) get a slide-aware fallback instead of
// this function's generic one, see parsePptxMeeting below. Returns null when no label is found.
function parseLabeledMeetingText(rawText) {
  const lines = rawText.replace(/\r\n/g, "\n").split("\n");
  const titleLineIndex = lines.findIndex((line) => {
    const match = LABEL_LINE_RE.exec(line.trim());
    return match ? normalizeLabel(match[1]) === "제목" : false;
  });

  if (titleLineIndex === -1) {
    return null;
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

// A .pptx is a zip of XML parts. Slide text lives in ppt/slides/slideN.xml, grouped into <a:p>
// paragraphs that each hold one or more <a:t> runs (formatting boundaries like bold split a line
// into several runs). Runs within a paragraph are concatenated with no separator, but paragraphs
// are joined with "\n" instead of flattened onto one line - otherwise a title slide that stacks
// "날짜: .../시작: .../장소: .../참석자: ..." as separate lines collapses into a single
// space-joined line that parseLabeledMeetingText's line-by-line "라벨: 값" matching can't recover
// individual fields from. A regex is enough to pull this out - a full XML/OOXML parser would be
// overkill here.
function slideXmlToText(xml) {
  const paragraphs = [...xml.matchAll(/<a:p>[\s\S]*?<\/a:p>/g)];
  if (paragraphs.length === 0) {
    return "";
  }

  return paragraphs
    .map((paragraphMatch) => [...paragraphMatch[0].matchAll(/<a:t>([^<]*)</g)].map((match) => match[1]).join(""))
    .join("\n")
    .trim();
}

async function extractSlideTexts(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideNumberOf = (name) => Number(/slide(\d+)\.xml$/.exec(name)[1]);
  const slideEntryNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumberOf(a) - slideNumberOf(b));

  const texts = [];
  for (const name of slideEntryNames) {
    const xml = await zip.files[name].async("string");
    texts.push(slideXmlToText(xml));
  }

  return texts;
}

export async function parsePptxMeeting(buffer) {
  const slideTexts = await extractSlideTexts(buffer);

  if (slideTexts.length === 0 || slideTexts.every((text) => !text.trim())) {
    return [];
  }

  const labeled = parseLabeledMeetingText(slideTexts.join("\n"));
  if (labeled) {
    return [labeled];
  }

  // Fallback for decks that don't use our label format: first slide's first line becomes the
  // title, and all slide text (each slide prefixed with its slide number) becomes the minutes.
  const draft = emptyDraft();
  draft.title = (slideTexts[0] || "").trim();
  draft.minutes = slideTexts.map((text, index) => `## 슬라이드 ${index + 1}\n${text}`).join("\n\n").trim();

  return [draft];
}
