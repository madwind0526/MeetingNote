// Full-flow E2E test, stage 1: creates the meeting record and its 3 presentation materials
// (PPTX/PDF/XLSX, one per presenter) via the app's real HTTP API (POST /api/attachments,
// POST /api/meetings) - not hand-written into data/db directly - so the md-conversion side effect
// in server/attachments.mjs actually runs, exactly like a real upload from the UI would trigger.
import { createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import PDFDocument from "pdfkit";
import pptxgen from "pptxgenjs";
import JSZip from "jszip";

const BASE_URL = "http://127.0.0.1:5185";
const projectRoot = process.cwd();
const contextPath = path.join(projectRoot, "data", "test-audio", "e2e-meeting-context.json");

const fontCandidates = ["C:\\Windows\\Fonts\\malgun.ttf", "C:\\Windows\\Fonts\\NanumGothic.ttf", "C:\\Windows\\Fonts\\NotoSansKR-Regular.ttf"];

async function resolveFontPath() {
  for (const candidate of fontCandidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function escXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function buildPptxBuffer() {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "MeetingNote E2E";
  pptx.title = "AI 코드리뷰 어시스턴트 파일럿 결과";
  pptx.lang = "ko-KR";
  pptx.theme = { headFontFace: "Malgun Gothic", bodyFontFace: "Malgun Gothic", lang: "ko-KR" };

  const addBulletSlide = (title, bullets) => {
    const slide = pptx.addSlide();
    slide.background = { color: "F8FAFC" };
    slide.addText(title, { x: 0.55, y: 0.4, w: 12.2, h: 0.7, fontFace: "Malgun Gothic", fontSize: 28, bold: true, color: "111827" });
    slide.addText(
      bullets.map((text) => ({ text, options: { bullet: true, breakLine: true } })),
      { x: 0.65, y: 1.35, w: 11.7, h: 5.0, fontFace: "Malgun Gothic", fontSize: 18, color: "1F2937" }
    );
  };

  addBulletSlide("AI 코드리뷰 어시스턴트 파일럿 결과", [
    "발표자: 박서연 (백엔드팀)",
    "배경: PR 리뷰 대기시간 평균 18시간, 반복적인 스타일 지적이 많음"
  ]);
  addBulletSlide("파일럿 개요", [
    "8월 한 달간 백엔드팀 12명 대상 진행",
    "PR 340건에 자동 리뷰 봇 적용",
    "스타일/네이밍/단순 버그 패턴 자동 코멘트"
  ]);
  addBulletSlide("결과", [
    "리뷰 대기시간 18시간 → 6시간 (67% 감소)",
    "사소한 스타일 지적 자동 처리 비율 72%",
    "개발자 설문 만족도 4.2/5.0"
  ]);
  addBulletSlide("남은 이슈", ["오탐율(false positive) 9%", "보안 관련 오탐이 특히 민감해서 신뢰도에 영향"]);
  addBulletSlide("다음 단계", ["9월부터 전사 확대 적용", "오탐 감소를 위한 룰 튜닝 2주 진행 예정"]);

  return pptx.write({ outputType: "nodebuffer" });
}

async function buildPdfBuffer() {
  const fontPath = await resolveFontPath();

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    if (fontPath) {
      doc.registerFont("Korean", fontPath);
      doc.font("Korean");
    }

    doc.fontSize(20).text("고객 지원 티켓 처리 프로세스 개선안", { align: "left" });
    doc.moveDown(0.3);
    doc.fontSize(11).fillColor("#2563EB").text("발표자: 이준호 (CS팀)");
    doc.fillColor("#000000");
    doc.moveDown(1);

    const section = (title, lines) => {
      doc.fontSize(14).text(title);
      doc.moveDown(0.3);
      doc.fontSize(11);
      for (const line of lines) {
        doc.text(`- ${line}`);
      }
      doc.moveDown(1);
    };

    section("현황", [
      "평균 최초 응답시간 4.2시간, 처리 완료까지 평균 2.1일",
      "CS 만족도 78점(100점 만점)"
    ]);
    section("문제점", [
      "반복 문의(비밀번호 재설정, 결제 오류)가 전체 티켓의 41% 차지",
      "담당자 배정 지연이 주요 병목 구간"
    ]);
    section("개선안", [
      "반복 문의 자동 응답 챗봇 도입",
      "티켓 자동 라우팅 규칙 신설로 배정 지연 축소"
    ]);
    section("기대 효과", [
      "최초 응답시간 4.2시간 → 1.5시간",
      "담당자 업무량 약 30% 감소 예상"
    ]);
    section("일정", ["10월 중 챗봇 1차 배포"]);

    doc.end();
  });
}

async function buildXlsxBuffer() {
  const rows = [
    ["항목", "예산(만원)", "집행(만원)", "집행률", "비고"],
    ["클라우드 서버", "4200", "3950", "94%", ""],
    ["CDN/트래픽", "1200", "1450", "121%", "8월 프로모션 트래픽 급증으로 초과"],
    ["모니터링 툴", "600", "540", "90%", ""],
    ["백업/DR", "900", "610", "68%", "DR 리전 이전 지연"],
    ["합계", "6900", "6550", "95%", ""]
  ];

  const sheetRows = rows
    .map((row, rowIndex) => {
      const cells = row
        .map(
          (value, colIndex) =>
            `<c r="${String.fromCharCode(65 + colIndex)}${rowIndex + 1}" t="inlineStr"><is><t>${escXml(value)}</t></is></c>`
        )
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");

  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="3분기 인프라 비용" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
  );
  zip.file(
    "xl/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Malgun Gothic"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`
  );
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`);
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>3분기 인프라 비용 집행 현황</dc:title>
  <dc:creator>MeetingNote E2E</dc:creator>
</cp:coreProperties>`
  );
  zip.file(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>MeetingNote</Application></Properties>`
  );

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

async function uploadAttachment(meetingTitle, kind, fileName, buffer) {
  const contentBase64 = buffer.toString("base64");
  const response = await fetch(`${BASE_URL}/api/attachments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meetingTitle, kind, fileName, contentBase64 })
  });

  if (!response.ok) {
    throw new Error(`업로드 실패 (${fileName}): ${response.status} ${await response.text()}`);
  }

  return response.json();
}

async function main() {
  const date = "2026-08-22";
  const title = "3분기 실행 현황 점검 회의";
  const folderLabel = `${date}-${title}`;

  console.log("[1/3] 발표 자료 3종 생성 중 (PPTX/PDF/XLSX)...");
  const [pptxBuffer, pdfBuffer, xlsxBuffer] = await Promise.all([buildPptxBuffer(), buildPdfBuffer(), buildXlsxBuffer()]);

  console.log("[2/3] /api/attachments 로 업로드 (md 변환 자동 트리거)...");
  const [pptxUpload, pdfUpload, xlsxUpload] = await Promise.all([
    uploadAttachment(folderLabel, "materials", "ai-code-review-pilot.pptx", pptxBuffer),
    uploadAttachment(folderLabel, "materials", "cs-ticket-process-improvement.pdf", pdfBuffer),
    uploadAttachment(folderLabel, "materials", "q3-infra-cost.xlsx", xlsxBuffer)
  ]);

  for (const [label, upload] of [
    ["PPTX", pptxUpload],
    ["PDF", pdfUpload],
    ["XLSX", xlsxUpload]
  ]) {
    console.log(`  ${label}: path=${upload.path} mdPath=${upload.mdPath ?? "(변환 실패/없음)"}`);
    if (!upload.mdPath) {
      throw new Error(`${label} md 변환이 생성되지 않았습니다 - 업로드 응답: ${JSON.stringify(upload)}`);
    }
  }

  const attendees = [
    { id: "presenter1", name: "박서연", role: "백엔드팀", isKeyAttendee: true, isPresenter: true },
    { id: "presenter2", name: "이준호", role: "CS팀", isKeyAttendee: true, isPresenter: true },
    { id: "presenter3", name: "최유나", role: "인프라팀", isKeyAttendee: true, isPresenter: true },
    { id: "attendee1", name: "정하은", role: "기획팀", isKeyAttendee: true, isPresenter: false },
    { id: "attendee2", name: "강민재", role: "디자인팀", isKeyAttendee: true, isPresenter: false }
  ];

  const agenda = [
    {
      no: 1,
      title: "AI 코드리뷰 어시스턴트 파일럿 결과",
      durationMinutes: 1,
      material: "ai-code-review-pilot.pptx",
      materialPath: pptxUpload.path,
      materialMdPath: pptxUpload.mdPath,
      presenter: "박서연"
    },
    {
      no: 2,
      title: "고객 지원 티켓 처리 프로세스 개선안",
      durationMinutes: 1,
      material: "cs-ticket-process-improvement.pdf",
      materialPath: pdfUpload.path,
      materialMdPath: pdfUpload.mdPath,
      presenter: "이준호"
    },
    {
      no: 3,
      title: "3분기 인프라 비용 집행 현황",
      durationMinutes: 1,
      material: "q3-infra-cost.xlsx",
      materialPath: xlsxUpload.path,
      materialMdPath: xlsxUpload.mdPath,
      presenter: "최유나"
    }
  ];

  const meetingDraft = {
    title,
    date,
    startTime: "14:00",
    endTime: "14:30",
    organizer: "김도현",
    secretary: "정하은",
    attendees,
    actionItems: [],
    agenda,
    audio: null,
    minutes: "",
    authorId: ""
  };

  console.log("[3/3] 회의록 생성 중 (POST /api/meetings)...");
  const createResponse = await fetch(`${BASE_URL}/api/meetings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(meetingDraft)
  });

  if (!createResponse.ok) {
    throw new Error(`회의록 생성 실패: ${createResponse.status} ${await createResponse.text()}`);
  }

  const { meeting } = await createResponse.json();

  const context = {
    meetingId: meeting.id,
    folderLabel,
    date,
    title,
    attendees,
    agenda: meeting.agenda
  };

  await writeFile(contextPath, `${JSON.stringify(context, null, 2)}\n`, "utf8");
  console.log(`완료. meetingId=${meeting.id}`);
  console.log(`컨텍스트 저장: ${path.relative(projectRoot, contextPath)}`);
}

await main();
