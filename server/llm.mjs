import spawn from "cross-spawn";
import { existsSync } from "node:fs";
import path from "node:path";
import { readEnvFile } from "./envFile.mjs";
import { readAppSettings } from "./settingsFile.mjs";

const WINDOWS_EXECUTABLE_EXTENSIONS = [".cmd", ".exe", ".ps1", ".bat", ""];

// Cheap existence-only check (no subprocess spawn) - scans PATH for a file literally named
// `command` with a common Windows executable extension. Used instead of actually running the
// command just to see if it's there.
function isCommandInstalled(command) {
  const pathEnv = process.env.PATH || process.env.Path || "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);

  for (const dir of dirs) {
    for (const ext of WINDOWS_EXECUTABLE_EXTENSIONS) {
      if (existsSync(path.join(dir, `${command}${ext}`))) {
        return true;
      }
    }
  }

  return false;
}

// A full meeting-minutes prompt (whole transcript + agenda + materials) genuinely takes longer to
// generate than a short query - measured a real presentation-summary call getting SIGTERM-killed
// (child_process's `timeout` option, surfaced as "exited with code null") right at the old 60s
// mark. Every other STT/diarization step in this app already budgets minutes, not seconds
// (TRANSCRIBE_TIMEOUT_MS=600000, DIARIZE_TIMEOUT_MS=300000 in sttLocalWhisperCli.mjs) - 60s was an
// outlier, not a deliberate choice.
const CLAUDE_CLI_TIMEOUT_MS = 180000;
const ANTHROPIC_MODEL = "claude-3-5-haiku-20241022";

// cross-spawn resolves the real claude.cmd/.ps1 shim on Windows and passes arguments through
// argv (not a shell string), so a question containing shell metacharacters (&, |, `, $()...)
// can't be interpreted as a second command - unlike `exec`/`execFile` with `shell: true`.
function runCommand(command, args, { timeoutMs, cwd, stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { timeout: timeoutMs, cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
        return;
      }

      resolve(stdout.trim());
    });

    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

// LLMs occasionally wrap an entire markdown response in a ```markdown ... ``` (or plain
// ``` ... ```) code fence, especially when asked to "output markdown" - observed from claude-cli
// on 2 of 11 real 회의록 generations in one batch run. Left untouched, remark-gfm (the in-app
// renderer) and parseMinutesMarkdown.mjs (the exporters) both see one giant fenced code block
// spanning the whole document, so headings/tables/bold all render as literal text instead of
// being parsed. Only strips the wrapper when it encloses the *entire* trimmed response - a
// response that legitimately contains a fenced code sample alongside other content is left alone.
function stripWrappingCodeFence(text) {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z]*\n([\s\S]*)\n```$/.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

// deep=false (the default) only scans PATH for a file named `claude` - no subprocess spawn.
// deep=true actually runs `claude --version` to confirm it works, for the user's explicit
// "지금 확인" action instead of running automatically on every Settings open.
export async function checkClaudeCliAvailable(deep = false) {
  if (!deep) {
    return { available: isCommandInstalled("claude"), version: null };
  }

  try {
    const version = await runCommand("claude", ["--version"], { timeoutMs: 10000 });
    return { available: true, version };
  } catch {
    return { available: false, version: null };
  }
}

// Settings' "System Message" (아래 LLM 선택) - a user-authored persona/style instruction (tone,
// what to emphasize) prepended before this app's own structured system prompt (output format,
// language, refusal rules), which still has to win when the two conflict - a user free-typing
// "간결하게 정리하세요" shouldn't be able to accidentally break the required output format.
async function resolveSystemPrompt(basePrompt) {
  const settings = await readAppSettings();
  const custom = typeof settings?.systemMessage === "string" ? settings.systemMessage.trim() : "";
  return custom ? `${custom}\n\n${basePrompt}` : basePrompt;
}

export async function askClaudeCli(systemPrompt, userPrompt) {
  try {
    const resolvedSystemPrompt = await resolveSystemPrompt(systemPrompt);
    // Running `claude -p` inside this project's own folder would otherwise load this repo's
    // CLAUDE.md and answer in character as "the MeetingNote coding assistant" instead of the
    // prompt, even though the question has nothing to do with code. `--system-prompt` replaces
    // the CLI's default system prompt outright, which sidesteps that regardless of cwd - no
    // need to run from a neutral directory.
    //
    // The user prompt (question + meeting data) goes over stdin rather than as a CLI argument:
    // a multi-line, multi-KB argument routed through cmd.exe (required to launch the .cmd shim
    // on Windows) gets mangled/truncated, so the CLI would see an empty or corrupted prompt.
    const result = await runCommand("claude", ["-p", "--system-prompt", resolvedSystemPrompt], {
      timeoutMs: CLAUDE_CLI_TIMEOUT_MS,
      stdin: userPrompt
    });
    return stripWrappingCodeFence(result);
  } catch (error) {
    throw new Error(`Claude CLI 실행에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function checkAnthropicApiKeyConfigured() {
  const env = await readEnvFile();
  return Boolean(env.ANTHROPIC_API_KEY);
}

export async function askAnthropicApi(systemPrompt, userPrompt) {
  const env = await readEnvFile();
  const apiKey = env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error("Anthropic API 키가 설정되지 않았습니다. 설정에서 먼저 등록해 주세요.");
  }

  const resolvedSystemPrompt = await resolveSystemPrompt(systemPrompt);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      // 1024 was enough for a short query answer but silently truncates a full structured meeting
      // record (multi-agenda summary + 할일 table + tags) for anything beyond a short meeting -
      // 8192 gives real headroom for an hour-long, multi-agenda meeting's minutes.
      max_tokens: 8192,
      system: resolvedSystemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Anthropic API 호출에 실패했습니다 (${response.status}): ${errorText.slice(0, 200)}`);
  }

  const payload = await response.json();
  const text = (payload.content ?? []).map((block) => block.text ?? "").join("");

  return stripWrappingCodeFence(text);
}

export async function checkOllamaAvailable(baseUrl) {
  try {
    const response = await fetch(new URL("/api/tags", baseUrl), { signal: AbortSignal.timeout(4000) });

    if (!response.ok) {
      return { available: false, models: [] };
    }

    const payload = await response.json();
    return { available: true, models: (payload.models ?? []).map((model) => model.name) };
  } catch {
    return { available: false, models: [] };
  }
}

export async function askOllama(systemPrompt, userPrompt, baseUrl, model) {
  if (!baseUrl || !model) {
    throw new Error("Ollama 서버 주소와 모델을 먼저 설정해 주세요.");
  }

  const resolvedSystemPrompt = await resolveSystemPrompt(systemPrompt);

  let response;
  try {
    response = await fetch(new URL("/api/chat", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: "system", content: resolvedSystemPrompt },
          { role: "user", content: userPrompt }
        ],
        // Without this, Ollama falls back to the model file's own default context window (often
        // 2048-4096 tokens for many models) - a full hour-long meeting's transcript can exceed that
        // on its own, and Ollama silently drops the earliest input rather than erroring, so this
        // has to be set explicitly rather than left to the model default.
        options: { num_ctx: 8192 }
      })
    });
  } catch (error) {
    throw new Error(`Ollama 서버(${baseUrl})에 연결하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Ollama 호출에 실패했습니다 (${response.status}): ${errorText.slice(0, 200)}`);
  }

  const payload = await response.json();
  return stripWrappingCodeFence(String(payload.message?.content ?? ""));
}

// Builds the user-message prompt for /api/llm/query. `rows` are already-formatted, one-line-per-
// meeting summaries assembled by the caller (see vite.config.mts's buildLlmQueryUserPrompt),
// since only vite.config.mts knows the LlmMeeting shape it wants to summarize.
export function buildQueryPrompt(question, rows) {
  const rowsText = rows.length ? rows.join("\n") : "(등록된 회의가 없습니다)";

  return ["[회의 목록]", rowsText, "", "[질문]", question].join("\n");
}

function formatMmSs(totalSeconds) {
  const safeSeconds = Number.isFinite(totalSeconds) ? Math.max(0, Math.floor(totalSeconds)) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function resolveSpeakerName(speaker, speakerMap) {
  const mapped = speakerMap && typeof speakerMap === "object" ? speakerMap[speaker] : undefined;
  return mapped && mapped.trim() ? mapped : speaker || "화자 미상";
}

// Builds the user-message prompt for /api/llm/minutes. `meeting` is a plain object matching the
// Meeting shape from src/types/domain.ts (title, date, startTime, endTime, organizer, attendees,
// agenda, actionItems, audio, minutes) - sent to the LLM alongside MINUTES_SYSTEM_PROMPT.
export function buildMinutesPrompt(meeting) {
  const source = meeting && typeof meeting === "object" ? meeting : {};
  const attendees = Array.isArray(source.attendees) ? source.attendees : [];
  const agenda = Array.isArray(source.agenda) ? source.agenda : [];
  const actionItems = Array.isArray(source.actionItems) ? source.actionItems : [];
  const audio = source.audio && typeof source.audio === "object" ? source.audio : null;

  const sections = [];

  sections.push(
    ["[회의 기본정보]", `제목: ${source.title || "-"}`, `일시: ${source.date || "-"} ${source.startTime || ""}-${source.endTime || ""}`, `주관자: ${source.organizer || "-"}`].join(
      "\n"
    )
  );

  const attendeeLines = attendees.length
    ? attendees.map((attendee) => `- ${attendee.name || "-"} (${attendee.role || "-"})${attendee.isPresenter ? " [발표자]" : ""}`)
    : ["(참석자 정보 없음)"];
  sections.push(["[참석자 목록]", ...attendeeLines].join("\n"));

  // A/I List is listed before Agenda: it holds action items planned *before* this meeting even
  // starts, so it establishes context the agenda discussion builds on - matches the order the
  // meeting registration form and detail view use.
  const actionItemLines = actionItems.length
    ? actionItems.map((item) => `${item.no}. ${item.title || "-"} (담당: ${item.presenter || "-"})`)
    : ["(사전 A/I 없음)"];
  sections.push(["[A/I List - 회의 전 사전 계획된 액션 아이템]", ...actionItemLines].join("\n"));

  const agendaLines = agenda.length
    ? agenda.map((item) => `${item.no}. ${item.title || "-"} (${item.durationMinutes ?? 0}분, 발표자: ${item.presenter || "-"})`)
    : ["(Agenda 없음)"];
  sections.push(["[Agenda 목록 - 본 회의에서 다룰 안건]", ...agendaLines].join("\n"));

  // B6: an Agenda item that already went through B5's per-presentation summary
  // (presentationSummary) has already had its relevant transcript window found and tagged with
  // (질문)/(답변)/(의견)/(할일) - feed that in as authoritative per-agenda content instead of
  // making the LLM re-derive it from the full transcript below. Agenda items without a summary
  // fall back to [발언 대본] as before (unchanged behavior when B5 hasn't been used yet).
  const summarizedAgendaItems = agenda.filter((item) => typeof item.presentationSummary === "string" && item.presentationSummary.trim());
  if (summarizedAgendaItems.length) {
    const summaryLines = summarizedAgendaItems.flatMap((item) => [`[Agenda ${item.no}: ${item.title || "-"}]`, item.presentationSummary.trim(), ""]);
    sections.push(["[발표별 정리 - B5에서 이미 구조화된 내용, 우선 근거로 사용]", ...summaryLines].join("\n"));
  }

  if (audio && Array.isArray(audio.transcriptSegments) && audio.transcriptSegments.length) {
    const speakerMap = audio.speakerMap && typeof audio.speakerMap === "object" ? audio.speakerMap : {};
    const grouped = new Map();

    for (const segment of audio.transcriptSegments) {
      const speakerName = resolveSpeakerName(segment.speaker, speakerMap);

      if (!grouped.has(speakerName)) {
        grouped.set(speakerName, []);
      }

      grouped.get(speakerName).push(segment);
    }

    const transcriptLines = [];
    for (const [speakerName, segments] of grouped) {
      transcriptLines.push(`- ${speakerName}:`);
      for (const segment of segments) {
        transcriptLines.push(`  [${formatMmSs(segment.startSec)}-${formatMmSs(segment.endSec)}] ${segment.text || ""}`);
      }
    }

    sections.push(["[발언 대본]", ...transcriptLines].join("\n"));
  }

  return sections.join("\n\n");
}

// B5 has no real per-agenda timestamp data (a meeting has exactly one continuous recording), so
// this estimates each agenda item's rough position from the agenda's own planned order + 발표
// 시간(분), then snaps both edges to the nearest natural pause in the transcript (the biggest gap
// between consecutive segments within a search radius) instead of cutting at an arbitrary second -
// same idea as src/lib/audio.ts's findQuietCutSample, but over transcript segment gaps (already
// known from STT) instead of re-analyzing raw audio. This is inherently approximate (actual
// discussion can run over/under the planned time, and time spent on A/I List or earlier agenda
// items before this one isn't accounted for), which is why the search radius is generous and why
// the whole-transcript fallback below still exists for when nothing reasonable is found.
const WINDOW_SEARCH_RADIUS_SEC = 3 * 60;
const WINDOW_FALLBACK_DURATION_SEC = 5 * 60;
const WINDOW_EDGE_PADDING_SEC = 20;
// Hard cap regardless of how the time window above comes out - protects a small local model's
// context even if the estimated window ends up larger than expected (e.g. a long Q&A).
const WINDOW_MAX_CHARS = 8000;

function estimateAgendaStartSec(agenda, agendaItem) {
  const items = Array.isArray(agenda) ? agenda : [];
  const index = items.findIndex((item) => item.no === agendaItem.no);
  const precedingItems = index >= 0 ? items.slice(0, index) : [];
  return precedingItems.reduce((sum, item) => sum + (Number.isFinite(item.durationMinutes) ? item.durationMinutes : 0), 0) * 60;
}

// Finds the gap between consecutive segments closest to targetSec (ties broken by the wider gap)
// within searchRadiusSec, and returns its midpoint as the snapped boundary - falls back to
// targetSec itself if no segment gap falls in range at all. Picking the widest gap in range
// (rather than the nearest one) was the actual bug here despite the function's name: a long silence
// well outside where the boundary should be could still win over a short-but-close pause, dragging
// the snapped boundary away from targetSec - for agenda item 1 (estimatedStart always exactly 0)
// this could pull windowStart minutes into the recording, cutting off the presentation's opening.
function snapToNearestPause(sortedSegments, targetSec, searchRadiusSec) {
  let best = null;

  for (let index = 0; index < sortedSegments.length - 1; index += 1) {
    const gapStart = sortedSegments[index].endSec;
    const gapEnd = sortedSegments[index + 1].startSec;
    const gapMid = (gapStart + gapEnd) / 2;
    const distance = Math.abs(gapMid - targetSec);
    if (distance > searchRadiusSec) {
      continue;
    }

    const gapSec = gapEnd - gapStart;
    if (!best || distance < best.distance || (distance === best.distance && gapSec > best.gapSec)) {
      best = { boundarySec: gapMid, distance, gapSec };
    }
  }

  return best ? best.boundarySec : targetSec;
}

function windowTranscriptForAgendaItem(transcriptSegments, agenda, agendaItem) {
  if (!Array.isArray(transcriptSegments) || transcriptSegments.length === 0) {
    return [];
  }

  const sorted = transcriptSegments.slice().sort((a, b) => a.startSec - b.startSec);
  const estimatedStart = estimateAgendaStartSec(agenda, agendaItem);
  const plannedDurationSec =
    Number.isFinite(agendaItem.durationMinutes) && agendaItem.durationMinutes > 0
      ? agendaItem.durationMinutes * 60
      : WINDOW_FALLBACK_DURATION_SEC;
  const estimatedEnd = estimatedStart + plannedDurationSec;

  // Agenda item 1 always estimates to exactly 0 (no preceding items), and any other item can land
  // this close too - snapping it to a real pause nearby is pointless (there's nothing before 0 to
  // protect against including) and only risks the nearest-pause search still picking something a
  // little off zero, so skip snapping entirely and start the window at the true beginning.
  const snappedStart = estimatedStart <= WINDOW_EDGE_PADDING_SEC ? 0 : snapToNearestPause(sorted, estimatedStart, WINDOW_SEARCH_RADIUS_SEC);
  const windowStart = Math.max(0, snappedStart - WINDOW_EDGE_PADDING_SEC);
  const windowEnd = snapToNearestPause(sorted, estimatedEnd, WINDOW_SEARCH_RADIUS_SEC) + WINDOW_EDGE_PADDING_SEC;

  return sorted.filter((segment) => segment.endSec > windowStart && segment.startSec < windowEnd);
}

// Keeps whole lines up to maxChars (always keeps at least one line) instead of a raw string slice,
// so the cap never cuts a transcript line in half.
function capTranscriptLines(lines, maxChars) {
  const kept = [];
  let total = 0;
  for (const line of lines) {
    const nextTotal = total + line.length + 1;
    if (kept.length > 0 && nextTotal > maxChars) {
      break;
    }
    kept.push(line);
    total = nextTotal;
  }
  return kept;
}

// Builds the user-message prompt for /api/llm/presentation-summary (B5). Unlike buildMinutesPrompt
// above (which groups the transcript by speaker for a whole-meeting summary), this keeps the
// transcript in chronological order and windows it down to the agenda item's estimated stretch
// (see windowTranscriptForAgendaItem) instead of sending the whole meeting's transcript for every
// single agenda item - chronological order also preserves the question/answer adjacency B5's
// (질문)/(답변) tagging depends on.
// `badgeLabels` is a plain {name: label} map (e.g. {"김도현": "주관자", "박준혁": "발표1"}) built by
// the caller from B1's computeAttendeeBadges (a TS function in src/types/domain.ts that this plain
// .mjs file can't import directly), so the LLM tags its output with the same labels used elsewhere.
export function buildPresentationSummaryPrompt(meeting, agendaItem, materialMarkdown, badgeLabels) {
  const source = meeting && typeof meeting === "object" ? meeting : {};
  const sections = [];

  sections.push(
    [
      "[발표 정보]",
      `제목: ${agendaItem.title || "-"}`,
      `발표자: ${agendaItem.presenter || "-"}`,
      `발표시간: ${Number.isFinite(agendaItem.durationMinutes) ? agendaItem.durationMinutes : 0}분`
    ].join("\n")
  );

  const badgeEntries = badgeLabels && typeof badgeLabels === "object" ? Object.entries(badgeLabels) : [];
  const badgeLines = badgeEntries.length ? badgeEntries.map(([name, label]) => `- ${label}: ${name}`) : ["(참석자 라벨 정보 없음)"];
  sections.push(["[참석자 라벨]", ...badgeLines].join("\n"));

  if (materialMarkdown && materialMarkdown.trim()) {
    sections.push(["[발표 자료]", materialMarkdown.trim()].join("\n"));
  }

  const audio = source.audio && typeof source.audio === "object" ? source.audio : null;
  if (audio && Array.isArray(audio.transcriptSegments) && audio.transcriptSegments.length) {
    const speakerMap = audio.speakerMap && typeof audio.speakerMap === "object" ? audio.speakerMap : {};
    const windowedSegments = windowTranscriptForAgendaItem(audio.transcriptSegments, source.agenda, agendaItem);
    const isWindowed = windowedSegments.length > 0 && windowedSegments.length < audio.transcriptSegments.length;
    const segmentsToUse = windowedSegments.length ? windowedSegments : audio.transcriptSegments;

    const transcriptLines = capTranscriptLines(
      segmentsToUse.map((segment) => {
        const speakerName = resolveSpeakerName(segment.speaker, speakerMap);
        return `[${formatMmSs(segment.startSec)}-${formatMmSs(segment.endSec)}] ${speakerName}: ${segment.text || ""}`;
      }),
      WINDOW_MAX_CHARS
    );

    const sectionLabel = isWindowed
      ? "[발표 구간으로 추정되는 발언 대본 - Agenda 순서·발표 시간으로 추정한 구간이라 실제와 시간 오차가 있을 수 있음]"
      : "[회의 전체 발언 대본 - 이 발표와 무관한 구간이 섞여 있을 수 있음]";

    sections.push([sectionLabel, ...transcriptLines].join("\n"));
  }

  return sections.join("\n\n");
}
