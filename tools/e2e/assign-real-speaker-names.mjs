// Fixes up the 11 E2E test meetings so their saved speakerMap uses real names instead of
// "미등록 화자 N" placeholders. These meetings were created by POSTing straight to the API
// (bypassing AudioAnalysisModal's speaker-rename step, which is the UI's only chance to fix an
// unmatched label before saving), so the raw diarization result was persisted as-is. The real
// identity of every turn is fully known here though - meeting #1 has a persisted ground-truth
// script with real timestamps, and the 10 batch meetings' turn scripts are deterministic
// (buildMeetingSpec/buildTurns are pure functions of the batch index) - so both can be resolved
// without guessing.
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import PDFDocument from "pdfkit"; // unused here but keeps this file import-parallel with generate-batch.mjs for easy diffing
void PDFDocument;

const BASE_URL = "http://127.0.0.1:5185";
const projectRoot = process.cwd();

async function api(pathname, init) {
  const response = await fetch(`${BASE_URL}${pathname}`, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${pathname} 실패: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

// ---------- Duplicated from generate-batch.mjs (pure, deterministic) - do NOT import that file
// directly, it runs its whole batch as a side effect of module load. ----------
const ROSTER = [
  { name: "윤서진", voice: "ko-KR-SunHiNeural", rate: "+0%", pitch: "+0Hz" },
  { name: "한지민", voice: "ko-KR-SunHiNeural", rate: "-10%", pitch: "-30Hz" },
  { name: "조은우", voice: "ko-KR-SunHiNeural", rate: "+15%", pitch: "+35Hz" },
  { name: "서예린", voice: "ko-KR-InJoonNeural", rate: "+0%", pitch: "+0Hz" },
  { name: "문승현", voice: "ko-KR-InJoonNeural", rate: "-10%", pitch: "-30Hz" },
  { name: "남궁민", voice: "ko-KR-InJoonNeural", rate: "+15%", pitch: "+35Hz" },
  { name: "배수지", voice: "ko-KR-HyunsuMultilingualNeural", rate: "+0%", pitch: "+0Hz" },
  { name: "홍지호", voice: "ko-KR-HyunsuMultilingualNeural", rate: "-10%", pitch: "-30Hz" },
  { name: "임하늘", voice: "ko-KR-HyunsuMultilingualNeural", rate: "+15%", pitch: "+35Hz" },
  { name: "노준영", voice: "ko-KR-SunHiNeural", rate: "+25%", pitch: "-15Hz" }
];

const TOPICS = [
  { title: "모바일 앱 성능 개선", format: "pptx", bullets: ["앱 시작 시간 3.2초 → 1.8초로 단축", "크래시율 0.8% → 0.2%로 감소", "메모리 사용량 15% 절감", "다음 분기 목표: 시작 시간 1.2초"] },
  { title: "신규 채용 현황", format: "pdf", bullets: ["채용 공고 12건, 지원자 340명 접수", "최종 합격 8명, 평균 채용 소요 26일", "백엔드/프론트 직군 경쟁률이 가장 높음", "다음 분기 채용 목표 6명"] },
  { title: "보안 점검 결과", format: "xlsx", bullets: ["취약점 총 42건 발견", "심각 3건 즉시 패치 완료", "중간 15건은 2주 내 조치 예정", "외부 침투테스트 통과"] },
  { title: "마케팅 캠페인 성과", format: "pptx", bullets: ["노출 120만회, 클릭률 3.4%", "전환 850건, ROAS 4.2배", "20대 타겟층 반응이 가장 높음", "다음 캠페인은 리타겟팅 강화"] },
  { title: "데이터 파이프라인 안정화", format: "pdf", bullets: ["배치 실패율 12% → 2%로 감소", "평균 지연시간 45분 → 12분", "실패 시 자동 알림 체계 신설", "다음 목표: 실패율 1% 이하"] },
  { title: "사내 헬프데스크 통계", format: "xlsx", bullets: ["이번 분기 문의 620건 접수", "평균 처리 시간 3.1시간", "만족도 82점(100점 만점)", "반복 문의 유형 상위 3개 파악"] },
  { title: "물류센터 자동화 파일럿", format: "pptx", bullets: ["피킹 속도 40% 향상", "오배송률 1.2% → 0.3%로 감소", "투자비 회수 14개월 예상", "2호 물류센터 확대 검토 중"] },
  { title: "구독형 요금제 개편안", format: "pdf", bullets: ["현재 이탈율 6.8%, 목표 4%", "신규 요금제 3종 설계", "예상 매출 증가 약 8%", "베타 테스트 10월 진행 예정"] }
];

function buildMeetingSpec(index) {
  const presenterCounts = [1, 2, 3, 4, 5, 2, 3, 1, 4, 2];
  const attendeeCounts = [1, 1, 2, 2, 2, 1, 2, 1, 2, 1];
  const presenterCount = presenterCounts[index];
  const attendeeCount = attendeeCounts[index];
  const rosterOffset = index * 3;
  const pick = (n) => ROSTER[(rosterOffset + n) % ROSTER.length];
  const organizer = pick(0);
  const presenters = Array.from({ length: presenterCount }, (_, i) => pick(1 + i));
  const attendees = Array.from({ length: attendeeCount }, (_, i) => pick(1 + presenterCount + i));
  const topicOffset = index * 2;
  const agenda = presenters.map((presenter, i) => ({ no: i + 1, topic: TOPICS[(topicOffset + i) % TOPICS.length], presenter }));
  return { index, organizer, presenters, attendees, agenda };
}

function buildTurns(spec) {
  const turns = [];
  const say = (person, text) => turns.push({ person, text });
  say(spec.organizer, `안녕하세요`);
  spec.agenda.forEach((item, i) => {
    const b = item.topic.bullets;
    say(item.presenter, `안녕하세요, ${item.presenter.name}입니다. ${item.topic.title} 관련해서 말씀드리면, ${b[0]}. ${b[1]}.`);
    const asker = spec.attendees[i % Math.max(1, spec.attendees.length)] ?? spec.organizer;
    say(asker, `${b[2] ?? "관련해서"} 부분은 좀 더 자세히 설명해 주실 수 있나요?`);
    say(item.presenter, `네, ${b[2] ?? "관련 내용은 다음 보고에서"} 부분이고, ${b[3] ?? "추가로 확인해서 공유드리겠습니다"}.`);
    if (i < spec.agenda.length - 1) say(spec.organizer, `감사합니다. 다음은 ${spec.agenda[i + 1].presenter.name} 님, ${spec.agenda[i + 1].topic.title} 발표 부탁드립니다.`);
  });
  say(spec.organizer, "모두 수고하셨습니다. 오늘 논의된 내용은 회의록으로 정리해서 공유드리겠습니다. 이상으로 회의를 마치겠습니다.");
  return turns;
}

// ---------- Fuzzy cluster-to-person matching (batch meetings) ----------
function normalize(text) {
  return text.replace(/[^\p{L}\p{N}]/gu, "");
}

function shingles(text, n = 4) {
  const normalized = normalize(text);
  const set = new Set();
  for (let i = 0; i + n <= normalized.length; i += 1) set.add(normalized.slice(i, i + n));
  return set;
}

function overlapScore(a, b) {
  let common = 0;
  for (const gram of a) if (b.has(gram)) common += 1;
  return common;
}

function resolveBatchSpeakerMap(meeting) {
  const match = /배치테스트\s*(\d+)회차/.exec(meeting.title);
  if (!match) return null;

  const index = Number(match[1]) - 1;
  const spec = buildMeetingSpec(index);
  const turns = buildTurns(spec);

  const people = [spec.organizer, ...spec.presenters, ...spec.attendees];
  const textByPerson = new Map(people.map((person) => [person.name, []]));
  for (const turn of turns) textByPerson.get(turn.person.name).push(turn.text);
  const shinglesByPerson = new Map(Array.from(textByPerson, ([name, texts]) => [name, shingles(texts.join(" "))]));

  const segmentsByLabel = new Map();
  for (const segment of meeting.audio.transcriptSegments) {
    if (!segmentsByLabel.has(segment.speaker)) segmentsByLabel.set(segment.speaker, []);
    segmentsByLabel.get(segment.speaker).push(segment);
  }

  const nextSpeakerMap = {};
  for (const [label, segments] of segmentsByLabel) {
    const clusterShingles = shingles(segments.map((segment) => segment.text).join(" "));
    let bestPerson = null;
    let bestScore = -1;
    for (const person of people) {
      const score = overlapScore(clusterShingles, shinglesByPerson.get(person.name));
      if (score > bestScore) {
        bestScore = score;
        bestPerson = person;
      }
    }
    nextSpeakerMap[label] = bestPerson.name;
  }

  return nextSpeakerMap;
}

// ---------- Time-overlap matching (meeting #1, which has a real ground-truth script) ----------
const MEETING1_ROLE_TO_NAME = {
  organizer: "김도현",
  presenter1: "박서연",
  presenter2: "이준호",
  presenter3: "최유나",
  attendee1: "정하은",
  attendee2: "강민재"
};

async function resolveMeeting1SpeakerMap(meeting) {
  const groundTruthPath = path.join(projectRoot, "data", "test-audio", "meeting-3presenter-2attendee-ko.ground-truth.json");
  const groundTruth = JSON.parse(await readFile(groundTruthPath, "utf8"));

  const segmentsByLabel = new Map();
  for (const segment of meeting.audio.transcriptSegments) {
    if (!segmentsByLabel.has(segment.speaker)) segmentsByLabel.set(segment.speaker, []);
    segmentsByLabel.get(segment.speaker).push(segment);
  }

  const nextSpeakerMap = {};
  for (const [label, segments] of segmentsByLabel) {
    const overlapByRole = new Map();
    for (const segment of segments) {
      for (const gtSegment of groundTruth.segments) {
        const overlap = Math.min(segment.endSec, gtSegment.endSec) - Math.max(segment.startSec, gtSegment.startSec);
        if (overlap > 0) {
          overlapByRole.set(gtSegment.speakerRole, (overlapByRole.get(gtSegment.speakerRole) ?? 0) + overlap);
        }
      }
    }
    const bestRole = Array.from(overlapByRole.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
    nextSpeakerMap[label] = MEETING1_ROLE_TO_NAME[bestRole] ?? label;
  }

  return nextSpeakerMap;
}

async function main() {
  const { meetings } = await api("/api/meetings");
  const targets = meetings.filter((meeting) => meeting.audio?.transcriptSegments?.length);

  for (const meeting of targets) {
    let nextSpeakerMap;
    if (meeting.title === "3분기 실행 현황 점검 회의") {
      nextSpeakerMap = await resolveMeeting1SpeakerMap(meeting);
    } else {
      nextSpeakerMap = resolveBatchSpeakerMap(meeting);
    }

    if (!nextSpeakerMap) {
      console.log(`- ${meeting.title}: 매칭 규칙 없음, 건너뜀`);
      continue;
    }

    console.log(`- ${meeting.title}`);
    console.log(`    이전: ${JSON.stringify(meeting.audio.speakerMap)}`);
    console.log(`    이후: ${JSON.stringify(nextSpeakerMap)}`);

    await api(`/api/meetings/${meeting.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio: { ...meeting.audio, speakerMap: nextSpeakerMap } })
    });
  }

  console.log("\n완료.");
}

await main();
