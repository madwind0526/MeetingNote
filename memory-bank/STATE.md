# State

## Current Wave

- **Wave:** C1
- **Status:** Done - **오디오 분석 UI 통합 + 1시간 회의 대응 + 사전 치환 버그 수정**
- **Cache Status:** CLEAN
- **Last Checkpoint (C1, 2026-08-25):** 대규모 단일 세션. 주요 항목:
  - **오디오 분석 팝업 통합**: 파일 업로드/PC 소리 녹음이 동일한 UI(전처리·엔진·모델·대본 불러오기·
    화자별 편집)를 쓰도록 통합. 녹음은 팝업이 뜨자마자가 아니라 "분석 시작" 클릭 시점에만 실제 녹음
    시작(`systemAudioCapture.ts`의 `startRecording()` 분리). 대본 파일 불러오기(`parseTranscriptText`,
    구분자 무관 파서) + 발언 단위 화자 재배정 드롭다운 추가. 대본 줄 클릭 시 파형에서 해당 구간 하이라이트.
  - **MD 뷰어**: 첨부 자료의 .md 변환본과 회의록을 외부 앱 대신 앱 내 팝업(`MdViewerModal`,
    react-markdown)으로 열도록 변경. 회의록 편집 화면에 편집/미리보기 토글 추가.
  - **1시간 회의 대응**: Anthropic `max_tokens` 1024→8192, Ollama `num_ctx` 명시적 8192 설정(둘 다
    긴 회의록에서 조용히 잘리거나 앞부분이 잘리는 문제였음). B5(발표 내용 정리)가 전체 대본 대신
    Agenda 순서+발표 시간으로 추정한 구간만 윈도잉해서 보내도록 변경(`windowTranscriptForAgendaItem`,
    최대 8000자 캡). B5 출력 포맷을 `[발표 내용]`(자료 우선, 대본은 보조) + `[논의 내용]`
    ((의견)/(질문)/(답변)/(참고), 발표자 기준 명확히 정의)으로 재작성.
  - **STT 환각 방지**: 무음 구간(RMS 임계값, Settings에서 조정 가능·기본 0.004)은 STT 호출 자체를
    건너뛰어 Whisper의 무음 환각(예: "다음 영상에서 만나요") 방지.
  - **사전(약어/수정) 치환 버그 3단계 수정**: 단순 substring 매치(`CD`가 `CDN` 안에서 매치) →
    `\p{L}` 경계로 고쳤더니 한글 조사 붙는 정상 케이스(`AI를`)까지 막힘 → 스크립트 인식 경계 +
    한글 조사 허용 목록으로 해결. 추가로 엔트리를 순차 적용하면 한 엔트리의 치환 결과를 다른 엔트리가
    또 매치하는 연쇄 버그(`에이아이`→`AI (Artificial Intelligence)`의 "AI"를 별도 `AI` 엔트리가 재매치)가
    있어, 전체 엔트리를 원본 텍스트 기준으로만 매치 수집 후 단일 패스로 재조립하도록 재설계. 상세는
    `knowledge/trouble-shooting.md`.
  - **Settings**: System Message 필드 신규(모든 LLM 호출에 공통 프리펜드, `server/llm.mjs`의
    `resolveSystemPrompt`), 무음 임계값 필드, CPU/GPU·VAD onset/offset 섹션 재배치, 상태 확인을
    "설치 여부만(파일 존재 체크)" 기본 + "설치 여부 확인" 버튼(페이지 헤더로 이동, 로딩 상태 표시)으로
    분리 - Claude CLI/Whisper CLI/WhisperX를 매번 spawn해서 확인하던 것이 초기 로딩 지연의 실제 원인
    중 하나였음.
  - **시작 성능**: git 기반 Build Version 계산(매 요청마다 `git status --porcelain` 등 3개 subprocess
    spawn) 제거, `package.json`의 `version`을 그대로 사용하는 수동 버전으로 전환.
  - **샘플 데이터**: 기존 등록 회의록/음성 프로필 전체 초기화 후, 실제 파이프라인(자료 업로드→MD
    변환→오디오 등록→STT(Whisper CLI)→B5(Ollama)→B6(Ollama)) 전체를 5회 실행해 샘플 회의록 5건 생성
    (`tools/e2e/generate-5-samples.mjs`, 기존 test-audio 샘플 오디오 재사용).
  - `npx tsc -b` 매 변경 후 클린 통과. 커밋/푸시는 `data/attachments`(신규 5건 폴더) 포함해서 별도 진행.
- **Last Checkpoint:** 오디오 보관 정책(B7) 완료 - roadmap 전제를 재확인 후 정정한 Wave. roadmap은
  "화자별로 분리된 오디오 파일을 완료 후 삭제"를 가정했는데, 실제 코드를 추적해보니 그런 파일은 애초에
  존재하지 않았다(`AudioAnalysisModal`의 "화자별 파형"은 `speakerMasks`로 하나의 공유 오디오 버퍼를
  시간대별로 하이라이트만 하는 클라이언트 렌더링일 뿐, `toggleSpeakerPlayback`도 같은 `<audio>` 엘리먼트를
  seek할 뿐 별도 파일을 재생하지 않음). 대신 더 중요한 실제 공백을 발견: `saveAttachment`의
  `kind: "audio"` 저장 경로 자체는 이미 존재하는데(`uploadAttachment(..., "audio", file)`) 실제로
  호출하는 곳이 코드베이스 어디에도 없어서, 분석이 끝나면 원본 녹음이 아예 저장되지 않고 버려지고
  있었다(`pendingAudioFile`은 React state에만 있다가 모달이 닫히면 사라짐). AskUserQuestion으로 확인 후
  "원본 녹음만 보관하도록 구현"으로 범위를 재설정(화자별 삭제 정책은 대상이 없어 해당 없음). 구현:
  `AudioAnalysis.audioPath` 필드 추가, `MeetingFormModal`의 `handleAudioComplete`가 이제 async로
  `pendingAudioFile`을 `kind: "audio"`로 업로드하고 결과 경로를 `draft.audio.audioPath`에 저장(best-effort
  - 업로드 실패해도 이미 완료된 분석 결과는 그대로 유지). 폼에 "원본 오디오 열기" 버튼,
  `MeetingDetailModal`에도 읽기 전용 "음성 파일" 행 + 열기 버튼 추가(기존 `openAttachment()`/
  `handleOpenMaterial` 재사용, 새 열기 메커니즘 없음). `server/db.mjs`의 `normalizeAudio`에
  `audioPath` 통과 로직 추가. `tsc -p tsconfig.json` + `tsc -p tsconfig.node.json` 둘 다 0 에러.
  검증: 실제 UI로 새 회의록에 오디오 업로드→Mock 분석→"원본 오디오 열기" 버튼 등장 확인→저장 후
  `data/db/meetings.json`의 `audioPath` 필드 확인→`data/attachments/.../audio/`에 실제 wav 파일이
  저장된 것을 파일시스템에서 직접 확인→상세 화면의 "음성 파일" 행에서도 열기 버튼이 실제로 파일을
  여는 것까지 end-to-end 확인. 테스트 중 생성된 회의록/첨부 폴더는 정리, STT 프로바이더 설정도 원복.

## Previous checkpoints (B4/B5/B6)

**B4(발표 자료 MD 컨버터)**: `server/converters/toMarkdown.mjs`(신규) - PDF(`pdf-parse`)/DOCX
(`mammoth.convertToMarkdown`)/PPTX(JSZip 슬라이드 XML 추출) 지원. `saveAttachment()`가 PDF/DOCX/PPTX
업로드 시 `.md` 형제 파일을 자동 저장, `AgendaItem`/`ActionItem`에 `materialMdPath` 필드로 구조적 연결.

**B5(발표별 내용 정리)**: AskUserQuestion으로 "LLM이 전체 대본에서 알아서 찾게 함"을 확정(시간 구간
데이터 모델 없음). `buildPresentationSummaryPrompt`(server/llm.mjs), `/api/llm/presentation-summary`,
`AgendaItem.presentationSummary`, `PresentationSummaryModal.tsx`. **실측 버그**: 배지 라벨 맵에서
주관자 지정이 참석자 루프보다 먼저라 참석자 목록에도 있는 주관자의 라벨이 덮어써짐 - 순서를 바꿔 수정,
재검증 완료. `server/llm.mjs`(순수 .mjs)가 `src/types/domain.ts`를 import 못 하고, `vite.config.mts`에서
직접 import하면 tsconfig.node.json의 composite 프로젝트 파일 목록 위반(TS6307) - 로컬 경량 타입+로직
중복(`computeAttendeeBadgesForPrompt`)으로 우회.

**B6(전체 회의록 합성 + 할일 통합 표)**: AskUserQuestion으로 새 기능을 만들지 않고 기존 "회의록 작성"
버튼(`generateMinutes`/`buildMinutesPrompt`/`MINUTES_SYSTEM_PROMPT`)을 프롬프트 레벨에서 개선하는
쪽으로 확정 - 새 API/UI 없음. Agenda 항목의 B5 `presentationSummary`를 "우선 근거"로 프롬프트에 포함,
할일/담당자/납기 3컬럼 표로 전부 통합하도록 시스템 프롬프트 지시 추가.

## Wave History

| Wave | 작업 내용 | 상태 |
|------|-----------|------|
| 1 | 프로젝트 초기화 (memory-bank) | Done |
| 2 | 기반 골격 (타입/설정/Vite API 계약/CSS 토큰) | Done |
| 3 | server/db·llm·audio·parsers·exporters + UI 셸 (병렬 sub-agent 4개) | Done |
| 4 | MeetingFormModal·AudioAnalysisModal·Import/Export·기타 모달 (병렬 sub-agent 4개) | Done |
| 5 | App.tsx 전체 배선, CLAUDE.md/README.md 작성 | Done |
| 6 | npm install + 빌드 + 런타임 API 스모크테스트 검증 | Done |
| 7 | 테스트 회의록 첨부 파일(DOCX/PDF/PPTX) 실제 test용 text 포함 파일로 재생성 및 검증 | Done |
| 8 | 첨부 폴더 규칙을 `assets/attachments/YYYY-MM-DD-{회의 제목}`로 변경하고 전체 샘플 첨부 파일/DB/seed/문서 업데이트 | Done |
| 9 | 테스트 회의록 첨부 폴더를 날짜 포함 규칙으로 최종 정리하고 legacy `data/attachments` 삭제 | Done |
| 10 | 첨부 기준 폴더를 `data/attachments`로 수정하고 legacy `assets/attachments` 삭제 | Done |
| 11 | DB저장/복원 분리+MD, Naver Clova STT, 분석 진행률, 3-way 화자 분리(WhisperX/Naver Clova/Whisper CLI+pyannote), 다수 실버그 수정 | Done |
| A1 | 사용자 인증 시스템(Club 방식 로그인/세션/계정 관리) 신규 구현 | Done |
| A2 | 회의록 삭제 권한(작성자/admin) + 회의록 댓글 | Done |
| A3 | 게시판 신규 기능(Club BoardPost/BoardComment 이식) | Done |
| B1 | 간사 필드 + 발표자/참석자 뱃지(발표N/참석N) | Done |
| B2 | 치환 사전(약어 사전 + 수정 사전), STT 후처리 자동/소급 적용 | Done |
| B3 | 화자 음성 프로필 영속화(pyannote 임베딩, WhisperX/Whisper CLI 공용 diarization 파이프라인 통합) | Done |
| B4 | 발표 자료 MD 컨버터(PDF/DOCX/PPTX → MD, 첨부 업로드 시 자동 생성) | Done |
| B5 | 발표별 내용 정리(질문/답변/의견/할일 구조화, LLM이 전체 대본에서 관련 구간 탐색) | Done |
| B6 | 전체 회의록 합성 + 할일 통합 표(기존 "회의록 작성" 버튼 개선) | Done |
| B7 | 오디오 보관 정책(원본 녹음 보관 - roadmap 전제 재확인 후 범위 정정) | Done |
| B8 | 내장 파일 탐색기(OS 탐색기 차단 환경용), 약어 사전 675개 확장, 필터 모달 개편, 계정 신청/활성화 토글 | Done |
| C1 | 오디오 분석 UI 통합, MD 뷰어, 1시간 회의 대응(토큰/윈도잉), STT 환각 방지, 사전 치환 버그 수정, Settings 정리, 시작 성능, 샘플 회의록 5건 재생성 | Done |

## Session Notes

- PhoneBook을 1차 기준으로 삼아 전체 구조를 이식했고(SNS-Reader는 참고자료로만 사용), 오디오 분석·STT
  프로바이더 선택(무료 기본값)처럼 PhoneBook에 없는 신규 기능은 사용자 스펙에 맞춰 새로 설계했다.
- 8개 sub-agent(Wave 3 4개 + Wave 4 4개)를 병렬로 위임했고, 계약(domain.ts → vite.config.mts → app.css)을
  먼저 고정해둔 덕에 통합 시 인터페이스 충돌이 없었다. `tsc -b`가 통합 후 첫 시도에 0 에러로 통과.
- Wave 11에서 실제 환경 검증 완료: 로컬 openai-whisper CLI/WhisperX 실제 설치 환경에서 JSON 출력 형태
  확인, 실제 HF 토큰으로 pyannote 게이트 모델 다운로드/로딩 확인. (OpenAI Whisper API는 여전히 API 키가
  없어 미검증.)
- **화자 분리 버그를 실제로 찾아 고침**: 브라우저 업로드 경로로만 화자 분리가 1명으로 뭉개지는 문제가
  있었다. 처음엔 "pyannote가 이 합성 음성 쌍을 판정 경계선에서 헷갈려 한다"고 잘못 결론 내렸는데,
  사용자가 "같은 성공 경로를 다시 재현해보라"고 지적해서 계속 판 끝에 진짜 원인을 찾음:
  `src/lib/audio.ts`의 `encodeWav()`가 float→int16 변환 시 `Math.round` 없이 `DataView.setInt16`에
  넘겨서 매 샘플마다 0쪽으로 버림 처리되고 있었다(자세한 내용: `knowledge/trouble-shooting.md`,
  글로벌 `C:\Claude\memory-bank\web-audio-pcm-int16-rounding.md`). `Math.round()` 추가로 해결, 수정 후
  브라우저 경로에서도 원본과 동일하게 2화자 정확 분리를 연속 2회 재현 확인함.
- 2026-08-18: 사용자가 10개 신규 요구사항을 추가로 구술(간사 필드, 발표자/참석자 뱃지, 발표별
  질문/답변/의견/할일 정리, 오디오 보관 정책, 회의록 댓글, 회의록 삭제 권한, 게시판, 약어 사전 UI,
  수정 사전 UI). 사용자 인증 방식(Club과 동일한 로그인 시스템)을 AskUserQuestion으로 확인받아 확정.
  전부 `memory-bank/roadmap.md`에 트랙 A(A1~A3: 인증/권한/게시판) + 트랙 B(B1~B7: 회의록 파이프라인
  고도화)로 재정리해둠 - 아직 코드 착수 전.
- **트랙 A(A1~A3) + 트랙 B(B1~B7) 전부 완료(2026-08-18 단일 세션)**. 사용자의 "순서대로 해줘 A, B"
  지시가 끝까지 완수됨. 각 Wave 착수 전 실제로 열려있던 설계 질문은 전부 AskUserQuestion으로 확인 후
  진행(B1 뱃지 위치, B3 계속 진행 여부, B5 오디오-Agenda 시간 매칭 방식, B6 합성 기능 범위, B7 roadmap
  전제 재확인) - 전부 `memory-bank/roadmap.md`와 `STATE.md`에 결정 근거 기록됨.
  다음 세션은 **사용자에게 새 우선순위를 확인**해야 함(계획된 Wave 소진). 그 외 남은 것: Electron
  패키징(`npx electron-builder`) 검증, 회사 PC(오프라인) 이전을 위한 로컬 Whisper 오프라인 설치 번들
  준비, 여유가 되면 실제 사람 목소리 다화자 녹음으로도 화자 분리/음성 프로필 한 번 더 확인(지금까지는
  합성 음성으로만 검증됨 - B3의 `SIMILARITY_THRESHOLD=0.85`도 그 합성 음성 1쌍 기준).
