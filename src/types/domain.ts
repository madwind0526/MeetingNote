export type ViewMode = "card" | "list" | "mesh";

export interface Attendee {
  id: string;
  name: string;
  role: string;
  isKeyAttendee: boolean;
  isPresenter: boolean;
}

// A person's most senior role in this meeting, for the audio speaker picker's role badge (see
export type SpeakerRoleBadge = "주관자" | "간사" | "발표자";

export interface SpeakerRoleEntry {
  name: string;
  role: SpeakerRoleBadge | null;
}

export function emptyAttendee(): Attendee {
  return {
    id: typeof crypto !== "undefined" ? crypto.randomUUID() : String(Math.random()),
    name: "",
    role: "",
    isKeyAttendee: false,
    isPresenter: false
  };
}

// A/I List row - action items assigned during the meeting. `material` is a free-text label
// (e.g. a file name); `materialPath` is set when an actual file was attached via the form and
// points at its stored location under the configured attachments folder. `materialMdPath` is set
// when that file was a PDF/DOCX/PPTX and got an automatic Markdown conversion saved alongside it
// (B4, see server/converters/toMarkdown.mjs) - used later by B5 to feed the material's content to
// an LLM together with the matching STT transcript.
export interface ActionItem {
  no: number;
  title: string;
  material: string;
  materialPath?: string;
  materialMdPath?: string;
  presenter: string;
}

export function emptyActionItem(no: number): ActionItem {
  return { no, title: "", material: "", materialPath: undefined, materialMdPath: undefined, presenter: "" };
}

// with B1's badge labels) - generated from this item's material + the meeting's full transcript,
// see PresentationSummaryModal.tsx and server/llm.mjs's buildPresentationSummaryPrompt.
export interface AgendaItem {
  no: number;
  title: string;
  durationMinutes: number;
  material: string;
  materialPath?: string;
  materialMdPath?: string;
  presenter: string;
  presentationSummary?: string;
}

export function emptyAgendaItem(no: number): AgendaItem {
  return {
    no,
    title: "",
    durationMinutes: 10,
    material: "",
    materialPath: undefined,
    materialMdPath: undefined,
    presenter: "",
    presentationSummary: undefined
  };
}

// One turn of speech, produced by STT + pause-based diarization. `speaker` is a heuristic label
// ("A", "B", ...) mapped to a real attendee name via AudioAnalysis.speakerMap.
export interface TranscriptSegment {
  speaker: string;
  startSec: number;
  endSec: number;
  text: string;
}

export interface AudioPreprocessing {
  vocalIsolation: boolean;
  noiseRemoval: boolean;
  normalize: boolean;
}

export interface AudioAnalysis {
  fileName: string;
  durationSec: number;
  preprocessing: AudioPreprocessing;
  transcriptSegments: TranscriptSegment[];
  speakerMap: Record<string, string>;
  analyzedAt: string;
  // B7 audio retention policy: the original recording is kept alongside the meeting's materials
  // (unlike a hypothetical per-speaker sliced copy, which this app never actually creates -
  // separate files) - set once uploaded via MeetingFormModal's handleAudioComplete.
  audioPath?: string;
  transcriptPath?: string;
}

export interface MeetingComment {
  id: string;
  authorId: string;
  content: string;
  createdAt: string;
}

export interface Meeting {
  id: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  organizer: string;
  secretary: string;
  attendees: Attendee[];
  actionItems: ActionItem[];
  agenda: AgendaItem[];
  audio: AudioAnalysis | null;
  minutes: string;
  authorId: string;
  comments: MeetingComment[];
  createdAt: string;
  updatedAt: string;
}

export type MeetingDraft = Omit<Meeting, "id" | "authorId" | "comments" | "createdAt" | "updatedAt">;

export const emptyMeetingDraft: MeetingDraft = {
  title: "",
  date: "",
  startTime: "",
  endTime: "",
  location: "",
  organizer: "",
  secretary: "",
  attendees: [],
  actionItems: [],
  agenda: [],
  audio: null,
  minutes: ""
};

// A meeting's delete/edit permission (and comment delete permission) is author-or-admin, matching
// Club's canDeletePost pattern - enforced client-side only, same trust model as every other route
// in this app (see vite.config.mts's /api/members comment).
export function canDeleteMeeting(meeting: Pick<Meeting, "authorId">, member: PublicMember): boolean {
  return member.role === "admin" || meeting.authorId === member.id;
}

export type BoardCategory = "공지" | "일반" | "요청" | "QnA";

export const boardCategories: BoardCategory[] = ["공지", "일반", "요청", "QnA"];

export interface BoardComment {
  id: string;
  authorId: string;
  content: string;
  createdAt: string;
  parentCommentId?: string;
}

export interface BoardPost {
  id: string;
  category: BoardCategory;
  title: string;
  content: string;
  authorId: string;
  createdAt: string;
  pinned: boolean;
  comments: BoardComment[];
}

// Same author-or-admin permission model as canDeleteMeeting, ported from Club's canDeletePost.
export function canDeleteBoardPost(post: Pick<BoardPost, "authorId">, member: PublicMember): boolean {
  return member.role === "admin" || post.authorId === member.id;
}

export type MeetingStatus = "scheduled" | "needs_minutes" | "completed";

export const meetingStatusLabels: Record<MeetingStatus, string> = {
  scheduled: "예정",
  needs_minutes: "회의록 작성 필요",
  completed: "완료"
};

// scheduled: meeting end time is still in the future.
// needs_minutes: meeting has passed but `minutes` is still empty.
// completed: meeting has passed and `minutes` has been generated.
export function computeMeetingStatus(meeting: Pick<Meeting, "date" | "startTime" | "endTime" | "minutes">): MeetingStatus {
  const timePart = meeting.endTime || meeting.startTime || "23:59";
  const meetingEnd = new Date(`${meeting.date}T${timePart}:00`);
  const isPast = !Number.isNaN(meetingEnd.getTime()) && meetingEnd.getTime() < Date.now();

  if (!isPast) {
    return "scheduled";
  }

  return meeting.minutes.trim() ? "completed" : "needs_minutes";
}

// Meetings whose minutes predate this feature (or are still empty) simply yield no tags.
export function extractMeetingTags(meeting: Pick<Meeting, "minutes">): string[] {
  const minutes = meeting.minutes || "";
  const headingMatch = minutes.match(/^##\s*태그\s*$/m);

  if (!headingMatch || headingMatch.index === undefined) {
    return [];
  }

  const afterHeading = minutes.slice(headingMatch.index + headingMatch[0].length);
  const nextHeadingIndex = afterHeading.search(/^##\s/m);
  const tagSection = nextHeadingIndex === -1 ? afterHeading : afterHeading.slice(0, nextHeadingIndex);
  const tags = tagSection
    .split(/\s+/)
    .map((token) => token.replace(/^#+/, "").trim())
    .filter(Boolean);

  return Array.from(new Set(tags));
}

// Same cap as Mesh view's Top TAG limit (src/components/views/MeshView.tsx's meshTopTagLimit) -
// what Mesh view's own node degree/tooltip shows for that same meeting, so the connection-count
// filter and the Mesh view graph never disagree about "how connected" a meeting is.
const CONNECTION_TOP_TAG_LIMIT = 10;

// Degree of each meeting in the tag-connection graph - two meetings are connected if they share at
// least one of the dataset's top-N most common tags (see extractMeetingTags above). Used by the
// filter's Connection range slider; kept independent of MeshView's own edge/layout computation
// (which additionally caps *rendered* edge lines for visual clarity) since the filter only needs
// the raw degree, not which specific edges get drawn.
export function computeMeetingConnectionCounts(meetings: Meeting[]): Map<string, number> {
  const tagCounts = new Map<string, number>();
  meetings.forEach((meeting) => {
    extractMeetingTags(meeting).forEach((tag) => {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    });
  });

  const topTagNames = new Set(
    Array.from(tagCounts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, CONNECTION_TOP_TAG_LIMIT)
      .map(([tag]) => tag)
  );

  const meetingIdsByTag = new Map<string, string[]>();
  meetings.forEach((meeting) => {
    extractMeetingTags(meeting)
      .filter((tag) => topTagNames.has(tag))
      .forEach((tag) => {
        meetingIdsByTag.set(tag, [...(meetingIdsByTag.get(tag) ?? []), meeting.id]);
      });
  });

  const degrees = new Map<string, number>();
  meetingIdsByTag.forEach((meetingIds) => {
    for (let leftIndex = 0; leftIndex < meetingIds.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < meetingIds.length; rightIndex += 1) {
        const from = meetingIds[leftIndex];
        const to = meetingIds[rightIndex];
        degrees.set(from, (degrees.get(from) ?? 0) + 1);
        degrees.set(to, (degrees.get(to) ?? 0) + 1);
      }
    }
  });

  return degrees;
}

export type FilterTermOperator = "and" | "or" | "not";

export interface FilterTerm {
  operator: FilterTermOperator;
  value: string;
}

// Small query syntax for the filter modal's free-text fields: comma-separated terms, each
// optionally prefixed with [*] (AND, required), [+] (OR, at least one required if any [+] terms
// are present), or [-] (NOT, excluded). A term with no prefix defaults to AND, so a plain single
// word behaves exactly like the old single-substring filter did.
export function parseFilterTerms(input: string): FilterTerm[] {
  return input
    .split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const match = raw.match(/^\[([*+-])\]\s*(.*)$/);

      if (!match) {
        return { operator: "and" as FilterTermOperator, value: raw.toLowerCase() };
      }

      const [, symbol, value] = match;
      const operator: FilterTermOperator = symbol === "+" ? "or" : symbol === "-" ? "not" : "and";

      return { operator, value: value.trim().toLowerCase() };
    })
    .filter((term) => term.value);
}

// Evaluated as (any OR term present, if any exist) AND (no NOT term present) AND (every AND term
// present) - OR is checked first, then NOT, then AND, per the exact short-circuit order requested,
// though the final boolean result is the same regardless of check order since it's just an AND of
// three independent sub-results.
export function matchesFilterTerms(haystack: string, terms: FilterTerm[]): boolean {
  if (terms.length === 0) {
    return true;
  }

  const lowerHaystack = haystack.toLowerCase();
  const orTerms = terms.filter((term) => term.operator === "or");
  const notTerms = terms.filter((term) => term.operator === "not");
  const andTerms = terms.filter((term) => term.operator === "and");

  if (orTerms.length > 0 && !orTerms.some((term) => lowerHaystack.includes(term.value))) {
    return false;
  }

  if (notTerms.some((term) => lowerHaystack.includes(term.value))) {
    return false;
  }

  return andTerms.every((term) => lowerHaystack.includes(term.value));
}

export type ExportFormat = "pdf" | "docx" | "pptx" | "md" | "json";
export type ImportFormat = "pdf" | "docx" | "pptx" | "md" | "txt" | "json";
export type ImportDuplicateMode = "replace" | "add" | "skip";

export interface MeetingFilters {
  statuses: MeetingStatus[];
  titleText: string;
  organizerText: string;
  // Matches against Agenda/A-I List item `presenter` fields.
  presenterText: string;
  // Matches against Agenda items' B5 presentationSummary field.
  presentationSummaryText: string;
  // Matches against extractMeetingTags(meeting).
  tagText: string;
  // Mesh-view tag-connection degree range (see computeMeetingConnectionCounts). 0 for either bound
  // is a sentinel for "unset" - connectionMin: 0 means no lower bound, connectionMax: 0 means no
  // upper bound (rather than "exactly 0 connections"), so the slider's max thumb can represent
  // "no limit" without needing to know the dataset's current max connection count in advance.
  connectionMin: number;
  connectionMax: number;
  dateFrom: string;
  dateTo: string;
}

export const emptyFilters: MeetingFilters = {
  statuses: [],
  titleText: "",
  organizerText: "",
  presenterText: "",
  presentationSummaryText: "",
  tagText: "",
  connectionMin: 0,
  connectionMax: 0,
  dateFrom: "",
  dateTo: ""
};

export interface DictionaryEntry {
  id: string;
  from: string;
  to: string;
  description: string;
}

export type MemberRole = "admin" | "일반";

export interface Member {
  id: string;
  name: string;
  loginId: string;
  passwordHash: string;
  role: MemberRole;
  createdAt: string;
  // Soft-delete flag - disabling keeps the account resolvable by id so existing
  // authorship references (meeting authorId, board post authorId, comments) keep
  // showing a real name instead of a dangling reference. Disabled accounts can't log in.
  disabled: boolean;
}

// Member shape sent to the renderer - never carries the password hash.
export type PublicMember = Omit<Member, "passwordHash">;

export interface LoginResult {
  ok: boolean;
  member?: PublicMember;
  sessionToken?: string;
  error?: string;
}

export type LlmProviderId = "local-preview" | "claude-cli" | "anthropic-api" | "ollama";

export interface LlmProviderOption {
  id: LlmProviderId;
  label: string;
  description: string;
  requiresApiKey: boolean;
  requiresOllamaConfig?: boolean;
}

export const llmProviders: LlmProviderOption[] = [
  {
    id: "local-preview",
    label: "로컬 검색 (LLM 없음)",
    description: "키워드 검색만, 회의록 자동 작성 불가",
    requiresApiKey: false
  },
  {
    id: "ollama",
    label: "Ollama (로컬)",
    description: "로컬/사내망 Ollama 서버 필요",
    requiresApiKey: false,
    requiresOllamaConfig: true
  },
  {
    id: "claude-cli",
    label: "Claude CLI",
    description: "Claude Code CLI 설치 필요",
    requiresApiKey: false
  },
  {
    id: "anthropic-api",
    label: "Anthropic API",
    description: "API 키 필요",
    requiresApiKey: true
  }
];

export const defaultOllamaBaseUrl = "http://127.0.0.1:11434";

export type SttProviderId = "mock" | "local-whisper-cli" | "local-whisperx" | "openai-whisper" | "naver-clova";

export interface SttProviderOption {
  id: SttProviderId;
  label: string;
  description: string;
  isFree: boolean;
  requiresApiKey: boolean;
  requiresLocalInstall?: boolean;
  requiresNaverClovaConfig?: boolean;
  requiresHuggingFaceToken?: boolean;
}

// Mirrors llmProviders below - free/local options first, paid API last, so Settings can render
export const sttProviders: SttProviderOption[] = [
  {
    id: "mock",
    label: "Mock (오프라인 미리보기, 무료)",
    description: "실제 인식 아님, 화면 확인용",
    isFree: true,
    requiresApiKey: false
  },
  {
    id: "local-whisper-cli",
    label: "로컬 Whisper (무료)",
    description: "Whisper CLI/ffmpeg 필요",
    isFree: true,
    requiresApiKey: false,
    requiresLocalInstall: true,
    requiresHuggingFaceToken: true
  },
  {
    id: "local-whisperx",
    label: "로컬 WhisperX (무료)",
    description: "WhisperX 필요",
    isFree: true,
    requiresApiKey: false,
    requiresLocalInstall: true,
    requiresHuggingFaceToken: true
  },
  {
    id: "openai-whisper",
    label: "OpenAI Whisper API (유료)",
    description: "OPENAI_API_KEY 필요",
    isFree: false,
    requiresApiKey: true
  },
  {
    id: "naver-clova",
    label: "Naver Clova Speech (유료)",
    description: "Invoke URL/Secret Key 필요",
    isFree: false,
    requiresApiKey: false,
    requiresNaverClovaConfig: true
  }
];

export interface AppSettings {
  theme: "light" | "dark";
  defaultView: ViewMode;
  llmProvider: LlmProviderId;
  ollamaBaseUrl: string;
  ollamaModel: string;
  sttProvider: SttProviderId;
  importDuplicateMode: ImportDuplicateMode;
  exportDefaultFormat: ExportFormat;
  // Absolute folder path where attached files and meeting audio are
  // copied into per-meeting subfolders. Empty string means "use the app's built-in default"
  // (data/attachments next to the app). Only changeable from the Electron desktop app, since a
  // plain browser tab can't pick a real folder path.
  attachmentsFolder: string;
  // "native" = Electron's OS file/folder dialogs (default). "builtin" = the app's own in-window
  // folder browser (FileNavigatorModal) instead - added for corporate environments where security
  // policy blocks the OS's native file dialog/Explorer integration entirely. Only takes effect in
  // the Electron desktop app.
  filePickerMode: "native" | "builtin";
  // Torch device for the three local tools that can use a GPU: Whisper CLI, WhisperX, and Demucs
  // (vocal isolation) - see server/settingsFile.mjs's resolveComputeDevice. "gpu" maps to "cuda".
  computeDevice: "cpu" | "gpu";
  // WhisperX's silero VAD onset/offset thresholds (--vad_onset/--vad_offset) - how confident the
  // voice-activity detector must be to mark speech starting/continuing. Only used by WhisperX.
  vadOnset: number;
  vadOffset: number;
  // Below this RMS amplitude, a chunked-analysis audio segment is treated as silence and skipped
  // entirely instead of being sent to STT - see useChunkedAudioAnalysis's SILENCE_RMS_THRESHOLD
  // default. Prevents Whisper-style hallucinated text on near-silent audio.
  silenceThreshold: number;
  // Per-meeting-length STT chunk size override (minutes), as free-form strings so the Settings
  // inputs can sit empty with a placeholder showing the built-in default instead of always holding
  // a live number - see useChunkedAudioAnalysis.ts's pickChunkSizeBounds, which parses these and
  chunkMinutesShort: string;
  chunkMinutesMedium: string;
  chunkMinutesLong: string;
  // Custom persona/style instruction prepended before this app's own system prompt for every LLM
  // means "no custom message" (just this app's own system prompt, unchanged).
  systemMessage: string;
}

export const defaultSettings: AppSettings = {
  theme: "dark",
  defaultView: "list",
  llmProvider: "local-preview",
  ollamaBaseUrl: defaultOllamaBaseUrl,
  ollamaModel: "",
  sttProvider: "local-whisperx",
  importDuplicateMode: "replace",
  exportDefaultFormat: "json",
  attachmentsFolder: "",
  filePickerMode: "native",
  computeDevice: "gpu",
  vadOnset: 0.3,
  vadOffset: 0.2,
  silenceThreshold: 0.004,
  chunkMinutesShort: "",
  chunkMinutesMedium: "",
  chunkMinutesLong: "",
  systemMessage: ""
};

export function attendeeSummary(attendees: Attendee[]): string {
  return attendees.map((attendee) => attendee.name).filter(Boolean).join(", ");
}

export function presenterAttendees(attendees: Attendee[]): Attendee[] {
  return attendees.filter((attendee) => attendee.isPresenter);
}

// attendee - one badge per person.
export function computeAttendeeBadges(attendees: Attendee[]): Record<string, string> {
  const badges: Record<string, string> = {};
  let presenterIndex = 0;
  let attendeeIndex = 0;

  for (const attendee of attendees) {
    if (attendee.isPresenter) {
      presenterIndex += 1;
      badges[attendee.id] = `발표${presenterIndex}`;
    } else {
      attendeeIndex += 1;
      badges[attendee.id] = `참석${attendeeIndex}`;
    }
  }

  return badges;
}
