// Full-flow E2E test, stage 2: synthesizes a 6-speaker meeting recording (1 organizer + 3
// presenters + 2 attendees) via edge-tts, one turn at a time, converts each to 16kHz mono PCM WAV
// via ffmpeg, and concatenates them (with a fixed silence gap) into one final WAV - same approach
// documented in data/test-audio/README.md for meeting-8speakers-ko.wav, just with a new 6-speaker
// script whose content matches the agenda built in build-meeting-and-materials.mjs (interleaved
// presentation + Q&A per agenda item, as requested).
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const ffmpegBin = "D:\\ffmpeg\\ffmpeg-7.1.1-full_build-shared\\bin\\ffmpeg.exe";
const pythonBin = path.join(projectRoot, ".venv-whisperx", "Scripts", "python.exe");
const outWavPath = path.join(projectRoot, "data", "test-audio", "meeting-3presenter-2attendee-ko.wav");
const groundTruthPath = path.join(projectRoot, "data", "test-audio", "meeting-3presenter-2attendee-ko.ground-truth.json");

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // 16-bit PCM mono
const GAP_SEC = 0.6;

const SPEAKERS = {
  organizer: { name: "김도현(주관자)", voice: "ko-KR-SunHiNeural", rate: "+0%", pitch: "+0Hz" },
  presenter1: { name: "박서연(발표자1)", voice: "ko-KR-InJoonNeural", rate: "+0%", pitch: "+0Hz" },
  presenter2: { name: "이준호(발표자2)", voice: "ko-KR-HyunsuMultilingualNeural", rate: "+0%", pitch: "+0Hz" },
  presenter3: { name: "최유나(발표자3)", voice: "ko-KR-SunHiNeural", rate: "-8%", pitch: "-25Hz" },
  attendee1: { name: "정하은(참석자1)", voice: "ko-KR-InJoonNeural", rate: "+10%", pitch: "+30Hz" },
  attendee2: { name: "강민재(참석자2)", voice: "ko-KR-HyunsuMultilingualNeural", rate: "-8%", pitch: "-25Hz" }
};

const TURNS = [
  {
    role: "organizer",
    text: "안녕하세요, 오늘 3분기 실행 현황 점검 회의를 시작하겠습니다. AI 코드리뷰 파일럿, 고객 지원 프로세스 개선, 인프라 비용 집행 순서로 진행하겠습니다. 먼저 박서연 님 발표 부탁드립니다."
  },
  {
    role: "presenter1",
    text: "안녕하세요, 백엔드팀 박서연입니다. 이번 분기에 AI 코드리뷰 어시스턴트 파일럿을 진행했습니다. 8월 한 달간 백엔드팀 12명을 대상으로 PR 340건에 적용했고, 리뷰 대기시간이 18시간에서 6시간으로 줄었습니다. 스타일 지적의 72퍼센트는 자동으로 처리됐습니다."
  },
  { role: "attendee1", text: "혹시 오탐율은 어느 정도인가요?" },
  {
    role: "presenter1",
    text: "현재 오탐율은 9퍼센트 정도이고, 특히 보안 관련 오탐이 민감해서 9월부터는 룰을 좀 더 튜닝할 계획입니다."
  },
  { role: "organizer", text: "네 감사합니다. 다음은 이준호 님, 고객 지원 프로세스 개선안 발표해 주세요." },
  {
    role: "presenter2",
    text: "안녕하세요, CS팀 이준호입니다. 현재 평균 최초 응답시간이 4.2시간인데, 반복 문의가 전체 티켓의 41퍼센트를 차지하고 있습니다. 자동 응답 챗봇과 티켓 자동 라우팅을 도입해서 응답시간을 1.5시간까지 줄이는 게 목표입니다."
  },
  { role: "organizer", text: "챗봇은 언제쯤 배포되나요?" },
  { role: "presenter2", text: "10월 중에 1차 배포를 목표로 하고 있습니다." },
  {
    role: "attendee2",
    text: "반복 문의 비중이 생각보다 높네요. 챗봇 도입되면 저희 쪽 문의도 좀 줄어들 것 같아 기대됩니다."
  },
  { role: "presenter2", text: "네, 배포 이후에 효과를 다시 공유드리겠습니다." },
  { role: "organizer", text: "좋습니다. 마지막으로 최유나 님, 인프라 비용 현황 발표 부탁드립니다." },
  {
    role: "presenter3",
    text: "인프라팀 최유나입니다. 3분기 인프라 예산은 6900만원이고, 현재까지 6550만원을 집행해서 집행률은 95퍼센트입니다. 클라우드 서버는 94퍼센트, CDN 트래픽은 121퍼센트로 예산을 초과했습니다."
  },
  { role: "attendee2", text: "CDN 비용이 왜 초과됐나요?" },
  {
    role: "presenter3",
    text: "8월에 프로모션 트래픽이 급증해서 CDN 비용이 예산보다 많이 나갔습니다. 백업/DR 쪽은 리전 이전이 지연되면서 집행률이 68퍼센트로 낮게 나온 상황입니다."
  },
  {
    role: "organizer",
    text: "네 모두 수고하셨습니다. 오늘 논의된 내용은 회의록으로 정리해서 공유드리겠습니다. 이상으로 회의를 마치겠습니다."
  }
];

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
        reject(new Error(`${command} exited with ${code}: ${stderr.slice(-800)}`));
        return;
      }
      resolve();
    });
  });
}

async function synthesizeTurn(workDir, index, turn) {
  const speaker = SPEAKERS[turn.role];
  const mp3Path = path.join(workDir, `turn-${index}.mp3`);
  const wavPath = path.join(workDir, `turn-${index}.wav`);

  // `--rate -8%` (two argv entries) makes argparse treat "-8%" as another flag, not this flag's
  // value - the single-token `--rate=-8%` form sidesteps that for any negative rate/pitch offset.
  await run(pythonBin, [
    "-m",
    "edge_tts",
    "-t",
    turn.text,
    "-v",
    speaker.voice,
    `--rate=${speaker.rate}`,
    `--pitch=${speaker.pitch}`,
    "--write-media",
    mp3Path
  ]);

  await run(ffmpegBin, ["-y", "-i", mp3Path, "-ac", "1", "-ar", String(SAMPLE_RATE), "-sample_fmt", "s16", wavPath]);

  return wavPath;
}

// Minimal RIFF/WAVE PCM reader - good enough for ffmpeg's own straightforward 16-bit PCM output
// (single "fmt " + "data" chunk, no extra metadata chunks to skip).
async function readPcmData(wavPath) {
  const buffer = await readFile(wavPath);
  const dataChunkStart = buffer.indexOf(Buffer.from("data"));
  if (dataChunkStart === -1) {
    throw new Error(`data chunk를 찾지 못했습니다: ${wavPath}`);
  }
  const dataSize = buffer.readUInt32LE(dataChunkStart + 4);
  return buffer.subarray(dataChunkStart + 8, dataChunkStart + 8 + dataSize);
}

function writeWavFile(filePath, pcmData) {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * BYTES_PER_SAMPLE;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcmData.length, 40);

  return writeFile(filePath, Buffer.concat([header, pcmData]));
}

async function main() {
  const workDir = await mkdtemp(path.join(tmpdir(), "meetingnote-e2e-tts-"));
  console.log(`작업 폴더: ${workDir}`);

  try {
    const silenceSamples = Math.round(SAMPLE_RATE * GAP_SEC);
    const silenceBuffer = Buffer.alloc(silenceSamples * BYTES_PER_SAMPLE);

    const pcmChunks = [];
    const segments = [];
    let cursorSec = 0;

    for (let index = 0; index < TURNS.length; index += 1) {
      const turn = TURNS[index];
      console.log(`[${index + 1}/${TURNS.length}] ${SPEAKERS[turn.role].name}: ${turn.text.slice(0, 24)}...`);

      const wavPath = await synthesizeTurn(workDir, index, turn);
      const pcm = await readPcmData(wavPath);
      const durationSec = pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE);

      if (index > 0) {
        pcmChunks.push(silenceBuffer);
        cursorSec += GAP_SEC;
      }

      const startSec = cursorSec;
      const endSec = cursorSec + durationSec;
      pcmChunks.push(pcm);
      cursorSec = endSec;

      segments.push({
        speakerRole: turn.role,
        speakerName: SPEAKERS[turn.role].name,
        startSec: Math.round(startSec * 100) / 100,
        endSec: Math.round(endSec * 100) / 100,
        text: turn.text
      });
    }

    await mkdir(path.dirname(outWavPath), { recursive: true });
    await writeWavFile(outWavPath, Buffer.concat(pcmChunks));

    const groundTruth = {
      speakers: Object.fromEntries(Object.entries(SPEAKERS).map(([role, info]) => [role, info.name])),
      segments
    };
    await writeFile(groundTruthPath, `${JSON.stringify(groundTruth, null, 2)}\n`, "utf8");

    console.log(`완료: ${path.relative(projectRoot, outWavPath)} (총 ${cursorSec.toFixed(2)}초, ${TURNS.length}턴)`);
    console.log(`정답지: ${path.relative(projectRoot, groundTruthPath)}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

await main();
