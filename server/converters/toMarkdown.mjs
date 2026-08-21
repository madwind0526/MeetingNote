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

  return null;
}
