import type { DictionaryEntry } from "../types/domain";

export interface DictionaryState {
  abbreviations: DictionaryEntry[];
  corrections: DictionaryEntry[];
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;

  if (!response.ok) {
    throw new Error(payload?.error || `요청이 실패했습니다 (${response.status}).`);
  }

  return payload as T;
}

export async function fetchDictionary(): Promise<DictionaryState> {
  const response = await fetch("/api/dictionary");
  return parseJsonResponse<DictionaryState>(response);
}

export async function saveDictionary(dictionary: DictionaryState): Promise<DictionaryState> {
  const response = await fetch("/api/dictionary", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(dictionary)
  });

  return parseJsonResponse<DictionaryState>(response);
}

export async function applyDictionaryToAllMeetings(): Promise<number> {
  const response = await fetch("/api/dictionary/apply", { method: "POST" });
  const payload = await parseJsonResponse<{ updatedCount: number }>(response);

  return payload.updatedCount;
}
