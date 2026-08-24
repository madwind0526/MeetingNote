import type { AudioAnalysis } from "../types/domain";

function formatTranscriptTime(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function formatTranscriptText(audio: AudioAnalysis | null): string {
  if (!audio || audio.transcriptSegments.length === 0) {
    return "";
  }

  return audio.transcriptSegments
    .map((segment) => {
      const speaker = audio.speakerMap[segment.speaker] || segment.speaker || "화자 미상";
      return `[${formatTranscriptTime(segment.startSec)}-${formatTranscriptTime(segment.endSec)}] ${speaker}: ${segment.text}`;
    })
    .join("\n");
}

export function transcriptFileNameFromAudio(fileName: string): string {
  const cleanName = fileName.trim() || "meeting-audio";
  const dotIndex = cleanName.lastIndexOf(".");
  const baseName = dotIndex > 0 ? cleanName.slice(0, dotIndex) : cleanName;
  return `${baseName}-stt-transcript.txt`;
}

export interface ParsedTranscriptSegment {
  startSec: number;
  endSec: number;
  speaker: string;
  text: string;
}

// Matching closing delimiter for each opening one this parser recognizes - covers the common
// bracket styles a hand-edited or export-from-elsewhere transcript might use around the time
// range and speaker name ([...], {...}, (...), <...>, "...", '...').
const OPEN_TO_CLOSE: Record<string, string> = {
  "[": "]",
  "{": "}",
  "(": ")",
  "<": ">",
  '"': '"',
  "'": "'"
};

function extractDelimited(line: string, fromIndex: number): { content: string; nextIndex: number } | null {
  let index = fromIndex;
  while (index < line.length && /\s/.test(line[index])) {
    index += 1;
  }
  const closeChar = OPEN_TO_CLOSE[line[index]];
  if (!closeChar) {
    return null;
  }
  const closeIndex = line.indexOf(closeChar, index + 1);
  if (closeIndex === -1) {
    return null;
  }
  return { content: line.slice(index + 1, closeIndex).trim(), nextIndex: closeIndex + 1 };
}

function skipSeparators(line: string, fromIndex: number): number {
  let index = fromIndex;
  while (index < line.length && /[\s:,\-–—]/.test(line[index])) {
    index += 1;
  }
  return index;
}

const TIME_RANGE_RE = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*[-~]\s*(\d{1,2}:\d{2}(?::\d{2})?)$/;
const BARE_TIME_RANGE_RE = /^(\d{1,2}:\d{2}(?::\d{2})?)\s*[-~]\s*(\d{1,2}:\d{2}(?::\d{2})?)/;

function parseTimeToSeconds(value: string): number | null {
  const parts = value.split(":").map(Number);
  if (parts.some((part) => Number.isNaN(part))) {
    return null;
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

// Reads a transcript exported/hand-written elsewhere back into segments - the delimiter around the
// time range and speaker can be [ ], { }, ( ), < >, " " or ' ' (or none at all around the time
// range), so this doesn't assume one fixed format, only the shape "time range, then speaker, then
// the rest of the line is the utterance". A line that doesn't match this shape is skipped rather
// than aborting the whole import, since a pasted file can carry blank lines or a header.
export function parseTranscriptText(text: string): ParsedTranscriptSegment[] {
  const segments: ParsedTranscriptSegment[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    let cursor = 0;
    let timeRangeText: string | null = null;

    const bracketedTime = extractDelimited(line, cursor);
    if (bracketedTime) {
      timeRangeText = bracketedTime.content;
      cursor = bracketedTime.nextIndex;
    } else {
      const bareMatch = line.match(BARE_TIME_RANGE_RE);
      if (bareMatch) {
        timeRangeText = `${bareMatch[1]}-${bareMatch[2]}`;
        cursor = bareMatch[0].length;
      }
    }

    if (!timeRangeText) {
      continue;
    }

    const timeMatch = timeRangeText.match(TIME_RANGE_RE);
    if (!timeMatch) {
      continue;
    }

    const startSec = parseTimeToSeconds(timeMatch[1]);
    const endSec = parseTimeToSeconds(timeMatch[2]);
    if (startSec === null || endSec === null) {
      continue;
    }

    cursor = skipSeparators(line, cursor);

    let speaker = "";
    const bracketedSpeaker = extractDelimited(line, cursor);
    if (bracketedSpeaker) {
      speaker = bracketedSpeaker.content;
      cursor = bracketedSpeaker.nextIndex;
    } else {
      const speakerMatch = line.slice(cursor).match(/^([^\s:][^:]*?)\s*:\s*/);
      if (speakerMatch) {
        speaker = speakerMatch[1].trim();
        cursor += speakerMatch[0].length;
      }
    }

    cursor = skipSeparators(line, cursor);
    const content = line.slice(cursor).trim();

    if (!speaker || !content) {
      continue;
    }

    segments.push({ startSec, endSec, speaker, text: content });
  }

  return segments;
}
