import spawn from "cross-spawn";
import { readEnvFile } from "./envFile.mjs";

const CLAUDE_CLI_TIMEOUT_MS = 60000;
const ANTHROPIC_MODEL = "claude-3-5-haiku-20241022";

// cross-spawn resolves the real claude.cmd/.ps1 shim on Windows and passes arguments through
// argv (not a shell string), so a question containing shell metacharacters (&, |, `, $()...)
// can't be interpreted as a second command - unlike `exec`/`execFile` with `shell: true`.
function runCommand(command, args, { timeoutMs, cwd, stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { timeout: timeoutMs, cwd });
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

export async function checkClaudeCliAvailable() {
  try {
    const version = await runCommand("claude", ["--version"], { timeoutMs: 10000 });
    return { available: true, version };
  } catch {
    return { available: false, version: null };
  }
}

export async function askClaudeCli(systemPrompt, userPrompt) {
  try {
    // Running `claude -p` inside this project's own folder would otherwise load this repo's
    // CLAUDE.md and answer in character as "the MeetingNote coding assistant" instead of the
    // prompt, even though the question has nothing to do with code. `--system-prompt` replaces
    // the CLI's default system prompt outright, which sidesteps that regardless of cwd - no
    // need to run from a neutral directory.
    //
    // The user prompt (question + meeting data) goes over stdin rather than as a CLI argument:
    // a multi-line, multi-KB argument routed through cmd.exe (required to launch the .cmd shim
    // on Windows) gets mangled/truncated, so the CLI would see an empty or corrupted prompt.
    return await runCommand("claude", ["-p", "--system-prompt", systemPrompt], {
      timeoutMs: CLAUDE_CLI_TIMEOUT_MS,
      stdin: userPrompt
    });
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

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }]
    })
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Anthropic API 호출에 실패했습니다 (${response.status}): ${errorText.slice(0, 200)}`);
  }

  const payload = await response.json();
  const text = (payload.content ?? []).map((block) => block.text ?? "").join("");

  return text.trim();
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

  let response;
  try {
    response = await fetch(new URL("/api/chat", baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
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
  return String(payload.message?.content ?? "").trim();
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
