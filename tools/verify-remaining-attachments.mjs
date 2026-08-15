import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";

const root = process.cwd();
const attachmentsRoot = path.join(root, "data", "attachments");
const dbPath = path.join(root, "data", "db", "meetings.json");
const seedPath = path.join(root, "data", "seed", "meetings.sample.json");
const marker = "test용 text: MeetingNote 첨부파일 저장 및 열기 검증용 문구입니다.";

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".docx") {
    return (await mammoth.extractRawText({ path: filePath })).value;
  }

  if (ext === ".pdf") {
    return (await pdfParse(await readFile(filePath))).text;
  }

  if (ext === ".pptx") {
    const zip = await JSZip.loadAsync(await readFile(filePath));
    const slideXml = await Promise.all(
      Object.keys(zip.files)
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .map((name) => zip.files[name].async("string"))
    );
    return slideXml.join("\n");
  }

  if (ext === ".xlsx") {
    const zip = await JSZip.loadAsync(await readFile(filePath));
    const sheetXml = await Promise.all(
      Object.keys(zip.files)
        .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
        .map((name) => zip.files[name].async("string"))
    );
    return sheetXml.join("\n");
  }

  return readFile(filePath, "utf8");
}

function collectMaterialRows(meetings) {
  const rows = [];

  for (const meeting of meetings) {
    for (const item of meeting.actionItems ?? []) {
      if (String(item.material ?? "").trim()) {
        rows.push({ meeting: meeting.title, section: "A/I List", material: item.material, materialPath: item.materialPath });
      }
    }

    for (const item of meeting.agenda ?? []) {
      if (String(item.material ?? "").trim()) {
        rows.push({ meeting: meeting.title, section: "Agenda", material: item.material, materialPath: item.materialPath });
      }
    }
  }

  return rows;
}

const dbMeetings = JSON.parse(await readFile(dbPath, "utf8"));
const seedMeetings = JSON.parse(await readFile(seedPath, "utf8"));
const dbRows = collectMaterialRows(dbMeetings);
const seedRows = collectMaterialRows(seedMeetings);
const uniquePaths = [...new Set(dbRows.map((row) => row.materialPath))];
const results = [];

for (const relativePath of uniquePaths) {
  const filePath = path.join(attachmentsRoot, ...String(relativePath).split("/"));
  const text = await extractText(filePath);
  results.push({
    relativePath,
    hasMarker: text.includes(marker),
    preview: text.replace(/\s+/g, " ").trim().slice(0, 120)
  });
}

const missingDbPaths = dbRows.filter((row) => !row.materialPath);
const missingSeedPaths = seedRows.filter((row) => !row.materialPath);
const failedMarkers = results.filter((result) => !result.hasMarker);

console.log(
  JSON.stringify(
    {
      marker,
      dbRows: dbRows.length,
      seedRows: seedRows.length,
      uniqueFiles: uniquePaths.length,
      missingDbPaths,
      missingSeedPaths,
      failedMarkers,
      results
    },
    null,
    2
  )
);

if (missingDbPaths.length > 0 || missingSeedPaths.length > 0 || failedMarkers.length > 0) {
  process.exitCode = 1;
}
