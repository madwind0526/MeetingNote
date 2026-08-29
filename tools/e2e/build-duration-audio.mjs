// Builds a ~5-minute Korean meeting audio via edge-tts (same synthesis approach as
// generate-batch.mjs), then concatenates raw PCM copies of it to produce 10/30/60-minute versions
// - same content repeated, since the point is testing the pipeline at increasing LENGTH, not
// generating hours of fresh dialogue.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const ffmpegBin = "D:\\ffmpeg\\ffmpeg-7.1.1-full_build-shared\\bin\\ffmpeg.exe";
const pythonBin = path.join(projectRoot, ".venv-whisperx", "Scripts", "python.exe");
const outDir = path.join(projectRoot, "data", "test-audio", "duration-bench");

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2;
const GAP_SEC = 0.6;

const ROSTER = {
  organizer: { name: "김도현", voice: "ko-KR-InJoonNeural", rate: "+0%", pitch: "+0Hz" },
  presenter1: { name: "박서연", voice: "ko-KR-SunHiNeural", rate: "+0%", pitch: "+0Hz" },
  presenter2: { name: "이준호", voice: "ko-KR-SunHiNeural", rate: "-10%", pitch: "-30Hz" },
  presenter3: { name: "최유나", voice: "ko-KR-SunHiNeural", rate: "+15%", pitch: "+35Hz" },
  attendee1: { name: "정하은", voice: "ko-KR-HyunsuMultilingualNeural", rate: "+0%", pitch: "+0Hz" },
  attendee2: { name: "강민재", voice: "ko-KR-HyunsuMultilingualNeural", rate: "-10%", pitch: "-30Hz" }
};

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with ${code}: ${stderr.slice(-500)}`));
        return;
      }
      resolve();
    });
  });
}

async function synthesizeTurn(workDir, index, text, person) {
  const mp3Path = path.join(workDir, `turn-${index}.mp3`);
  const wavPath = path.join(workDir, `turn-${index}.wav`);
  await run(pythonBin, ["-m", "edge_tts", "-t", text, "-v", person.voice, `--rate=${person.rate}`, `--pitch=${person.pitch}`, "--write-media", mp3Path]);
  await run(ffmpegBin, ["-y", "-i", mp3Path, "-ac", "1", "-ar", String(SAMPLE_RATE), "-sample_fmt", "s16", wavPath]);
  return wavPath;
}

async function readPcmData(wavPath) {
  const buffer = await readFile(wavPath);
  const dataChunkStart = buffer.indexOf(Buffer.from("data"));
  const dataSize = buffer.readUInt32LE(dataChunkStart + 4);
  return buffer.subarray(dataChunkStart + 8, dataChunkStart + 8 + dataSize);
}

function wavHeader(pcmLength) {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * BYTES_PER_SAMPLE;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmLength, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmLength, 40);
  return header;
}

// ---------- ~5-minute meeting script: organizer intro + 3 presenters (opening + 2-round Q&A each) + close ----------
function buildTurns() {
  const t = [];
  const say = (personKey, text) => t.push({ person: ROSTER[personKey], text });

  say(
    "organizer",
    "안녕하세요, 오늘 3분기 실행 현황 점검 회의를 시작하겠습니다. 오늘은 AI 코드리뷰 파일럿, 고객 지원 프로세스 개선, 인프라 비용 집행 세 가지 안건을 순서대로 다루겠습니다. 각 발표 후에는 질의응답 시간을 갖겠습니다. 먼저 박서연 님, AI 코드리뷰 파일럿 발표 부탁드립니다."
  );

  say(
    "presenter1",
    "안녕하세요, 백엔드팀 박서연입니다. 이번 분기에 AI 코드리뷰 어시스턴트 파일럿을 진행했습니다. 8월 한 달간 백엔드팀 열두 명을 대상으로 풀 리퀘스트 삼백사십 건에 적용했고, 리뷰 대기시간이 열여덟 시간에서 여섯 시간으로 줄었습니다. 스타일 관련 지적의 칠십이 퍼센트는 자동으로 처리됐고, 개발자들의 만족도 조사에서도 긍정적인 답변이 많았습니다. 다음 분기에는 프론트엔드팀까지 확대 적용할 계획입니다."
  );
  say("attendee1", "베타 테스트 기간 동안 오탐, 그러니까 잘못된 지적 비율은 어느 정도였나요?");
  say(
    "presenter1",
    "좋은 질문입니다. 초기에는 오탐률이 십오 퍼센트 정도로 높았는데, 프롬프트와 규칙을 계속 튜닝하면서 최종적으로는 사 퍼센트까지 낮췄습니다. 나머지 오탐은 대부분 도메인 특화 로직에 대한 오해에서 나왔고, 이 부분은 팀별 컨텍스트를 추가로 제공하는 방식으로 개선할 계획입니다."
  );
  say("organizer", "추가 질문 없으시면 다음으로 넘어가겠습니다. 이준호 님, 고객 지원 프로세스 개선 발표 부탁드립니다.");

  say(
    "presenter2",
    "안녕하세요, 고객지원팀 이준호입니다. 이번 분기에는 고객 문의 대응 프로세스를 개선했습니다. 챗봇 일차 응대 비중을 늘리고, 상담사 배정 로직을 개편해서 평균 응답 시간이 사십 퍼센트 단축됐습니다. 고객 만족도 조사에서도 전분기 대비 점수가 올랐고, 특히 야간 시간대 응대 품질이 크게 개선됐다는 피드백이 많았습니다."
  );
  say("attendee2", "챗봇이 처리하지 못하고 사람에게 넘기는 비율은 어느 정도인가요?");
  say(
    "presenter2",
    "현재는 약 삼십오 퍼센트 정도가 상담사에게 이관되고 있습니다. 단순 문의는 챗봇이 대부분 처리하고, 결제나 환불처럼 민감한 건은 바로 상담사에게 넘기도록 설계했습니다. 다음 분기에는 이관 비율을 삼십 퍼센트 아래로 낮추는 것을 목표로 하고 있습니다."
  );
  say("organizer", "감사합니다. 마지막으로 최유나 님, 인프라 비용 집행 발표 부탁드립니다.");

  say(
    "presenter3",
    "안녕하세요, 인프라팀 최유나입니다. 이번 분기 클라우드 비용을 전분기 대비 최적화했습니다. 예약 인스턴스로 전환하고 사용하지 않는 리소스를 정리해서 월 비용을 약 이십 퍼센트 절감했습니다. 다음 분기 예산안도 함께 준비했는데, 트래픽 증가를 고려해서 전체 예산은 유지하되 내부 배분을 조정할 계획입니다."
  );
  say("attendee1", "예약 인스턴스 전환 과정에서 서비스 중단은 없었나요?");
  say(
    "presenter3",
    "네, 무중단으로 전환을 완료했습니다. 트래픽이 적은 새벽 시간대에 단계적으로 전환했고, 롤백 계획도 미리 준비해뒀습니다. 실제로 문제가 발생한 구간은 없었고, 모니터링 대시보드로 전 과정을 실시간으로 확인했습니다."
  );

  say(
    "organizer",
    "세 분 모두 좋은 발표 감사합니다. 오늘 논의된 내용을 정리하면, AI 코드리뷰는 프론트엔드팀으로 확대하고, 고객 지원은 챗봇 이관 비율을 낮추는 것을 목표로 하며, 인프라 비용은 다음 분기 예산 배분을 조정하기로 했습니다. 오늘 회의는 여기서 마치겠습니다. 모두 수고하셨습니다."
  );

  return t;
}

async function synthesizeBase(outWavPath) {
  const workDir = await mkdtemp(path.join(tmpdir(), "meetingnote-duration-"));
  try {
    const turns = buildTurns();
    const silenceBuffer = Buffer.alloc(Math.round(SAMPLE_RATE * GAP_SEC) * BYTES_PER_SAMPLE);
    const pcmChunks = [];

    for (let index = 0; index < turns.length; index += 1) {
      console.log(`  합성 중 ${index + 1}/${turns.length}...`);
      const wavPath = await synthesizeTurn(workDir, index, turns[index].text, turns[index].person);
      const pcm = await readPcmData(wavPath);
      if (index > 0) {
        pcmChunks.push(silenceBuffer);
      }
      pcmChunks.push(pcm);
    }

    const merged = Buffer.concat(pcmChunks);
    await mkdir(path.dirname(outWavPath), { recursive: true });
    await writeFile(outWavPath, Buffer.concat([wavHeader(merged.length), merged]));
    return merged.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function concatCopies(basePcm, copies, outWavPath) {
  const merged = Buffer.concat(new Array(copies).fill(basePcm));
  await writeFile(outWavPath, Buffer.concat([wavHeader(merged.length), merged]));
  return merged.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);
}

async function main() {
  const basePath = path.join(outDir, "base-5min.wav");
  console.log("5분 기준 오디오 합성 시작...");
  const baseDurationSec = await synthesizeBase(basePath);
  console.log(`기준 오디오 완료: ${(baseDurationSec / 60).toFixed(2)}분 (${baseDurationSec.toFixed(1)}초) -> ${basePath}`);

  const basePcm = await readPcmData(basePath);

  const targets = [
    { minutes: 5, copies: 1, fileName: "duration-5min.wav" },
    { minutes: 10, copies: 2, fileName: "duration-10min.wav" },
    { minutes: 30, copies: 6, fileName: "duration-30min.wav" },
    { minutes: 60, copies: 12, fileName: "duration-60min.wav" }
  ];

  const summary = [];
  for (const target of targets) {
    const outPath = path.join(outDir, target.fileName);
    const durationSec = await concatCopies(basePcm, target.copies, outPath);
    console.log(`${target.minutes}분용 (${target.copies}회 반복): ${(durationSec / 60).toFixed(2)}분 -> ${outPath}`);
    summary.push({ minutes: target.minutes, copies: target.copies, fileName: target.fileName, actualDurationSec: Number(durationSec.toFixed(1)) });
  }

  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify({ baseDurationSec, targets: summary }, null, 2), "utf8");
  console.log("\n완료. manifest.json 저장.");
}

await main();
