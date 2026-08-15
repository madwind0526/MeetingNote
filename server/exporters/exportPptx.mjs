import pptxgen from "pptxgenjs";

const MINUTES_CHUNK_SIZE = 1200;
const HEADER_FILL = "E5E5E5";
const TABLE_OPTIONS = { x: 0.4, y: 1.0, w: 9.2, fontSize: 11, autoPage: true };

function attendeeNamesOf(meeting) {
  return (meeting.attendees ?? []).map((attendee) => attendee.name).filter(Boolean).join(", ");
}

function headerRow(labels) {
  return labels.map((text) => ({ text, options: { bold: true, fill: { color: HEADER_FILL } } }));
}

function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function addTitleSlide(pptx, meeting) {
  const slide = pptx.addSlide();

  slide.addText(meeting.title || "(제목 없음)", { x: 0.5, y: 0.6, w: 9, h: 1, fontSize: 28, bold: true });
  slide.addText(
    [
      { text: `날짜: ${meeting.date || "-"}\n`, options: { fontSize: 14 } },
      { text: `시간: ${meeting.startTime || "-"} ~ ${meeting.endTime || "-"}\n`, options: { fontSize: 14 } },
      { text: `주관자: ${meeting.organizer || "-"}\n`, options: { fontSize: 14 } },
      { text: `참석자: ${attendeeNamesOf(meeting) || "-"}`, options: { fontSize: 14 } }
    ],
    { x: 0.5, y: 2.0, w: 9, h: 2.5, valign: "top" }
  );
}

function addAgendaSlide(pptx, agenda) {
  const slide = pptx.addSlide();
  slide.addText("Agenda", { x: 0.4, y: 0.35, w: 9, h: 0.6, fontSize: 22, bold: true });

  if (agenda.length === 0) {
    slide.addText("(없음)", { x: 0.4, y: 1.0, w: 9, h: 0.5, fontSize: 12 });
    return;
  }

  const rows = [
    headerRow(["No", "제목", "발표시간", "발표자료", "발표자"]),
    ...agenda.map((item) => [
      String(item.no ?? ""),
      item.title || "-",
      `${item.durationMinutes ?? 0}분`,
      item.material || "-",
      item.presenter || "-"
    ])
  ];

  slide.addTable(rows, { ...TABLE_OPTIONS, colW: [0.6, 3.6, 1.3, 2.1, 1.6] });
}

function addActionItemSlide(pptx, actionItems) {
  const slide = pptx.addSlide();
  slide.addText("A/I List", { x: 0.4, y: 0.35, w: 9, h: 0.6, fontSize: 22, bold: true });

  if (actionItems.length === 0) {
    slide.addText("(없음)", { x: 0.4, y: 1.0, w: 9, h: 0.5, fontSize: 12 });
    return;
  }

  const rows = [
    headerRow(["No", "제목", "발표자료", "발표자"]),
    ...actionItems.map((item) => [String(item.no ?? ""), item.title || "-", item.material || "-", item.presenter || "-"])
  ];

  slide.addTable(rows, { ...TABLE_OPTIONS, colW: [0.6, 4.2, 2.7, 1.7] });
}

function addMinutesSlides(pptx, minutes) {
  const trimmed = (minutes || "").trim();
  if (!trimmed) {
    return;
  }

  const chunks = chunkText(trimmed, MINUTES_CHUNK_SIZE);
  chunks.forEach((chunk, index) => {
    const slide = pptx.addSlide();
    const title = chunks.length > 1 ? `회의록 (${index + 1}/${chunks.length})` : "회의록";
    slide.addText(title, { x: 0.4, y: 0.35, w: 9, h: 0.6, fontSize: 22, bold: true });
    slide.addText(chunk, { x: 0.4, y: 1.1, w: 9.2, h: 5.8, fontSize: 12, valign: "top", wrap: true });
  });
}

export async function buildPptxExport(meetings) {
  const pptx = new pptxgen();

  meetings.forEach((meeting) => {
    addTitleSlide(pptx, meeting);
    // A/I List (planned before this meeting) comes before Agenda (this meeting's own topics).
    addActionItemSlide(pptx, meeting.actionItems ?? []);
    addAgendaSlide(pptx, meeting.agenda ?? []);
    addMinutesSlides(pptx, meeting.minutes);
  });

  if (meetings.length === 0) {
    const slide = pptx.addSlide();
    slide.addText("(내보낼 회의가 없습니다)", { x: 0.5, y: 0.5, w: 9, h: 1, fontSize: 18 });
  }

  // pptxgenjs's documented Node.js API returns a Buffer directly when outputType is
  // "nodebuffer" - could not verify against node_modules/pptxgenjs's type declarations since
  // dependencies are not installed in this sandbox yet, so this follows the official Node.js
  // usage docs for pptxgenjs 3.x.
  return pptx.write({ outputType: "nodebuffer" });
}
