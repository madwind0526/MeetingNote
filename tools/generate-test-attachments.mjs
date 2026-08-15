import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import PDFDocument from "pdfkit";
import pptxgen from "pptxgenjs";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";

const projectRoot = process.cwd();
const meetingsPath = path.join(projectRoot, "data", "db", "meetings.json");
const attachmentsRoot = path.join(projectRoot, "data", "attachments");
const targetMeetingTitle = "테스트 회의록";
const marker = "test용 text: MeetingNote 첨부파일 저장 및 열기 검증용 문구입니다.";

const fontCandidates = [
  "C:\\Windows\\Fonts\\malgun.ttf",
  "C:\\Windows\\Fonts\\NanumGothic.ttf",
  "C:\\Windows\\Fonts\\NotoSansKR-Regular.ttf"
];

async function exists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveFontPath() {
  for (const candidate of fontCandidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function collectMaterialAttachments(meeting) {
  const rows = [];

  for (const item of meeting.actionItems ?? []) {
    if (item.materialPath) {
      rows.push({ section: "A/I List", item });
    }
  }

  for (const item of meeting.agenda ?? []) {
    if (item.materialPath) {
      rows.push({ section: "Agenda", item });
    }
  }

  return rows;
}

function buildTextLines(meeting, section, item, fileName) {
  return [
    "테스트용 첨부 파일",
    marker,
    "",
    `회의 제목: ${meeting.title}`,
    `회의 일시: ${meeting.date} ${meeting.startTime}~${meeting.endTime}`,
    `주관자: ${meeting.organizer}`,
    `구분: ${section}`,
    `항목 번호: ${item.no}`,
    `항목 제목: ${item.title}`,
    `발표자: ${item.presenter || "-"}`,
    `파일명: ${fileName}`,
    "",
    "이 파일은 테스트 회의록에 첨부된 실제 파일입니다.",
    "첨부 경로, 파일 저장, 첨부파일 열기 동작을 확인하기 위해 생성되었습니다."
  ];
}

async function writeDocx(filePath, meeting, section, item, fileName) {
  const lines = buildTextLines(meeting, section, item, fileName);
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
  const lines = buildTextLines(meeting, section, item, fileName);

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

    for (const line of lines.slice(3)) {
      doc.fontSize(10).text(line || " ");
    }

    doc.end();
  });
}

async function writePptx(filePath, meeting, section, item, fileName) {
  const lines = buildTextLines(meeting, section, item, fileName);
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
  slide.addText(lines[0], { x: 0.55, y: 0.45, w: 12.2, h: 0.55, fontFace: "Malgun Gothic", fontSize: 30, bold: true, color: "111827" });
  slide.addText(lines[1], { x: 0.6, y: 1.25, w: 12.0, h: 0.45, fontFace: "Malgun Gothic", fontSize: 16, bold: true, color: "2563EB" });
  slide.addText(lines.slice(3).join("\n"), { x: 0.65, y: 2.05, w: 11.6, h: 4.45, fontFace: "Malgun Gothic", fontSize: 16, color: "1F2937", breakLine: false, fit: "shrink" });

  await pptx.writeFile({ fileName: filePath });
}

async function main() {
  const meetings = JSON.parse(await readFile(meetingsPath, "utf8"));
  const meeting = meetings.find((candidate) => candidate.title === targetMeetingTitle);

  if (!meeting) {
    throw new Error(`${targetMeetingTitle} 회의를 찾지 못했습니다.`);
  }

  const attachments = collectMaterialAttachments(meeting);

  if (attachments.length === 0) {
    throw new Error(`${targetMeetingTitle}에 연결된 첨부 파일이 없습니다.`);
  }

  const written = [];

  for (const { section, item } of attachments) {
    const filePath = path.join(attachmentsRoot, ...String(item.materialPath).split("/"));
    const fileName = path.basename(filePath);
    await mkdir(path.dirname(filePath), { recursive: true });

    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".docx") {
      await writeDocx(filePath, meeting, section, item, fileName);
    } else if (ext === ".pdf") {
      await writePdf(filePath, meeting, section, item, fileName);
    } else if (ext === ".pptx") {
      await writePptx(filePath, meeting, section, item, fileName);
    } else {
      throw new Error(`지원하지 않는 첨부 파일 형식입니다: ${fileName}`);
    }

    written.push(path.relative(projectRoot, filePath));
  }

  console.log(JSON.stringify({ meeting: meeting.title, marker, written }, null, 2));
}

await main();
