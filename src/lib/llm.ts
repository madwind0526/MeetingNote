import type { LlmProviderId, Meeting } from "../types/domain";

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;

  if (!response.ok) {
    throw new Error(payload?.error || `요청이 실패했습니다 (${response.status}).`);
  }

  return payload as T;
}

export interface LlmStatus {
  claudeCli: { available: boolean; version: string | null };
  anthropicApiKeySet: boolean;
  ollama: { available: boolean; models: string[] };
}

export async function fetchLlmStatus(ollamaBaseUrl?: string): Promise<LlmStatus> {
  const query = ollamaBaseUrl ? `?ollamaBaseUrl=${encodeURIComponent(ollamaBaseUrl)}` : "";
  const response = await fetch(`/api/llm/status${query}`);

  return parseJsonResponse<LlmStatus>(response);
}

export interface OllamaConfig {
  ollamaBaseUrl: string;
  ollamaModel: string;
}

export async function askLlm(provider: LlmProviderId, question: string, meetings: Meeting[], ollamaConfig?: OllamaConfig): Promise<string> {
  const response = await fetch("/api/llm/query", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, question, meetings, ...ollamaConfig })
  });
  const payload = await parseJsonResponse<{ answer: string }>(response);

  return payload.answer;
}

export async function generateMinutes(provider: LlmProviderId, meeting: Meeting, ollamaConfig?: OllamaConfig): Promise<string> {
  const response = await fetch("/api/llm/minutes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, meeting, ...ollamaConfig })
  });
  const payload = await parseJsonResponse<{ minutes: string }>(response);

  return payload.minutes;
}

export async function generatePresentationSummary(
  provider: LlmProviderId,
  meeting: Meeting,
  agendaNo: number,
  ollamaConfig?: OllamaConfig
): Promise<string> {
  const response = await fetch("/api/llm/presentation-summary", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, meeting, agendaNo, ...ollamaConfig })
  });
  const payload = await parseJsonResponse<{ summary: string }>(response);

  return payload.summary;
}

export async function saveApiKey(kind: "anthropic" | "openai" | "huggingface", apiKey: string): Promise<void> {
  const body =
    kind === "openai" ? { openaiApiKey: apiKey } : kind === "huggingface" ? { huggingFaceToken: apiKey } : { anthropicApiKey: apiKey };
  const response = await fetch("/api/env", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  await parseJsonResponse<{ ok: boolean }>(response);
}

export async function clearApiKey(kind: "anthropic" | "openai" | "huggingface"): Promise<void> {
  const response = await fetch("/api/env", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: kind })
  });

  await parseJsonResponse<{ ok: boolean }>(response);
}

export async function saveNaverClovaConfig(invokeUrl: string, secretKey: string): Promise<void> {
  const response = await fetch("/api/env", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ naverClovaInvokeUrl: invokeUrl, naverClovaSecretKey: secretKey })
  });

  await parseJsonResponse<{ ok: boolean }>(response);
}

export async function clearNaverClovaConfig(): Promise<void> {
  const response = await fetch("/api/env", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "naver-clova" })
  });

  await parseJsonResponse<{ ok: boolean }>(response);
}

export interface SttStatus {
  openaiApiKeySet: boolean;
  naverClovaConfigured: boolean;
  huggingFaceTokenSet: boolean;
  localWhisperCli: { available: boolean; version: string | null };
  localWhisperX: { available: boolean; version: string | null };
}

export async function fetchSttStatus(): Promise<SttStatus> {
  const response = await fetch("/api/stt/status");

  return parseJsonResponse<SttStatus>(response);
}
