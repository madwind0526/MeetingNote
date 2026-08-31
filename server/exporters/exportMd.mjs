function attendeeNamesOf(meeting) {
  return (meeting.attendees ?? []).map((attendee) => attendee.name).filter(Boolean).join(", ");
}

// Writes the heading/label format importMd.mjs's parser expects, so exporting and re-importing
// this app's own Markdown round-trips cleanly (same convention as exportPdf.mjs/importPdf.mjs).
function writeMeetingBody(meeting) {
  const lines = [];

  lines.push(`# ${meeting.title || "-"}`);
  lines.push("");
  lines.push(`- 날짜: ${meeting.date || "-"}`);
  lines.push(`- 시작: ${meeting.startTime || "-"}`);
  lines.push(`- 종료: ${meeting.endTime || "-"}`);
  lines.push(`- 장소: ${meeting.location || "-"}`);
  lines.push(`- 주관자: ${meeting.organizer || "-"}`);
  lines.push(`- 간사: ${meeting.secretary || "-"}`);
  lines.push(`- 참석자: ${attendeeNamesOf(meeting) || "-"}`);
  lines.push("");

  lines.push("## A/I List");
  lines.push("");
  const actionItems = meeting.actionItems ?? [];
  if (actionItems.length === 0) {
    lines.push("(없음)");
  } else {
    actionItems.forEach((item) => {
      lines.push(`${item.no}. ${item.title || "-"} (발표자료: ${item.material || "-"}, 발표자: ${item.presenter || "-"})`);
    });
  }
  lines.push("");

  lines.push("## Agenda");
  lines.push("");
  const agenda = meeting.agenda ?? [];
  if (agenda.length === 0) {
    lines.push("(없음)");
  } else {
    agenda.forEach((item) => {
      lines.push(
        `${item.no}. ${item.title || "-"} (발표시간: ${item.durationMinutes ?? 0}분, 발표자: ${item.presenter || "-"}, 자료: ${item.material || "-"})`
      );
    });
  }
  lines.push("");

  lines.push("## 회의록");
  lines.push("");
  const minutesText = (meeting.minutes || "").trim();
  lines.push(minutesText || "(작성되지 않음)");

  return lines.join("\n");
}

export function buildMdExport(meetings) {
  const body = meetings.map((meeting) => writeMeetingBody(meeting)).join("\n\n---\n\n");
  return Buffer.from(`${body}\n`, "utf8");
}
