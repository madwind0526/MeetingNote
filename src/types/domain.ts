export type ViewMode = "card" | "list";

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
// points at its stored location under the configured attachments folder.
export interface ActionItem {
  no: number;
  title: string;
  material: string;
  materialPath?: string;
  presenter: string;
}

export function emptyActionItem(no: number): ActionItem {
  return { no, title: "", material: "", materialPath: undefined, presenter: "" };
}

export interface AgendaItem {
  no: number;
  title: string;
  durationMinutes: number;
  material: string;
  materialPath?: string;
  presenter: string;
}

export function emptyAgendaItem(no: number): AgendaItem {
  return { no, title: "", durationMinutes: 10, material: "", materialPath: undefined, presenter: "" };
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
}

export interface Meeting {
  id: string;
  title: string;
  date: string;
  startTime: string;
  endTime: string;
  organizer: string;
  attendees: Attendee[];
  actionItems: ActionItem[];
  agenda: AgendaItem[];
  audio: AudioAnalysis | null;
  minutes: string;
  createdAt: string;
  updatedAt: string;
}

export type MeetingDraft = Omit<Meeting, "id" | "createdAt" | "updatedAt">;

export const emptyMeetingDraft: MeetingDraft = {
  title: "",
  date: "",
  startTime: "",
  endTime: "",
  organizer: "",
  attendees: [],
  actionItems: [],
  agenda: [],
  audio: null,
  minutes: ""
};

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

export type ExportFormat = "pdf" | "docx" | "pptx" | "json";
export type ImportFormat = "pdf" | "docx" | "pptx" | "json";
export type ImportDuplicateMode = "replace" | "add" | "skip";

export interface MeetingFilters {
  statuses: MeetingStatus[];
  organizerText: string;
  attendeeText: string;
  // Matches against title, agenda item titles, and A/I List item titles.
  keywordText: string;
  dateFrom: string;
  dateTo: string;
}

export const emptyFilters: MeetingFilters = {
  statuses: [],
  organizerText: "",
  attendeeText: "",
  keywordText: "",
  dateFrom: "",
  dateTo: ""
};

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

export type SttProviderId = "mock" | "local-whisper-cli" | "local-whisperx" | "openai-whisper";

export interface SttProviderOption {
  id: SttProviderId;
  label: string;
  description: string;
  isFree: boolean;
  requiresApiKey: boolean;
  requiresLocalInstall?: boolean;
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
    description: "이 PC의 .venv-whisperx 환경과 CUDA GPU를 사용해 실제 회의 음성을 인식합니다. API 키는 필요 없지만 WhisperX와 FFmpeg shared build가 필요합니다.",
    isFree: true,
    requiresApiKey: false,
    requiresLocalInstall: true
  },
  {
    id: "openai-whisper",
    label: "OpenAI Whisper API (유료)",
    description: "업로드한 음성 파일을 OpenAI 서버에서 인식합니다. 설치 없이 정확도가 높지만 OPENAI_API_KEY와 사용 요금이 필요합니다.",
    isFree: false,
    requiresApiKey: true
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
}

export const defaultSettings: AppSettings = {
  theme: "dark",
  defaultView: "list",
  llmProvider: "local-preview",
  ollamaBaseUrl: defaultOllamaBaseUrl,
  ollamaModel: "",
  sttProvider: "local-whisperx",
  importDuplicateMode: "replace",
  exportDefaultFormat: "pdf",
  attachmentsFolder: ""
};

export function attendeeSummary(attendees: Attendee[]): string {
  return attendees.map((attendee) => attendee.name).filter(Boolean).join(", ");
}

export function presenterAttendees(attendees: Attendee[]): Attendee[] {
  return attendees.filter((attendee) => attendee.isPresenter);
}
