import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";

// PDFKit's built-in fonts (Helvetica, Times) have no Hangul glyphs, so Korean text needs an
// explicit TrueType font registered via fontkit. Malgun Gothic ships with every Windows
// installation since Vista, so it is used as the default with no bundled font file required.
const KOREAN_FONT_CANDIDATES = [
  "C:\\Windows\\Fonts\\malgun.ttf",
  "C:\\Windows\\Fonts\\NanumGothic.ttf",
  "C:\\Windows\\Fonts\\NotoSansKR-Regular.ttf"
];

function resolveKoreanFontPath() {
  return KOREAN_FONT_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

function attendeeNamesOf(meeting) {
  return (meeting.attendees ?? []).map((attendee) => attendee.name).filter(Boolean).join(", ");
}

// Writes exactly the label format importPdf.mjs's parseMeetingText expects, so exporting and
// re-importing this app's own PDF round-trips cleanly.
function writeMeetingBody(doc, meeting) {
  doc.fontSize(16).text(`제목: ${meeting.title || "-"}`);
  doc.fontSize(10);
  doc.text(`날짜: ${meeting.date || "-"}`);
  doc.text(`시작: ${meeting.startTime || "-"}`);
  doc.text(`종료: ${meeting.endTime || "-"}`);
  doc.text(`주관자: ${meeting.organizer || "-"}`);
  doc.text(`참석자: ${attendeeNamesOf(meeting) || "-"}`);
  doc.moveDown(0.6);

  // A/I List (planned before this meeting) is listed before Agenda (this meeting's own topics) -
  // matches the order used by the registration form and detail view.
  doc.fontSize(12).text("A/I List");
  doc.fontSize(10);
  const actionItems = meeting.actionItems ?? [];
  if (actionItems.length === 0) {
    doc.text("(없음)");
  } else {
    actionItems.forEach((item) => {
      doc.text(`${item.no}. ${item.title || "-"} (발표자료: ${item.material || "-"}, 발표자: ${item.presenter || "-"})`);
      if (doc.y > 740) {
        doc.addPage();
      }
    });
  }
  doc.moveDown(0.6);

  doc.fontSize(12).text("Agenda");
  doc.fontSize(10);
  const agenda = meeting.agenda ?? [];
  if (agenda.length === 0) {
    doc.text("(없음)");
  } else {
    agenda.forEach((item) => {
      doc.text(`${item.no}. ${item.title || "-"} (발표시간: ${item.durationMinutes ?? 0}분, 발표자: ${item.presenter || "-"}, 자료: ${item.material || "-"})`);
      if (doc.y > 740) {
        doc.addPage();
      }
    });
  }
  doc.moveDown(0.6);

  doc.fontSize(12).text("회의록");
  doc.fontSize(10);
  const minutesText = (meeting.minutes || "").trim();
  if (!minutesText) {
    doc.text("(작성되지 않음)");
  } else {
    minutesText.split("\n").forEach((line) => {
      doc.text(line.length > 0 ? line : " ");
      if (doc.y > 740) {
        doc.addPage();
      }
    });
  }
}

export function buildPdfExport(meetings) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 42, size: "A4" });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const fontPath = resolveKoreanFontPath();
    if (fontPath) {
      doc.registerFont("Korean", fontPath);
      doc.font("Korean");
    }

    doc.fontSize(20).text("MeetingNote 회의록", { align: "left" });
    doc.fontSize(10).fillColor("#60706a").text(`생성일: ${new Date().toISOString().slice(0, 10)} · 총 ${meetings.length}건`);
    doc.fillColor("#202124");
    doc.moveDown(1);

    meetings.forEach((meeting, index) => {
      if (index > 0) {
        // Always start distinct meetings on a fresh page for readability, in addition to the
        // in-body 740pt overflow check for very long single meetings.
        doc.addPage();
      }

      writeMeetingBody(doc, meeting);
    });

    doc.end();
  });
}
