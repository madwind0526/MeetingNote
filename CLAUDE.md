# MeetingNote

> **Working directory: `C:\Claude\MeetingNote`**

## Project Overview

회의록 작성 데스크톱 앱. 회의 기본정보(제목/일시/주관자), 참석자(주요 참석자·발표자), A/I List, Agenda를 표로
등록하고, 회의 후 녹음된 음성 파일을 업로드하면 화자별로 구분된 시간·텍스트 대본을 만든 뒤 LLM으로 구조화된
회의록을 자동 생성한다. Card 보기(요약 카드)와 List 보기(표)를 지원하며, 회의 날짜/회의록 작성 여부에 따라
예정/회의록 작성 필요/완료 상태가 자동으로 표시된다. PDF/Word/PowerPoint/JSON 가져오기·내보내기를 지원한다.

전반적인 프로젝트 구성(Electron + Vite + React + TypeScript, Vite dev 서버를 API 백엔드로 겸용하는 패턴, UI
디자인 시스템, LLM provider 선택형 설정 패턴)은 `C:\Claude\PhoneBook`을 1차 기준으로 삼아 만들었다
(`C:\Claude\SNS-Reader`는 PhoneBook 자체가 참고한 더 이전 프로젝트로, 구조 검증용으로만 참고했다).

## Tech Stack

- Electron 43 (데스크톱 셸)
- Vite 6 + React 18 + TypeScript (strict)
- Vite dev 서버 미들웨어를 API 백엔드로 사용 (별도 Express 서버 없음)
- pdfkit + fontkit (PDF 내보내기, 한글은 Windows `Malgun Gothic` 폰트 등록 필요), pdf-parse (PDF 가져오기),
  docx (Word 내보내기), mammoth (Word 가져오기), pptxgenjs (PowerPoint 내보내기), jszip (PowerPoint 가져오기)
- 로컬 JSON 파일을 DB로 사용 (`data/db/meetings.json`)
- STT(음성 인식) 3종 프로바이더: Mock(무료, 기본값) / 로컬 Whisper CLI(무료, `pip install -U openai-whisper` 필요) /
  OpenAI Whisper API(유료, `OPENAI_API_KEY` 필요) — LLM(질문·회의록 작성)과 동일한 "설정에서 선택" 패턴
- Web Audio API로 브라우저에서 오디오 디코드/파형/전처리(노이즈 게이트·정규화) 후 WAV로 재인코딩 (`src/lib/audio.ts`)

## Commands

```bash
npm install
npm run dev            # Vite dev 서버 (http://127.0.0.1:5185) — 브라우저에서도 바로 확인 가능
npm run build           # tsc -b && vite build && electron 빌드
npm start                # Electron 앱 실행 (dist 빌드 필요)
```

## Architecture

- `electron/` — Electron main/preload (창 생성, 설정 저장 IPC, 파일 저장/열기 다이얼로그)
- `vite.config.mts` — dev 서버 미들웨어로 구현된 API (`/api/meetings`, `/api/import`, `/api/export`,
  `/api/stt/*`, `/api/llm/*`, `/api/settings`, `/api/env`, `/api/logo`). 실제 로직은 `server/*.mjs`에 있고 이
  파일은 라우팅만 담당한다.
- `server/db.mjs` — JSON 파일 기반 회의록 DB (CRUD, bulk upsert, seed reset). 중복 판정은 title+date 조합.
- `server/audio/` — STT 3종(`sttMock.mjs`/`sttLocalWhisperCli.mjs`/`sttOpenAiWhisper.mjs`)과 화자 분리
  휴리스틱(`diarize.mjs` — pause 기준 턴 분리 + 참석자 라운드로빈 배정, 진짜 음향 화자 분리 아님)
- `server/parsers/`, `server/exporters/` — PDF/Word/PPT/JSON 가져오기·내보내기. PDF는 이 앱이 내보낸 라벨
  형식(`제목:`/`날짜:`/`Agenda`/`A/I List`/`회의록`)만 안정적으로 라운드트립된다.
- `server/llm.mjs` — Claude CLI/Anthropic API/Ollama 호출 + `buildQueryPrompt`/`buildMinutesPrompt`
- `src/App.tsx` — 화면 오케스트레이션 (상태, 모달, 데이터 로딩)
- `src/components/` — TopToolbar, LeftSidebar, SettingsView, views/(Card·List),
  modals/(MeetingFormModal·AudioAnalysisModal·Import·Export·검색·필터·질문·상세·API키·Ollama 설정)
- `src/lib/audio.ts` — 브라우저 Web Audio API 파형/전처리/WAV 인코더 (오디오 분석 팝업이 사용)

## Data model notes

- `Meeting.audio`는 분석 완료 전까지 `null`. 분석 후 `transcriptSegments`(화자/시간/텍스트)와
  `speakerMap`(라벨→실명, 사용자가 팝업에서 수동 재매핑 가능)을 갖는다.
- 상태(`computeMeetingStatus`)는 저장된 필드가 아니라 `date`/`endTime`/`minutes`로부터 항상 파생 계산된다.

## Known limitations

- 화자 분리는 진짜 음향 기반 인식이 아니라 발화 사이 pause 길이로 턴을 나누는 휴리스틱이다. 사용자가 팝업에서
  라벨을 실제 참석자로 수동 정정할 수 있다.
- PDF 가져오기는 이 앱이 직접 내보낸 PDF(라벨 형식)만 안정적으로 파싱된다. Word/PowerPoint 가져오기는 라벨
  형식이 없으면 첫 줄을 제목으로, 나머지 텍스트를 회의록 초안으로 채우는 방식으로 대체(fallback)한다.
- 로컬 Whisper CLI 프로바이더는 PC에 `openai-whisper`(pip)와 ffmpeg가 사전 설치되어 있어야 동작한다.

## Memory Bank

이 프로젝트는 `memory-bank/` 시스템을 사용합니다.

| 파일 | 용도 |
|------|------|
| `memory-bank/active-context.md` | 현재 작업 포커스 |
| `memory-bank/STATE.md` | Wave 진행 상태 |
| `memory-bank/CACHE.md` | 세션 중 임시 발견사항 |
| `memory-bank/knowledge/PATTERNS.md` | 재사용 코드 패턴 |
| `memory-bank/knowledge/RULES.md` | 프로젝트 규칙 |
| `memory-bank/knowledge/trouble-shooting.md` | 버그 해결 기록 |

**세션 시작 시**: `active-context.md` → `STATE.md` 순으로 읽고 현재 상태를 파악할 것.
