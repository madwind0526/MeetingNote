import { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun } from "docx";

function headerCell(text) {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold: true })] })]
  });
}

function cell(text) {
  return new TableCell({ children: [new Paragraph(text || "-")] });
}

function attendeeNamesOf(meeting) {
  return (meeting.attendees ?? []).map((attendee) => attendee.name).filter(Boolean).join(", ");
}

function buildAgendaTable(agenda) {
  const headerRow = new TableRow({
    children: [headerCell("No"), headerCell("제목"), headerCell("발표시간"), headerCell("발표자료"), headerCell("발표자")]
  });

  const rows = agenda.map(
    (item) =>
      new TableRow({
        children: [
          cell(String(item.no ?? "")),
          cell(item.title),
          cell(`${item.durationMinutes ?? 0}분`),
          cell(item.material),
          cell(item.presenter)
        ]
      })
  );

  return new Table({ rows: [headerRow, ...rows] });
}

function buildActionItemTable(actionItems) {
  const headerRow = new TableRow({
    children: [headerCell("No"), headerCell("제목"), headerCell("발표자료"), headerCell("발표자")]
  });

  const rows = actionItems.map(
    (item) =>
      new TableRow({
        children: [cell(String(item.no ?? "")), cell(item.title), cell(item.material), cell(item.presenter)]
      })
  );

  return new Table({ rows: [headerRow, ...rows] });
}

function buildMinutesParagraphs(minutes) {
  const trimmed = (minutes || "").trim();

  if (!trimmed) {
    return [new Paragraph("(작성되지 않음)")];
  }

  return trimmed.split("\n").map((line) => new Paragraph(line));
}

function buildMeetingChildren(meeting) {
  const children = [];

  children.push(new Paragraph({ text: meeting.title || "(제목 없음)", heading: HeadingLevel.HEADING_1 }));
  children.push(new Paragraph(`날짜: ${meeting.date || "-"}`));
  children.push(new Paragraph(`시간: ${meeting.startTime || "-"} ~ ${meeting.endTime || "-"}`));
  children.push(new Paragraph(`주관자: ${meeting.organizer || "-"}`));
  children.push(new Paragraph(`참석자: ${attendeeNamesOf(meeting) || "-"}`));

  // A/I List (planned before this meeting) is listed before Agenda (this meeting's own topics).
  children.push(new Paragraph({ text: "A/I List", heading: HeadingLevel.HEADING_2 }));
  const actionItems = meeting.actionItems ?? [];
  children.push(actionItems.length > 0 ? buildActionItemTable(actionItems) : new Paragraph("(없음)"));

  children.push(new Paragraph({ text: "Agenda", heading: HeadingLevel.HEADING_2 }));
  const agenda = meeting.agenda ?? [];
  children.push(agenda.length > 0 ? buildAgendaTable(agenda) : new Paragraph("(없음)"));

  children.push(new Paragraph({ text: "회의록", heading: HeadingLevel.HEADING_2 }));
  children.push(...buildMinutesParagraphs(meeting.minutes));

  return children;
}

// One docx "section" per meeting - besides mapping naturally onto the source data, a new section
// also starts a fresh page by default, giving the same one-meeting-per-page separation the PDF
// and PPTX exporters use.
export async function buildDocxExport(meetings) {
  const sections =
    meetings.length > 0
      ? meetings.map((meeting) => ({ properties: {}, children: buildMeetingChildren(meeting) }))
      : [{ properties: {}, children: [new Paragraph("(내보낼 회의가 없습니다)")] }];

  const doc = new Document({ sections });

  return Packer.toBuffer(doc);
}
