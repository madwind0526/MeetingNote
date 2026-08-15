import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";

const root = process.cwd();
const marker = "test용 text: MeetingNote 첨부파일 저장 및 열기 검증용 문구입니다.";
const meetings = JSON.parse(await readFile(path.join(root, "data", "db", "meetings.json"), "utf8"));
const meeting = meetings.find((item) => item.title === "테스트 회의록");

if (!meeting) {
  throw new Error("테스트 회의록을 찾지 못했습니다.");
}

const paths = [...(meeting.actionItems ?? []), ...(meeting.agenda ?? [])]
  .filter((item) => item.materialPath)
  .map((item) => item.materialPath);

const results = [];

for (const relativePath of paths) {
  const filePath = path.join(root, "data", "attachments", ...relativePath.split("/"));
  const ext = path.extname(filePath).toLowerCase();
  let hasMarker = false;
  let detail = "";

  if (ext === ".docx") {
    const text = (await mammoth.extractRawText({ path: filePath })).value;
    hasMarker = text.includes(marker);
    detail = text.replace(/\s+/g, " ").trim().slice(0, 160);
  } else if (ext === ".pdf") {
    const parsed = await pdfParse(await readFile(filePath));
    hasMarker = parsed.text.includes(marker);
    detail = parsed.text.replace(/\s+/g, " ").trim().slice(0, 160);
  } else if (ext === ".pptx") {
    const zip = await JSZip.loadAsync(await readFile(filePath));
    const slideXml = await Promise.all(
      Object.keys(zip.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .map((name) => zip.files[name].async("string"))
    );
    const combined = slideXml.join("\n");
    hasMarker = combined.includes(marker);
    detail = `slides=${slideXml.length}`;
  }

  results.push({ relativePath, hasMarker, detail });
}

console.log(JSON.stringify({ meeting: meeting.title, marker, results }, null, 2));

if (results.some((result) => !result.hasMarker)) {
  process.exitCode = 1;
}
