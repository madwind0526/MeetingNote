import type { Meeting } from "../types/domain";
import { attendeeSummary } from "../types/domain";

export function meetingSearchableText(meeting: Meeting): string {
  return [
    meeting.title,
    meeting.organizer,
    attendeeSummary(meeting.attendees),
    ...meeting.agenda.map((item) => item.title),
    meeting.minutes
  ]
    .join(" ")
    .toLowerCase();
}

export function tokenizeQuestion(question: string): string[] {
  return question
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

export interface ScoredMeeting {
  meeting: Meeting;
  score: number;
}

// Not a real search index - just enough token-overlap scoring to surface plausibly relevant
// meetings, either as the answer for the no-LLM fallback or as grounding context handed to a
// real LLM provider.
export function scoreMeetingsForQuestion(question: string, meetings: Meeting[]): ScoredMeeting[] {
  const tokens = tokenizeQuestion(question);

  if (tokens.length === 0) {
    return [];
  }

  return meetings
    .map((meeting) => {
      const text = meetingSearchableText(meeting);
      const score = tokens.reduce((total, token) => total + (text.includes(token) ? 1 : 0), 0);

      return { meeting, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
}
