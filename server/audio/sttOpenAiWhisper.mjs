import { readEnvFile } from "../envFile.mjs";

const WHISPER_API_URL = "https://api.openai.com/v1/audio/transcriptions";

export async function transcribeWhisper(audioBuffer, fileName, model = "whisper-1", signal) {
  const env = await readEnvFile();
  const apiKey = env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("OpenAI API 키가 설정되지 않았습니다. 설정에서 먼저 등록해 주세요.");
  }

  const formData = new FormData();
  // Node 18+'s global FormData/Blob build a proper multipart body; fetch sets the
  // multipart boundary in Content-Type automatically, so it must not be set manually here.
  formData.append("file", new Blob([audioBuffer]), fileName);
  formData.append("model", model || "whisper-1");
  formData.append("response_format", "verbose_json");

  const response = await fetch(WHISPER_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData,
    signal
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`OpenAI Whisper API 호출에 실패했습니다 (${response.status}): ${errorText.slice(0, 200)}`);
  }

  const payload = await response.json();
  const rawSegments = Array.isArray(payload.segments) ? payload.segments : [];
  const segments = rawSegments.map((segment) => ({
    startSec: segment.start,
    endSec: segment.end,
    text: (segment.text ?? "").trim()
  }));
  const lastSegment = segments[segments.length - 1];
  const durationSec = typeof payload.duration === "number" ? payload.duration : lastSegment ? lastSegment.endSec : 0;

  return { durationSec, segments };
}
