import pptxgen from "pptxgenjs";
import { parseMinutesMarkdown, parseInlineRuns } from "./parseMinutesMarkdown.mjs";

// Portrait canvas (taller than wide) - a 회의록 reads top-to-bottom like a document, not
// left-to-right like a widescreen deck, so portrait fits the content better than pptxgenjs's
// landscape defaults. 7.5x10in mirrors a portrait A4/Letter page's proportions.
const SLIDE_WIDTH_IN = 7.5;
const SLIDE_HEIGHT_IN = 10;
const CONTENT_X = 0.4;
const CONTENT_WIDTH = SLIDE_WIDTH_IN - CONTENT_X * 2;

// Rough characters-per-slide budget for packing a single section's paragraphs/lists onto slides
// when it runs long enough to need continuation slides - not a real text measurement, just enough
// to keep any one slide from getting overstuffed. Tables always get their own dedicated slide
// instead (see addMinutesSlides), since a real table needs pptxgenjs's own row layout.
const MINUTES_CHAR_BUDGET = 950;
const HEADER_FILL = "E5E5E5";
const TABLE_OPTIONS = { x: CONTENT_X, y: 1.3, w: CONTENT_WIDTH, fontSize: 11, autoPage: true };
// Matches this app's own UI accent teal (see src/styles/app.css's #1f6f68) so exported slides read
// as "from this app" instead of pptxgenjs's plain black-on-white default.
const ACCENT_COLOR = "1F6F68";
// Taller than a landscape title bar (h: 0.9 vs the old 0.6) since the narrower portrait width
// wraps a long section title (e.g. "1. 데이터 파이프라인 안정화 (발표자: 홍지호)") onto 2 lines
// more often than the old wide canvas did.
const SLIDE_TITLE_OPTIONS = { x: CONTENT_X, y: 0.35, w: CONTENT_WIDTH, h: 0.9, fontSize: 20, bold: true, color: ACCENT_COLOR };

function attendeeNamesOf(meeting) {
  return (meeting.attendees ?? []).map((attendee) => attendee.name).filter(Boolean).join(", ");
}

function headerRow(labels) {
  return labels.map((text) => ({ text, options: { bold: true, color: ACCENT_COLOR, fill: { color: HEADER_FILL } } }));
}

// Converts non-table 회의록 blocks (headings/paragraphs/lists) into one flat pptxgenjs rich-text
// run array so several blocks can be packed onto a single addText call - headings get a bigger
// bold run, list items get a literal "• " prefix (pptxgenjs's own bullet option isn't reliable
// when mixed with plain paragraph runs in the same call).
function richRunsForBlocks(blocks) {
  const runs = [];

  const pushInline = (text, extraOptions) => {
    for (const run of parseInlineRuns(text)) {
      runs.push({ text: run.text, options: { bold: run.bold, ...extraOptions } });
    }
  };

  for (const block of blocks) {
    if (block.type === "heading") {
      pushInline(block.text, { bold: true, fontSize: block.level <= 2 ? 16 : 13, color: "1F2937", breakLine: true });
    } else if (block.type === "list") {
      for (const item of block.items) {
        runs.push({ text: "• ", options: {} });
        pushInline(item, {});
        runs.push({ text: "\n", options: { breakLine: true } });
      }
    } else if (block.type === "hr") {
      runs.push({ text: "\n", options: { breakLine: true } });
    } else {
      pushInline(block.text, {});
      runs.push({ text: "\n\n", options: { breakLine: true } });
    }
  }

  return runs;
}

function blockCharCount(block) {
  if (block.type === "heading") return block.text.length;
  if (block.type === "list") return block.items.join("").length;
  if (block.type === "paragraph") return block.text.length;
  return 0;
}

// The minutes prompt doesn't mandate a heading level for each Agenda item's write-up, so the LLM
// sometimes uses a real "### 1. Title (발표자: X)" heading and sometimes a bold pseudo-heading
// paragraph like "**1. Title (발표자: X)** 이어지는 문장..." - this recognizes the second shape so
// each numbered agenda item still gets split into its own slide either way (see splitIntoSections
// below). Returns the extracted title and whatever prose immediately follows the bold marker on
// the same line (rendered as that section's first paragraph), or null if the paragraph doesn't
// start with a "**N. ...**" marker.
function extractLeadingNumberedTitle(text) {
  const match = /^\*\*(\d+\.\s*.+?)\*\*\s*(.*)$/.exec(text);
  return match ? { title: match[1].trim(), rest: match[2].trim() } : null;
}

// True for the "일시/주관자/참석자" recap paragraph the LLM sometimes writes right under the top
// title - already fully covered by the title slide (addTitleSlide), so treated as noise here
// regardless of whether it sits under its own "회의 기본정보" heading or bare after the H1.
function looksLikeBasicInfoRecap(text) {
  return text.includes("일시") && text.includes("주관자");
}

// Groups parsed markdown blocks into slide-sized sections, splitting at every heading and every
// bold-numbered pseudo-heading (see extractLeadingNumberedTitle) - this is what turns "one wall of
// text" into "one slide per Agenda topic". The very first H1 (the LLM's own "# ... 회의록" title,
// per MINUTES_SYSTEM_PROMPT) and the 일시/주관자/참석자 recap are dropped as redundant with the
// title slide; the A/I List recap section is dropped too since a real table slide already covers
// it (see addActionItemSlide) - kept only when it isn't a recap of already-covered data.
function splitIntoSections(blocks) {
  const sections = [];
  let current = null;

  const startSection = (title) => {
    current = { title, body: [] };
    sections.push(current);
  };

  // While true, every block is dropped (not just the triggering heading) until the next block
  // that actually starts a new section - otherwise a dropped heading's own body (e.g. "회의
  // 기본정보"'s bullet list, or "A/I List"'s "사전에 계획된 A/I 없음." line) would fall through
  // and land in a stray untitled section instead of being suppressed along with its heading.
  let skipping = false;

  for (const block of blocks) {
    if (block.type === "hr") {
      continue; // purely decorative - never meaningful as its own slide content
    }

    if (block.type === "heading") {
      if (block.level === 1) {
        current = null; // drop the H1 title recap - the next real heading starts a fresh section
        skipping = true;
        continue;
      }
      if (/^(사전\s*)?A\/?I\s*List|사전\s*액션\s*아이템|회의\s*기본\s*정보|^기본\s*정보/i.test(block.text)) {
        current = null; // drop - already covered by the title slide or the real A/I List table slide
        skipping = true;
        continue;
      }
      startSection(block.text);
      skipping = false;
      continue;
    }

    if (block.type === "paragraph") {
      const numbered = extractLeadingNumberedTitle(block.text);
      if (numbered) {
        startSection(numbered.title);
        skipping = false;
        if (numbered.rest) {
          current.body.push({ type: "paragraph", text: numbered.rest });
        }
        continue;
      }
      if (looksLikeBasicInfoRecap(block.text) && (!current || current.body.length === 0)) {
        skipping = true; // drop - already covered by the title slide
        continue;
      }
    }

    if (skipping) {
      continue;
    }

    if (!current) {
      startSection(null); // content before any heading (rare) still needs a home
    }
    current.body.push(block);
  }

  return sections.filter((section) => section.title || section.body.length > 0);
}

function addTitleSlide(pptx, meeting) {
  const slide = pptx.addSlide();

  slide.addShape("rect", { x: 0, y: 0, w: SLIDE_WIDTH_IN, h: 0.12, fill: { color: ACCENT_COLOR }, line: { type: "none" } });
  // "제목: " prefix matches the label format importPptx.mjs's title-detection looks for - same
  // convention exportPdf.mjs/exportMd.mjs already use. Kept large/bold so it still reads as a title.
  slide.addText(`제목: ${meeting.title || "-"}`, { x: CONTENT_X, y: 1.0, w: CONTENT_WIDTH, h: 1.6, fontSize: 26, bold: true, valign: "top" });
  slide.addText(
    [
      { text: `날짜: ${meeting.date || "-"}\n`, options: { fontSize: 14 } },
      { text: `시작: ${meeting.startTime || "-"}\n`, options: { fontSize: 14 } },
      { text: `종료: ${meeting.endTime || "-"}\n`, options: { fontSize: 14 } },
      { text: `장소: ${meeting.location || "-"}\n`, options: { fontSize: 14 } },
      { text: `주관자: ${meeting.organizer || "-"}\n`, options: { fontSize: 14 } },
      { text: `간사: ${meeting.secretary || "-"}\n`, options: { fontSize: 14 } },
      { text: `참석자: ${attendeeNamesOf(meeting) || "-"}`, options: { fontSize: 14 } }
    ],
    { x: CONTENT_X, y: 2.9, w: CONTENT_WIDTH, h: 2.5, valign: "top" }
  );
}

function addAgendaSlide(pptx, agenda) {
  const slide = pptx.addSlide();
  slide.addText("Agenda", SLIDE_TITLE_OPTIONS);

  if (agenda.length === 0) {
    slide.addText("(없음)", { x: CONTENT_X, y: 1.3, w: CONTENT_WIDTH, h: 0.5, fontSize: 12 });
    return;
  }

  const rows = [
    headerRow(["No", "제목", "발표시간", "발표자료", "발표자"]),
    ...agenda.map((item) => [
      String(item.no ?? ""),
      item.title || "-",
      `${item.durationMinutes ?? 0}분`,
      item.material || "-",
      item.presenter || "-"
    ])
  ];

  slide.addTable(rows, { ...TABLE_OPTIONS, colW: [0.44, 2.62, 0.95, 1.53, 1.16] });
}

function addActionItemSlide(pptx, actionItems) {
  const slide = pptx.addSlide();
  slide.addText("A/I List", SLIDE_TITLE_OPTIONS);

  if (actionItems.length === 0) {
    slide.addText("(없음)", { x: CONTENT_X, y: 1.3, w: CONTENT_WIDTH, h: 0.5, fontSize: 12 });
    return;
  }

  const rows = [
    headerRow(["No", "제목", "발표자료", "발표자"]),
    ...actionItems.map((item) => [String(item.no ?? ""), item.title || "-", item.material || "-", item.presenter || "-"])
  ];

  slide.addTable(rows, { ...TABLE_OPTIONS, colW: [0.44, 3.06, 1.97, 1.24] });
}

function addTableSlide(pptx, title, block) {
  const slide = pptx.addSlide();
  slide.addText(title, SLIDE_TITLE_OPTIONS);
  const rows = [headerRow(block.header), ...block.rows.map((row) => block.header.map((_, columnIndex) => row[columnIndex] ?? ""))];
  slide.addTable(rows, TABLE_OPTIONS);
}

// A section whose body is empty (e.g. "## 회의 안건 논의 결과 요약" immediately followed by the
// first numbered agenda item, which splitIntoSections already broke out into its own section) -
// renders as a plain section-divider slide instead of being silently dropped, the same way a real
// meeting-minutes deck uses a divider before its per-topic slides.
function addSectionDividerSlide(pptx, title) {
  const slide = pptx.addSlide();
  slide.addShape("rect", { x: 0, y: 0, w: SLIDE_WIDTH_IN, h: 0.12, fill: { color: ACCENT_COLOR }, line: { type: "none" } });
  slide.addText(title, {
    x: CONTENT_X,
    y: SLIDE_HEIGHT_IN / 2 - 0.75,
    w: CONTENT_WIDTH,
    h: 1.5,
    fontSize: 24,
    bold: true,
    color: ACCENT_COLOR,
    align: "center",
    valign: "middle"
  });
}

function addSectionContentSlides(pptx, title, body) {
  let pending = [];
  let pendingChars = 0;
  let continuationCount = 0;

  const flush = () => {
    if (pending.length === 0) {
      return;
    }
    continuationCount += 1;
    const slide = pptx.addSlide();
    const slideTitle = continuationCount === 1 ? title : `${title} (계속)`;
    slide.addText(slideTitle, SLIDE_TITLE_OPTIONS);
    slide.addText(richRunsForBlocks(pending), { x: CONTENT_X, y: 1.4, w: CONTENT_WIDTH, h: 8.2, fontSize: 14, valign: "top", wrap: true });
    pending = [];
    pendingChars = 0;
  };

  for (const block of body) {
    const chars = blockCharCount(block);
    if (pendingChars > 0 && pendingChars + chars > MINUTES_CHAR_BUDGET) {
      flush();
    }
    pending.push(block);
    pendingChars += chars;
  }

  flush();
}

// Renders the LLM-generated 회의록 markdown as one slide per section instead of packing arbitrary
// chunks of text together - see splitIntoSections for how a "section" is determined (every real
// heading, plus every bold-numbered Agenda item pseudo-heading) and parseMinutesMarkdown.mjs for
// the underlying block parser. A section holding a GFM table (the mandatory "할일" table, always
// exactly one per MINUTES_SYSTEM_PROMPT) gets a real pptxgenjs table slide; an empty section
// becomes a lightweight divider slide; everything else becomes one or more flowing-text slides.
function addMinutesSlides(pptx, minutes) {
  const trimmed = (minutes || "").trim();
  if (!trimmed) {
    return;
  }

  const sections = splitIntoSections(parseMinutesMarkdown(trimmed));

  for (const section of sections) {
    const tableBlock = section.body.find((block) => block.type === "table");
    const title = section.title || "회의록";

    if (tableBlock) {
      addTableSlide(pptx, title, tableBlock);
      const rest = section.body.filter((block) => block !== tableBlock);
      if (rest.length > 0) {
        addSectionContentSlides(pptx, title, rest);
      }
      continue;
    }

    if (section.body.length === 0) {
      addSectionDividerSlide(pptx, title);
      continue;
    }

    addSectionContentSlides(pptx, title, section.body);
  }
}

export async function buildPptxExport(meetings) {
  const pptx = new pptxgen();
  pptx.defineLayout({ name: "MEETINGNOTE_PORTRAIT", width: SLIDE_WIDTH_IN, height: SLIDE_HEIGHT_IN });
  pptx.layout = "MEETINGNOTE_PORTRAIT";

  meetings.forEach((meeting) => {
    addTitleSlide(pptx, meeting);
    // A/I List (planned before this meeting) comes before Agenda (this meeting's own topics).
    addActionItemSlide(pptx, meeting.actionItems ?? []);
    addAgendaSlide(pptx, meeting.agenda ?? []);
    addMinutesSlides(pptx, meeting.minutes);
  });

  if (meetings.length === 0) {
    const slide = pptx.addSlide();
    slide.addText("(내보낼 회의가 없습니다)", { x: CONTENT_X, y: 0.5, w: CONTENT_WIDTH, h: 1, fontSize: 18 });
  }

  // pptxgenjs's documented Node.js API returns a Buffer directly when outputType is
  // "nodebuffer" - could not verify against node_modules/pptxgenjs's type declarations since
  // dependencies are not installed in this sandbox yet, so this follows the official Node.js
  // usage docs for pptxgenjs 3.x.
  return pptx.write({ outputType: "nodebuffer" });
}
