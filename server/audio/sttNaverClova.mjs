import { readEnvFile } from "../envFile.mjs";

// NAVER Cloud Platform CLOVA Speech Recognition (CSR) - "local file recognition" endpoint.
// The invoke URL is per-account/per-domain (issued in the NCP console when the CSR app is
// created), so it's stored alongside the secret key rather than hardcoded.
const UPLOAD_PATH = "/recognizer/upload";

function normalizeInvokeUrl(invokeUrl) {
  return invokeUrl.replace(/\/+$/, "");
}

export async function transcribeNaverClova(audioBuffer, fileName, attendeeNames = []) {
  const env = await readEnvFile();
  const invokeUrl = env.NAVER_CLOVA_INVOKE_URL;
  const secretKey = env.NAVER_CLOVA_SECRET_KEY;

  if (!invokeUrl || !secretKey) {
    throw new Error("Naver Clova Invoke URL/Secret Key가 설정되지 않았습니다. 설정에서 먼저 등록해 주세요.");
  }

  const speakerCount = Array.isArray(attendeeNames) ? attendeeNames.filter(Boolean).length : 0;

  const params = {
    language: "ko-KR",
    completion: "sync",
    fullText: true,
    wordAlignment: false,
    // CLOVA's own acoustic speaker diarization - real speaker separation, not a text heuristic.
    // speakerCountMin/Max are optional hints; omitted entirely when the attendee list is empty
    // rather than guessing a range.
    diarization: {
      enable: true,
      ...(speakerCount > 0 ? { speakerCountMin: 1, speakerCountMax: speakerCount } : {})
    }
  };

  const formData = new FormData();
  // Node 18+'s global FormData/Blob build a proper multipart body; fetch sets the multipart
  // boundary in Content-Type automatically, so it must not be set manually here.
  formData.append("media", new Blob([audioBuffer]), fileName);
  formData.append("params", JSON.stringify(params));
  formData.append("type", "application/json");

  const response = await fetch(`${normalizeInvokeUrl(invokeUrl)}${UPLOAD_PATH}`, {
    method: "POST",
    headers: {
      "X-CLOVASPEECH-API-KEY": secretKey
    },
    body: formData
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Naver Clova Speech 호출에 실패했습니다 (${response.status}): ${errorText.slice(0, 200)}`);
  }

  const payload = await response.json();
  const rawSegments = Array.isArray(payload.segments) ? payload.segments : [];
  const segments = rawSegments.map((segment) => {
    const speakerLabel = segment.diarization?.label;

    return {
      startSec: Number(segment.start ?? 0) / 1000,
      endSec: Number(segment.end ?? 0) / 1000,
      text: (segment.text ?? "").trim(),
      // Raw label (e.g. "1", "2") - diarizeSegments (server/audio/diarize.mjs) formats the
      // display fallback name itself ("화자 1") when no attendee is mapped to this index.
      ...(speakerLabel ? { speaker: String(speakerLabel) } : {})
    };
  });
  const lastSegment = segments[segments.length - 1];
  const durationSec = lastSegment ? lastSegment.endSec : 0;

  return { durationSec, segments };
}
