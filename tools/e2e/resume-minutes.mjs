// Resumes the E2E flow from stage 3's step [5/6] onward - the meeting record already has
// audio/transcriptSegments/speakerMap saved (stage 3's STT step succeeded before the LLM step hit
// the old 60s claude-cli timeout), so this just re-runs the B5 (발표별 정리) + B6 (회의록 작성)
// LLM calls against the already-updated meeting.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const BASE_URL = "http://127.0.0.1:5185";
const projectRoot = process.cwd();
const contextPath = path.join(projectRoot, "data", "test-audio", "e2e-meeting-context.json");
const resultPath = path.join(projectRoot, "data", "test-audio", "e2e-result.json");

async function api(pathname, init) {
  const response = await fetch(`${BASE_URL}${pathname}`, init);
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${pathname} 실패: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function main() {
  const context = JSON.parse(await readFile(contextPath, "utf8"));

  console.log("[5/6] 발표별 정리 (B5, claude-cli) - agenda 3건...");
  let meeting = (await api(`/api/meetings`)).meetings.find((candidate) => candidate.id === context.meetingId);
  if (!meeting.audio || !meeting.audio.transcriptSegments?.length) {
    throw new Error("meeting.audio가 비어 있습니다 - stage 3의 STT 단계부터 다시 실행해야 합니다.");
  }

  const summaries = [];
  for (const agendaItem of meeting.agenda) {
    const startedAt = Date.now();
    const { summary } = await api("/api/llm/presentation-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "claude-cli", meeting, agendaNo: agendaItem.no })
    });
    console.log(`  Agenda ${agendaItem.no} (${agendaItem.title}) [${((Date.now() - startedAt) / 1000).toFixed(1)}s]: ${summary.slice(0, 60).replace(/\n/g, " ")}...`);
    summaries.push({ no: agendaItem.no, title: agendaItem.title, summary });
  }

  const updatedAgenda = meeting.agenda.map((item) => ({
    ...item,
    presentationSummary: summaries.find((entry) => entry.no === item.no)?.summary ?? item.presentationSummary
  }));

  await api(`/api/meetings/${context.meetingId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agenda: updatedAgenda })
  });

  console.log("[6/6] 전체 회의록 작성 (B6, claude-cli)...");
  meeting = (await api(`/api/meetings`)).meetings.find((candidate) => candidate.id === context.meetingId);
  const minutesStartedAt = Date.now();
  const { minutes } = await api("/api/llm/minutes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "claude-cli", meeting })
  });
  console.log(`  [${((Date.now() - minutesStartedAt) / 1000).toFixed(1)}s] 완료`);

  await api(`/api/meetings/${context.meetingId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ minutes })
  });

  const finalMeeting = (await api(`/api/meetings`)).meetings.find((candidate) => candidate.id === context.meetingId);

  const previousResult = await readFile(resultPath, "utf8").then(JSON.parse).catch(() => ({}));
  await writeFile(
    resultPath,
    `${JSON.stringify(
      { ...previousResult, meetingId: context.meetingId, presentationSummaries: summaries, minutes, finalMeeting },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(`완료. 결과 저장: ${path.relative(projectRoot, resultPath)}`);
  console.log("\n=== 회의록 미리보기 ===\n");
  console.log(minutes);
}

await main();
