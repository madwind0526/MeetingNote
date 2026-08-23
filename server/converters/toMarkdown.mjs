import pdfParse from "pdf-parse/lib/pdf-parse.js";
import mammoth from "mammoth";
import JSZip from "jszip";
import path from "node:path";

// Presentation-material -> Markdown conversion (B4). Independent of the existing
// server/parsers/import*.mjs files, which parse *this app's own exported* meeting-note documents
// (looking for "제목:"/"Agenda"/etc. labels) - this instead extracts general prose/slide content
// from arbitrary third-party PDF/DOCX/PPTX files attached as Agenda/A-I List materials, so B5 can
// later feed it to an LLM alongside the matching STT transcript.

async function convertPdfToMarkdown(buffer, title) {
  const { text } = await pdfParse(buffer);
  return `# ${title}\n\n${(text || "").trim()}\n`;
}

async function convertDocxToMarkdown(buffer, title) {
  const { value } = await mammoth.convertToMarkdown({ buffer });
  return `# ${title}\n\n${(value || "").trim()}\n`;
}

// A .pptx is a zip of XML parts - slide text lives in ppt/slides/slideN.xml inside <a:t> runs (see
// server/parsers/importPptx.mjs, which extracts the same way for a different purpose).
function slideXmlToText(xml) {
  return [...xml.matchAll(/<a:t>([^<]*)</g)].map((match) => match[1]);
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

async function convertPptxToMarkdown(buffer, title) {
  const slides = await extractSlideTexts(buffer);
  const body = slides
    .map((runs, index) => {
      const bullets = runs.filter((run) => run.trim()).map((run) => `- ${run.trim()}`);
      return `## 슬라이드 ${index + 1}\n\n${bullets.length > 0 ? bullets.join("\n") : "(내용 없음)"}`;
    })
    .join("\n\n");

  return `# ${title}\n\n${body}\n`;
}

// Shared strings table (xl/sharedStrings.xml) - most real spreadsheets (Excel, Google Sheets
// exports, ...) store cell text here and reference it by index (t="s") rather than inline. A
// shared string can hold multiple rich-text runs (<r><t>...</t></r>) instead of one plain <t>, so
// both shapes are handled. Absent entirely for spreadsheets that only use inline strings (t=
// "inlineStr", e.g. this project's own hand-written xlsx test attachments) - an empty table is
// fine since those cells never look one up.
function parseSharedStrings(xml) {
  if (!xml) {
    return [];
  }

  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => {
    const runs = [...match[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((run) => run[1]);
    return runs.join("");
  });
}

function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function columnLetterFromCellRef(cellRef) {
  return (/^[A-Z]+/.exec(cellRef) ?? [""])[0];
}

function columnIndexFromLetters(letters) {
  let index = 0;
  for (const char of letters) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index;
}

function parseSheetRows(xml, sharedStrings) {
  const rowMatches = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)];

  return rowMatches.map((rowMatch) => {
    const cellMatches = [...rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)];
    const cells = [];

    for (const [, attrs, inner] of cellMatches) {
      const cellRefMatch = /r="([A-Z]+\d+)"/.exec(attrs);
      const columnIndex = cellRefMatch ? columnIndexFromLetters(columnLetterFromCellRef(cellRefMatch[1])) : cells.length + 1;
      const type = (/t="([^"]*)"/.exec(attrs) ?? [, ""])[1];

      let value = "";
      if (type === "s") {
        const sharedIndex = Number((/<v>([^<]*)<\/v>/.exec(inner) ?? [, "-1"])[1]);
        value = sharedStrings[sharedIndex] ?? "";
      } else if (type === "inlineStr") {
        value = [...inner.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((run) => run[1]).join("");
      } else {
        value = (/<v>([^<]*)<\/v>/.exec(inner) ?? [, ""])[1];
      }

      cells[columnIndex - 1] = decodeXmlEntities(value);
    }

    return cells.map((cell) => cell ?? "");
  });
}

// A .xlsx is a zip of XML parts, same container format as .pptx/.docx - cell text lives in
// xl/worksheets/sheetN.xml, either inline or via xl/sharedStrings.xml (see parseSharedStrings).
// Only the first sheet is converted: presentation-material attachments in this app are single-
// purpose reference tables (budget, schedule, ...), not multi-tab workbooks.
async function convertXlsxToMarkdown(buffer, title) {
  const zip = await JSZip.loadAsync(buffer);
  const sheetEntry = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort()[0];

  if (!sheetEntry) {
    return `# ${title}\n\n(표 내용을 찾을 수 없습니다)\n`;
  }

  const [sheetXml, sharedStringsXml] = await Promise.all([
    zip.files[sheetEntry].async("string"),
    zip.files["xl/sharedStrings.xml"]?.async("string") ?? Promise.resolve(null)
  ]);

  const sharedStrings = parseSharedStrings(sharedStringsXml);
  const rows = parseSheetRows(sheetXml, sharedStrings).filter((row) => row.some((cell) => cell.trim()));

  if (rows.length === 0) {
    return `# ${title}\n\n(표 내용이 비어 있습니다)\n`;
  }

  const columnCount = Math.max(...rows.map((row) => row.length));
  const padRow = (row) => Array.from({ length: columnCount }, (_, index) => row[index] ?? "");
  const toMarkdownRow = (row) => `| ${padRow(row).map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;

  const [headerRow, ...bodyRows] = rows;
  const table = [
    toMarkdownRow(headerRow),
    `| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`,
    ...bodyRows.map((row) => toMarkdownRow(row))
  ].join("\n");

  return `# ${title}\n\n${table}\n`;
}

// null means "not a convertible format" - callers treat that as a no-op, not an error.
export async function convertMaterialToMarkdown(buffer, fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const title = path.basename(fileName, path.extname(fileName));

  if (ext === ".pdf") {
    return convertPdfToMarkdown(buffer, title);
  }
  if (ext === ".docx") {
    return convertDocxToMarkdown(buffer, title);
  }
  if (ext === ".pptx") {
    return convertPptxToMarkdown(buffer, title);
  }
  if (ext === ".xlsx") {
    return convertXlsxToMarkdown(buffer, title);
  }

  return null;
}
