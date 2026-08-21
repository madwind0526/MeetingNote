export type ViewMode = "card" | "list" | "mesh";

export interface Attendee {
  id: string;
  name: string;
  role: string;
  isKeyAttendee: boolean;
  isPresenter: boolean;
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

// `presentationSummary` is B5's per-presentation structured output (질문/답변/의견/할일 lines tagged
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
  // "화자별 파형" in AudioAnalysisModal is just a client-side highlight of one shared waveform, not
  // separate files) - set once uploaded via MeetingFormModal's handleAudioComplete.
  audioPath?: string;
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

// LLM-generated minutes end with a "## 태그" section (see vite.config.mts's MINUTES_SYSTEM_PROMPT)
// listing 5-10 `#태그` tokens on one line. Mesh view uses this to connect meetings that share a tag.
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
// keeping this in sync means the "연결" count this function returns for a meeting always matches
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
export type ImportFormat = "pdf" | "docx" | "pptx" | "md" | "json";
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

// Shared shape for both the abbreviation dictionary (from=약어, to=확장글) and the correction
// dictionary (from=수정전, to=수정후) - same UI, same mechanics, only the column labels differ.
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
    description: "설치나 API 키 없이 저장된 회의록에서 키워드로 바로 검색합니다. 회의록 작성 시에는 안내 문구만 채워집니다.",
    requiresApiKey: false
  },
  {
    id: "ollama",
    label: "Ollama (로컬)",
    description: "이 PC(또는 사내망)에서 실행 중인 Ollama 서버로 로컬 모델을 호출합니다. API 키가 필요 없습니다.",
    requiresApiKey: false,
    requiresOllamaConfig: true
  },
  {
    id: "claude-cli",
    label: "Claude CLI",
    description: "이 PC에 설치된 Claude Code CLI(claude 명령)로 질문에 답하거나 회의록을 작성합니다. 별도 API 키가 필요 없습니다.",
    requiresApiKey: false
  },
  {
    id: "anthropic-api",
    label: "Anthropic API",
    description: "Anthropic API 키로 Claude 모델을 직접 호출합니다.",
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
// both provider lists with the same "무료" vs "유료" grouping convention.
export const sttProviders: SttProviderOption[] = [
  {
    id: "mock",
    label: "Mock (오프라인 미리보기, 무료)",
    description: "API 키나 설치 없이 그럴듯한 예시 대본을 생성합니다. 실제 음성 인식이 아니라 화면/흐름 확인용입니다.",
    isFree: true,
    requiresApiKey: false
  },
  {
    id: "local-whisper-cli",
    label: "로컬 Whisper (무료)",
    description: "이 PC에 설치된 OpenAI Whisper CLI(pip install -U openai-whisper, ffmpeg 필요)로 오프라인에서 실제 음성을 인식합니다. API 키는 필요 없지만 사전 설치가 필요합니다.",
    isFree: true,
    requiresApiKey: false,
    requiresLocalInstall: true
  },
  {
    id: "local-whisperx",
    label: "로컬 WhisperX GPU (무료)",
    description:
      "이 PC의 .venv-whisperx 환경과 CUDA GPU를 사용해 실제 회의 음성을 인식합니다. WhisperX와 FFmpeg shared build가 필요합니다. Hugging Face 토큰을 등록하면 화자 분리(누가 말했는지 구분)까지 자동으로 적용됩니다.",
    isFree: true,
    requiresApiKey: false,
    requiresLocalInstall: true,
    requiresHuggingFaceToken: true
  },
  {
    id: "openai-whisper",
    label: "OpenAI Whisper API (유료)",
    description: "업로드한 음성 파일을 OpenAI 서버에서 인식합니다. 설치 없이 정확도가 높지만 OPENAI_API_KEY와 사용 요금이 필요합니다.",
    isFree: false,
    requiresApiKey: true
  },
  {
    id: "naver-clova",
    label: "Naver Clova Speech (유료)",
    description:
      "업로드한 음성 파일을 NAVER Cloud CLOVA Speech Recognition(CSR)에서 인식합니다. 화자 분리가 자동으로 포함됩니다. 한국어 인식 정확도가 Whisper보다 높지만 NCP Invoke URL/Secret Key와 사용 요금이 필요합니다.",
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
  filePickerMode: "native"
};

export function attendeeSummary(attendees: Attendee[]): string {
  return attendees.map((attendee) => attendee.name).filter(Boolean).join(", ");
}

export function presenterAttendees(attendees: Attendee[]): Attendee[] {
  return attendees.filter((attendee) => attendee.isPresenter);
}

// Every attendee gets exactly one label - presenters count as "발표N" (table order among
// presenters), everyone else as "참석N" (table order among non-presenters). This is also the
// label vocabulary B5's structured minutes format keys quotes off of (질문/답변/의견/할일 lines are
// tagged "주관자-이름"/"발표1-이름"/"참석1-이름"), so a presenter never additionally counts as an
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
