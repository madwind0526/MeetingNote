// Small, purpose-built Markdown parser for this app's own LLM-generated 회의록 text (see
// MINUTES_SYSTEM_PROMPT in server/llm.mjs) - not a general Markdown engine. Recognizes exactly
// what that prompt actually produces: headings (#/##/### ...), GFM pipe tables, bullet lists
// (-/*), and plain paragraphs. Shared by all three exporters (DOCX/PDF/PPTX) so "회의록의 표는
// 실제 표로" only has to be solved once instead of three times differently.
export function parseMinutesMarkdown(markdown) {
  const lines = (markdown || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;

  const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
  const isTableSeparator = (line) => /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(line);
  const splitRow = (line) =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      blocks.push({ type: "heading", level: headingMatch[1].length, text: headingMatch[2].trim() });
      i += 1;
      continue;
    }

    if (/^\s*(\*\s*){3,}$|^\s*(-\s*){3,}$|^\s*(_\s*){3,}$/.test(line)) {
      blocks.push({ type: "hr" });
      i += 1;
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const bulletMatch = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bulletMatch) {
      const items = [bulletMatch[1].trim()];
      i += 1;
      while (i < lines.length) {
        const nextBullet = /^\s*[-*]\s+(.*)$/.exec(lines[i]);
        if (!nextBullet) break;
        items.push(nextBullet[1].trim());
        i += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    const paragraphLines = [line.trim()];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^#{1,6}\s+/.test(lines[i]) && !isTableRow(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) {
      paragraphLines.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ type: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

// Splits "some **bold** text" into [{text, bold}] runs - shared by every exporter that wants
// **bold** rendered as real bold instead of literal asterisks. Anything else (links, code,
// italics, ...) passes through as plain text - matches what the minutes prompt actually uses.
export function parseInlineRuns(text) {
  const runs = [];
  const regex = /\*\*(.+?)\*\*/g;
  let lastIndex = 0;
  let match = regex.exec(text);

  while (match) {
    if (match.index > lastIndex) {
      runs.push({ text: text.slice(lastIndex, match.index), bold: false });
    }
    runs.push({ text: match[1], bold: true });
    lastIndex = regex.lastIndex;
    match = regex.exec(text);
  }
  if (lastIndex < text.length) {
    runs.push({ text: text.slice(lastIndex), bold: false });
  }

  return runs.length > 0 ? runs : [{ text, bold: false }];
}
