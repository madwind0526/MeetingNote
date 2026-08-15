// Offline placeholder STT provider - generates a plausible fake Korean meeting transcript instead
// of running real speech recognition, so the audio pipeline / UI flow can be demoed without any
// API key or local install.

const SAMPLE_LINES = [
  "이번 안건에 대해 말씀드리겠습니다.",
  "네, 좋은 의견입니다. 다음 안건으로 넘어가겠습니다.",
  "일정상 다음 주까지 초안을 공유하는 것으로 하겠습니다.",
  "관련 자료는 회의 종료 후 메일로 다시 전달드리겠습니다.",
  "예산 관련해서는 재무팀과 한 번 더 확인이 필요할 것 같습니다.",
  "고객사 쪽 피드백은 아직 도착하지 않아서, 확인되는 대로 공유드리겠습니다.",
  "지난 회의에서 논의된 내용을 간단히 정리하고 시작하겠습니다.",
  "해당 부분은 담당자분이 좀 더 자세히 설명해 주시겠어요?",
  "일정이 촉박하니 우선순위를 다시 정리하는 게 좋을 것 같습니다.",
  "오늘 논의된 내용은 회의록으로 정리해서 공유드리겠습니다.",
  "혹시 추가로 의견 있으신 분 계신가요?",
  "그럼 다음 회의 때 진행 상황을 다시 점검하도록 하겠습니다."
];

function pickLine(index) {
  return SAMPLE_LINES[index % SAMPLE_LINES.length];
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

// Builds 6-10 segments spanning ~120-240 seconds, with occasional pauses between segments so the
// pause-based diarization heuristic in diarize.mjs has turn-taking boundaries to detect.
export async function transcribeMock(fileName) {
  void fileName;

  const segmentCount = Math.floor(randomBetween(6, 11));
  const segments = [];
  let cursorSec = randomBetween(0, 2);

  for (let index = 0; index < segmentCount; index += 1) {
    const durationSec = randomBetween(8, 25);
    const startSec = cursorSec;
    const endSec = startSec + durationSec;

    segments.push({
      startSec: Math.round(startSec * 10) / 10,
      endSec: Math.round(endSec * 10) / 10,
      text: pickLine(index)
    });

    // Most turns follow immediately; some have a short pause (turn-taking gap) or a longer pause.
    const gapRoll = Math.random();
    const gapSec = gapRoll < 0.4 ? randomBetween(1.5, 3.5) : gapRoll < 0.8 ? randomBetween(0.1, 0.8) : 0;

    cursorSec = endSec + gapSec;
  }

  const lastSegment = segments[segments.length - 1];
  const durationSec = lastSegment ? lastSegment.endSec : 0;

  return { durationSec, segments };
}
