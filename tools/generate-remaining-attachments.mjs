import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import process from "node:process";
import JSZip from "jszip";
import PDFDocument from "pdfkit";
import pptxgen from "pptxgenjs";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";

const projectRoot = process.cwd();
const attachmentsRoot = path.join(projectRoot, "data", "attachments");
const dbPath = path.join(projectRoot, "data", "db", "meetings.json");
const seedPath = path.join(projectRoot, "data", "seed", "meetings.sample.json");
const generatedAt = new Date().toISOString();
const marker = "test용 text: MeetingNote 첨부파일 저장 및 열기 검증용 문구입니다.";

const staleTitleOnlyFolders = [
  "2026년 3분기 제품 로드맵 리뷰",
  "신규 결제 시스템 아키텍처 회의",
  "디자인 시스템 개편 킥오프",
  "채용 프로세스 개선 회의",
  "9월 마케팅 캠페인 기획 회의",
  "고객 피드백 분석 및 대응 방안",
  "테스트 회의록"
];

const fontCandidates = [
  "C:\\Windows\\Fonts\\malgun.ttf",
  "C:\\Windows\\Fonts\\NanumGothic.ttf",
  "C:\\Windows\\Fonts\\NotoSansKR-Regular.ttf"
];

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveFontPath() {
  for (const candidate of fontCandidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function sanitizeSegment(value) {
  const trimmed = String(value ?? "").trim();
  const base = trimmed || "untitled";
  const safe = base
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 80)
    .trim();

  return safe || "untitled";
}

function buildFolderLabel(meeting) {
  const date = String(meeting.date ?? "").trim() || "no-date";
  return sanitizeSegment(`${date}-${meeting.title}`);
}

function buildRelativePath(meeting, fileName) {
  return [buildFolderLabel(meeting), "materials", sanitizeSegment(fileName)].join("/");
}

function buildLines(meeting, section, item, fileName) {
  return [
    "테스트용 첨부 파일",
    marker,
    "",
    `회의 제목: ${meeting.title}`,
    `회의 일시: ${meeting.date} ${meeting.startTime}~${meeting.endTime}`,
    `주관자: ${meeting.organizer || "-"}`,
    `구분: ${section}`,
    `항목 번호: ${item.no}`,
    `항목 제목: ${item.title || "-"}`,
    `발표자: ${item.presenter || "-"}`,
    `파일명: ${fileName}`,
    "",
    "이 파일은 해당 회의록의 첨부 자료 테스트를 위해 생성되었습니다.",
    "첨부 파일 저장 위치와 회의록의 materialPath 연결을 검증하는 용도입니다."
  ];
}

async function writeDocx(filePath, meeting, section, item, fileName) {
  const lines = buildLines(meeting, section, item, fileName);
  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({ text: lines[0], heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun({ text: lines[1], bold: true })] }),
          ...lines.slice(3).map((line) => new Paragraph(line || " "))
        ]
      }
    ]
  });

  await writeFile(filePath, await Packer.toBuffer(doc));
}

async function writePdf(filePath, meeting, section, item, fileName) {
  const fontPath = await resolveFontPath();
  const lines = buildLines(meeting, section, item, fileName);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 48, size: "A4" });
    const stream = createWriteStream(filePath);

    stream.on("finish", resolve);
    stream.on("error", reject);
    doc.on("error", reject);
    doc.pipe(stream);

    if (fontPath) {
      doc.registerFont("Korean", fontPath);
      doc.font("Korean");
    }

    doc.fontSize(20).text(lines[0]);
    doc.moveDown(0.5);
    doc.fontSize(11).text(lines[1]);
    doc.moveDown(1);
    lines.slice(3).forEach((line) => doc.fontSize(10).text(line || " "));
    doc.end();
  });
}

async function writePptx(filePath, meeting, section, item, fileName) {
  const lines = buildLines(meeting, section, item, fileName);
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "MeetingNote";
  pptx.subject = "MeetingNote test attachment";
  pptx.title = fileName;
  pptx.company = "MeetingNote";
  pptx.lang = "ko-KR";
  pptx.theme = {
    headFontFace: "Malgun Gothic",
    bodyFontFace: "Malgun Gothic",
    lang: "ko-KR"
  };

  const slide = pptx.addSlide();
  slide.background = { color: "F8FAFC" };
  slide.addText(lines[0], { x: 0.6, y: 0.45, w: 12, h: 0.7, fontFace: "Malgun Gothic", fontSize: 35, bold: true, color: "111827" });
  slide.addText(lines[1], { x: 0.65, y: 1.35, w: 12, h: 0.5, fontFace: "Malgun Gothic", fontSize: 18, bold: true, color: "2563EB" });
  slide.addText(lines.slice(3).join("\n"), { x: 0.7, y: 2.15, w: 11.7, h: 4.6, fontFace: "Malgun Gothic", fontSize: 17, color: "1F2937", fit: "shrink" });

  await pptx.writeFile({ fileName: filePath });
}

function buildSheetXml(rows) {
  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, colIndex) => {
          const cellRef = `${String.fromCharCode(65 + colIndex)}${rowIndex + 1}`;
          return `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetViews><sheetView workbookViewId="0"/></sheetViews>
  <sheetFormatPr defaultRowHeight="18"/>
  <cols><col min="1" max="1" width="20" customWidth="1"/><col min="2" max="2" width="72" customWidth="1"/></cols>
  <sheetData>${sheetRows}</sheetData>
</worksheet>`;
}

async function writeXlsx(filePath, meeting, section, item, fileName) {
  const rows = [
    ["항목", "내용"],
    ["제목", "테스트용 첨부 파일"],
    ["검증 문구", marker],
    ["회의 제목", meeting.title],
    ["회의 일시", `${meeting.date} ${meeting.startTime}~${meeting.endTime}`],
    ["주관자", meeting.organizer || "-"],
    ["구분", section],
    ["항목 번호", String(item.no)],
    ["항목 제목", item.title || "-"],
    ["발표자", item.presenter || "-"],
    ["파일명", fileName],
    ["생성 목적", "첨부 파일 저장 위치와 회의록의 materialPath 연결 검증"]
  ];

  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Test Attachment" sheetId="1" r:id="rId1"/></sheets>
</workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  zip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Malgun Gothic"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`);
  zip.file("xl/worksheets/sheet1.xml", buildSheetXml(rows));
  zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(fileName)}</dc:title>
  <dc:creator>MeetingNote</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${generatedAt}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${generatedAt}</dcterms:modified>
</cp:coreProperties>`);
  zip.file("docProps/app.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>MeetingNote</Application>
</Properties>`);

  await writeFile(filePath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

async function writeJsonAttachment(filePath, meeting, section, item, fileName) {
  const payload = {
    title: "테스트용 첨부 파일",
    marker,
    meetingTitle: meeting.title,
    meetingDate: meeting.date,
    meetingTime: `${meeting.startTime}~${meeting.endTime}`,
    organizer: meeting.organizer,
    section,
    itemNo: item.no,
    itemTitle: item.title,
    presenter: item.presenter,
    fileName,
    generatedAt,
    purpose: "첨부 파일 저장 위치와 회의록의 materialPath 연결 검증"
  };

  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function writeAttachment(filePath, meeting, section, item, fileName) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".docx") {
    await writeDocx(filePath, meeting, section, item, fileName);
  } else if (ext === ".pdf") {
    await writePdf(filePath, meeting, section, item, fileName);
  } else if (ext === ".pptx") {
    await writePptx(filePath, meeting, section, item, fileName);
  } else if (ext === ".xlsx") {
    await writeXlsx(filePath, meeting, section, item, fileName);
  } else if (ext === ".json") {
    await writeJsonAttachment(filePath, meeting, section, item, fileName);
  } else {
    await writeFile(filePath, `${buildLines(meeting, section, item, fileName).join("\n")}\n`, "utf8");
  }
}

function updateMeetingAttachments(meeting) {
  const attachments = [];

  for (const item of meeting.actionItems ?? []) {
    if (String(item.material ?? "").trim()) {
      item.materialPath = buildRelativePath(meeting, item.material);
      attachments.push({ section: "A/I List", item, relativePath: item.materialPath });
    }
  }

  for (const item of meeting.agenda ?? []) {
    if (String(item.material ?? "").trim()) {
      item.materialPath = buildRelativePath(meeting, item.material);
      attachments.push({ section: "Agenda", item, relativePath: item.materialPath });
    }
  }

  if (attachments.length > 0 && meeting.updatedAt) {
    meeting.updatedAt = generatedAt;
  }

  return attachments;
}

async function updateMeetingsFile(filePath, shouldWriteAttachments) {
  const meetings = JSON.parse(await readFile(filePath, "utf8"));
  const writes = [];

  for (const meeting of meetings) {
    for (const attachment of updateMeetingAttachments(meeting)) {
      if (!shouldWriteAttachments) {
        continue;
      }

      const fileName = path.basename(attachment.relativePath);
      const filePathOnDisk = path.join(attachmentsRoot, ...attachment.relativePath.split("/"));
      writes.push({ meeting, section: attachment.section, item: attachment.item, fileName, filePath: filePathOnDisk, relativePath: attachment.relativePath });
    }
  }

  await writeFile(filePath, `${JSON.stringify(meetings, null, 2)}\n`, "utf8");
  return writes;
}

async function removeStaleTitleOnlyFolders() {
  const removed = [];
  const root = path.resolve(attachmentsRoot);

  for (const folder of staleTitleOnlyFolders) {
    const target = path.resolve(attachmentsRoot, sanitizeSegment(folder));

    if (!target.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Refusing to remove a path outside ${root}`);
    }

    try {
      const stats = await stat(target);
      if (stats.isDirectory()) {
        await rm(target, { recursive: true, force: true });
        removed.push(path.relative(projectRoot, target));
      }
    } catch {
      // Missing stale folders are fine.
    }
  }

  return removed;
}

const dbWrites = await updateMeetingsFile(dbPath, true);
await updateMeetingsFile(seedPath, false);

const uniqueWrites = new Map();
for (const write of dbWrites) {
  uniqueWrites.set(write.relativePath, write);
}

for (const write of uniqueWrites.values()) {
  await writeAttachment(write.filePath, write.meeting, write.section, write.item, write.fileName);
}

const removedStaleFolders = await removeStaleTitleOnlyFolders();

console.log(
  JSON.stringify(
    {
      marker,
      generated: Array.from(uniqueWrites.keys()),
      removedStaleFolders
    },
    null,
    2
  )
);
