import PDFDocument from "pdfkit";
import { existsSync } from "node:fs";
import { parseMinutesMarkdown, parseInlineRuns } from "./parseMinutesMarkdown.mjs";

// PDFKit's built-in fonts (Helvetica, Times) have no Hangul glyphs, so Korean text needs an
// explicit TrueType font registered via fontkit. Malgun Gothic ships with every Windows
// installation since Vista, so it is used as the default with no bundled font file required.
const KOREAN_FONT_CANDIDATES = [
  "C:\\Windows\\Fonts\\malgun.ttf",
  "C:\\Windows\\Fonts\\NanumGothic.ttf",
  "C:\\Windows\\Fonts\\NotoSansKR-Regular.ttf"
];
const KOREAN_BOLD_FONT_CANDIDATES = [
  "C:\\Windows\\Fonts\\malgunbd.ttf",
  "C:\\Windows\\Fonts\\NanumGothicBold.ttf",
  "C:\\Windows\\Fonts\\NotoSansKR-Bold.ttf"
];

function resolveKoreanFontPath() {
  return KOREAN_FONT_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

function resolveKoreanBoldFontPath() {
  return KOREAN_BOLD_FONT_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

function attendeeNamesOf(meeting) {
  return (meeting.attendees ?? []).map((attendee) => attendee.name).filter(Boolean).join(", ");
}

// Renders "some **bold** text" on the current line, switching between the Korean/Korean-Bold
// fonts per run via pdfkit's {continued: true} - hasBoldFont is false when malgunbd.ttf (or an
// equivalent) isn't installed, in which case bold markers are just dropped rather than crashing.
function drawInlineRuns(doc, text, { fontSize = 10, hasBoldFont } = {}) {
  const runs = parseInlineRuns(text);
  doc.fontSize(fontSize);

  runs.forEach((run, index) => {
    doc.font(run.bold && hasBoldFont ? "Korean-Bold" : "Korean");
    doc.text(run.text, { continued: index < runs.length - 1 });
  });

  doc.font("Korean");
}

// Proportional-to-content column widths (longer columns get more room), each floored at a
// fit availableWidth exactly if the proportional sum overshoots it.
function computeColumnWidths(table, availableWidth) {
  const minColWidth = 55;
  const maxLens = table.header.map((headerText, columnIndex) =>
    Math.max(headerText.length, ...table.rows.map((row) => (row[columnIndex] ?? "").length), 1)
  );
  const totalLen = maxLens.reduce((sum, len) => sum + len, 0);
  const widths = maxLens.map((len) => Math.max(minColWidth, (len / totalLen) * availableWidth));
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);

  return totalWidth > availableWidth ? widths.map((width) => (width / totalWidth) * availableWidth) : widths;
}

// Draws a real bordered/shaded table grid for a detected GFM table block - pdfkit has no native
// table primitive, so this measures each cell's wrapped height first (via heightOfString) to get
// a correct row height, then draws the row's borders/fill and text. Repeats the header row after
function drawMarkdownTable(doc, table, { hasBoldFont }) {
  const startX = doc.page.margins.left;
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const columnWidths = computeColumnWidths(table, availableWidth);
  const fontSize = 9;
  const paddingX = 6;
  const paddingY = 5;

  function cellHeight(text, bold) {
    doc.fontSize(fontSize).font(bold && hasBoldFont ? "Korean-Bold" : "Korean");
    const columnIndex = cellHeight.currentColumnIndex;
    return doc.heightOfString(text || "-", { width: columnWidths[columnIndex] - paddingX * 2 }) + paddingY * 2;
  }

  function drawRow(cells, isHeader) {
    const rowHeights = cells.map((text, columnIndex) => {
      cellHeight.currentColumnIndex = columnIndex;
      return cellHeight(text, isHeader);
    });
    const rowHeight = Math.max(...rowHeights, fontSize + paddingY * 2);

    if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      if (!isHeader) {
        drawRow(table.header, true);
      }
    }

    const rowTop = doc.y;
    let cellX = startX;

    cells.forEach((text, columnIndex) => {
      const width = columnWidths[columnIndex];
      if (isHeader) {
        doc.rect(cellX, rowTop, width, rowHeight).fillAndStroke("#EFEFEF", "#C4C9C6");
      } else {
        doc.rect(cellX, rowTop, width, rowHeight).stroke("#C4C9C6");
      }
      doc
        .fillColor("#202124")
        .font(isHeader && hasBoldFont ? "Korean-Bold" : "Korean")
        .fontSize(fontSize)
        .text(text || "-", cellX + paddingX, rowTop + paddingY, { width: width - paddingX * 2 });
      cellX += width;
    });

    doc.y = rowTop + rowHeight;
  }

  drawRow(table.header, true);
  table.rows.forEach((row) => drawRow(table.header.map((_, columnIndex) => row[columnIndex] ?? ""), false));
  doc.font("Korean");
  doc.moveDown(0.6);
}

// of dumping raw markdown text line-by-line - see parseMinutesMarkdown.mjs.
function writeMinutesBlocks(doc, minutes, { hasBoldFont }) {
  const trimmed = (minutes || "").trim();
  doc.fontSize(12).text("회의록");
  doc.fontSize(10);

  if (!trimmed) {
    doc.text("(작성되지 않음)");
    return;
  }

  const blocks = parseMinutesMarkdown(trimmed);
  const headingSizes = { 1: 15, 2: 13, 3: 12, 4: 11, 5: 10, 6: 10 };

  for (const block of blocks) {
    if (doc.y > 740) {
      doc.addPage();
    }

    if (block.type === "heading") {
      doc.moveDown(0.4);
      doc.font(hasBoldFont ? "Korean-Bold" : "Korean").fontSize(headingSizes[block.level] ?? 10).text(block.text);
      doc.font("Korean").fontSize(10);
    } else if (block.type === "table") {
      drawMarkdownTable(doc, block, { hasBoldFont });
    } else if (block.type === "list") {
      for (const item of block.items) {
        if (doc.y > 740) {
          doc.addPage();
        }
        doc.text("• ", { continued: true });
        drawInlineRuns(doc, item, { fontSize: 10, hasBoldFont });
      }
    } else if (block.type === "hr") {
      doc.moveDown(0.2);
      const y = doc.y;
      doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).strokeColor("#C4C9C6").stroke();
      doc.strokeColor("#000000");
      doc.moveDown(0.4);
    } else {
      drawInlineRuns(doc, block.text, { fontSize: 10, hasBoldFont });
    }
  }
}

// Writes exactly the label format importPdf.mjs's parseMeetingText expects, so exporting and
// now renders any GFM table as a real drawn table (see writeMinutesBlocks) rather than the plain
// text pdf-parse would otherwise round-trip byte-for-byte; a re-imported table renders as
// unstructured text instead of a table, which is an acceptable trade-off for readable exports.
function writeMeetingBody(doc, meeting, { hasBoldFont }) {
  doc.fontSize(16).text(`제목: ${meeting.title || "-"}`);
  doc.fontSize(10);
  doc.text(`날짜: ${meeting.date || "-"}`);
  doc.text(`시작: ${meeting.startTime || "-"}`);
  doc.text(`종료: ${meeting.endTime || "-"}`);
  doc.text(`장소: ${meeting.location || "-"}`);
  doc.text(`주관자: ${meeting.organizer || "-"}`);
  doc.text(`간사: ${meeting.secretary || "-"}`);
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

  writeMinutesBlocks(doc, meeting.minutes, { hasBoldFont });
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
    const boldFontPath = resolveKoreanBoldFontPath();
    const hasBoldFont = Boolean(boldFontPath);
    if (boldFontPath) {
      doc.registerFont("Korean-Bold", boldFontPath);
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

      writeMeetingBody(doc, meeting, { hasBoldFont });
    });

    doc.end();
  });
}
