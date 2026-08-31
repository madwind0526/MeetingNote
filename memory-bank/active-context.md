# Active Context

## Current Focus

- **회의 음성 분석 4단계 워크플로우 구현 완료 (분석 시작 / 화자 분리 / 발표 정리 / 회의록 작성)**:
  `MeetingFormModal`의 기존 2버튼(분석 시작/회의록 작성)을 4버튼으로 확장. "화자 분리"는
  `AudioAnalysisModal`을 재사용(같은 `handleOpenAudioAnalysis`)해서 열되, 재오픈 시 기존
  `draft.audio.transcriptSegments`를 `loadExternalTranscript`로 왼쪽에 자동 로딩(새 useEffect).
  화자명 입력창 `onBlur`에서 그 라벨의 `speakerEmbeddings`로 즉시 `/api/voice-profiles/register` 호출(음성
  프로필 실시간 등록), 모달 안 새 "다시 화자 분리" 버튼은 새 `/api/voice-profiles/rematch`
  라우트(`matchSpeakerProfile` 재사용)로 현재 세션의 모든 라벨을 등록된 프로필과 다시 매칭 -
  **화자 embedding은 라벨(클러스터) 단위만 존재하고 세션 메모리에만 있음(회의록 JSON에 저장 안 함, 사용자
  확정)**, 재오픈 세션에서는 재매칭 버튼이 숨겨짐(임베딩 없음). "발표 정리"는 새
  `handleGenerateAllPresentationSummaries`로 모든 Agenda 항목의 B5 정리를 순차 일괄 생성(기존 항목별
  봇 아이콘 팝업은 그대로 유지). Playwright로 실제 회의록("결제 모듈 개발 현황 점검") 열어 실사용
  테스트 완료, 사용자가 발견한 버그 2개 재현·수정: (1) "화자 분리" 재오픈 시 `loadExternalTranscript`가
  저장된 화자 이름 대신 원시 라벨(`SPEAKER_01`)로 덮어쓰던 것 → `existingAnalysis.speakerMap`으로
  `editedSpeakerMap`을 명시적으로 재시딩, (2) 세그먼트별 자유 입력이 안 겹치는 이름을 타이핑하면
  디스커넥트된 새 라벨을 만들어 동명이인이 생기던 것 → "안 겹치면 현재 라벨 이름 자체를 바꾼다"로 변경.
  음성 프로필 등록 자체는 정상 동작 확인(blur 시 실제 embedding과 함께 `voiceProfiles.json`에 기록됨),
  단 합성 테스트 음성은 두 화자가 음향적으로 비슷해 재매칭이 틀리기도 함(기존에 알려진 유사도 임계값
  한계, 이번 세션 버그 아님). 상세는 trouble-shooting.md의 "화자 분리 재오픈..." 항목 참고.
- **가져오기(파일에서 가져오기) TXT 추가 + 라벨/필드 라운드트립 정합성 수정 완료**: "새 회의록 등록"의
  "파일에서 가져오기"에 TXT 지원 추가(`server/parsers/importMd.mjs` 재사용). 그 과정에서 발견된 문제
  전부 수정: (1) 4개 import 파서(md/pdf/docx/pptx)가 "제 목"처럼 글자 사이 공백이 낀 라벨을 못 읽던 것을
  `normalizeLabel()`로 정규화, (2) `location`(장소)/`secretary`(간사) 필드가 어느 가져오기·내보내기
  경로에도 없던 것을 4개 import + 4개 export + `importJson.mjs` + `MeetingFormModal.tsx` 필드 복사
  목록까지 전부 추가, (3) `exportDocx`/`exportPptx`가 시작/종료 시각을 "시간: X ~ Y" 한 줄로 합쳐 써서
  재가져오기 시 파싱이 안 되던 것을 "시작:"/"종료:" 별도 줄로 분리, (4) `importPptx.mjs`가 슬라이드의
  모든 텍스트 런을 공백으로만 이어붙여 제목 슬라이드 라벨 줄 구분이 사라지던 것을 문단(`<a:p>`) 단위
  개행으로 수정. `imports/회의록 불러오기.txt` 샘플로 실제 파싱 검증 완료, `npx tsc -b` 통과. 상세는
  `memory-bank/knowledge/trouble-shooting.md` 참고.
- **Configured file-picker regression follow-up**: All file-open entry points now share `pickFileWithConfiguredPicker`
  (built-in navigator, Electron native dialog, then browser input fallback). Electron open/save/folder dialogs attach to
  the current BrowserWindow. `npm run build` passes.
- **Audio playback transcript sync follow-up**: Waveform playhead now uses a small visual latency compensation, the
  active transcript row is highlighted and scrolled into view during playback, and unlabeled STT segments inherit the
  previous explicit speaker instead of falling back to `A`. `npm run build` passes.
- **Audio transcript attachment follow-up**: Completed STT analysis now saves a transcript `.txt` next to the original
  audio attachment, persists `audio.transcriptPath`, shows the saved original audio/transcript paths and transcript text
  in edit mode, and links both files from the detail modal. `npm run build` passes.
- **브라우저/Playwright 파일 탐색기 경로 수정 완료**: `127.0.0.1:5185` 접속에서도 설정의 `탐색기 방식` 섹션을 표시하고, 내장 파일 탐색기는 Vite `/api/file-navigator/*` fallback으로 동작. 기본 모드는 브라우저 `input[type=file]` chooser 이벤트 확인, 내장 모드는 새 회의록 `회의 음성 파일`에서 모달/파일 선택 확인. `npm run build` 통과.
- **다음 작업 대기 (사용자 등록, 미착수)**:
  1. 오디오 분석에 파일 업로드 외에 마이크 실시간 녹음(stream-in) 경로 추가 - 녹음하면서 STT 진행.
- **내장 파일 탐색기 구현 완료 (보안 정책으로 OS 탐색기가 막힌 환경용)**: Settings에 "탐색기 방식"
  섹션 추가(탐색기/내장 파일 탐색기, 기본값 탐색기). 내장 모드에서는 Electron 메인 프로세스의
  `fs.readdir`/`fs.stat`만 사용하는 폴더 브라우저(`FileNavigatorModal`)로 로고 업로드·저장 폴더 선택·
  약어/수정 사전 추가하기/불러오기·회의록 가져오기(DB복원)·회의록 자료/음성 파일 첨부·DB저장/내보내기를
  전부 대체. `saveExportedFile`/`pickAttachmentsFolder`(lib/api.ts)는 `settingsMirror`를 통해 현재
  모드를 읽으므로 각 모달에 prop을 새로 뚫지 않고도 동작. Electron 실제 창으로 부팅 확인(에러 없음)까지
  마쳤으나, CDP 연결 불가로 내장 탐색기 UI 자체의 클릭 상호작용까지는 자동 테스트하지 못함 - 다음 세션
  에서 실제 사용해보고 문제 있으면 보고 필요.
- **약어 사전 완료**: 30개 → 675개로 확장(SemiconductorX/Samsung 공식 용어집/munsla.com/사용자 제공
  PDF에서 실제 사용되는 약어만 선별, PDF 안에 섞여 있던 Copper-Tantalum/Copper Seed/Clock Tree
  Synthesis 조합형 가짜 약어(~360개)와 일반 단어(용어)는 제외).

<!-- 
규칙:
- 최근 작업 10개만 유지 (오래된 항목은 삭제)
- 완료된 Wave의 내용은 CACHE.md로 이동 후 삭제
- 이 파일은 "지금 무엇을 하고 있나" 스냅샷, 히스토리 아님
-->
