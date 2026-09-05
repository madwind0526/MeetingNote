import type { DictionaryEntry } from "../types/domain";
import { authHeaders, jsonAuthHeaders, notifySessionExpired } from "./auth";

export interface DictionaryState {
  abbreviations: DictionaryEntry[];
  corrections: DictionaryEntry[];
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;

  if (!response.ok) {
    // See auth.ts's notifySessionExpired - a 401 here means the server-side session is gone even
    // though a stale token is still cached, so kick the app back to the login screen instead of
    // leaving every subsequent action failing the same way.
    if (response.status === 401) {
      notifySessionExpired();
    }
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
    headers: jsonAuthHeaders(),
    body: JSON.stringify(dictionary)
  });

  return parseJsonResponse<DictionaryState>(response);
}

export async function applyDictionaryToAllMeetings(): Promise<number> {
  const response = await fetch("/api/dictionary/apply", { method: "POST", headers: authHeaders() });
  const payload = await parseJsonResponse<{ updatedCount: number }>(response);

  return payload.updatedCount;
}
