# RevisionNote

커밋별 변경 이력입니다. **최신 커밋이 맨 위**에 오도록 기록합니다. 새 커밋을 만들 때마다 맨 위에 새
항목을 추가해 주세요(아직 커밋하지 않은 작업 중인 변경사항은 여기 적지 않고, 실제 커밋한 뒤에 그 커밋의
해시/날짜/내용으로 추가합니다).

---

## `10f722e` — 2026-08-31 — feat: settings contrast fix, TXT import + label round-trip fixes, and 4-stage audio speaker workflow

- Settings: 선택된 LLM/STT 프로바이더 카드와 GPU/CPU·탐색기 방식 토글 버튼의 선택 상태 대비를 높임(라이트/
  다크 모두) - 기존엔 hover 상태와 거의 구분이 안 됐음.
- 가져오기: "파일에서 가져오기"에 Text(.txt) 형식 추가(`importMd.mjs`의 라벨 파서 재사용). 추가하는 과정에서
  4개 가져오기/내보내기 형식 전반에 걸쳐 있던 기존 라운드트립 버그들도 같이 수정: 라벨 매칭이 글자 사이
  공백("제 목" → "제목")을 허용하도록, 장소(location)/간사(secretary)가 어느 가져오기·내보내기 경로에도
  없던 것, docx/pptx 내보내기가 날짜/시간/제목을 자기 자신도 못 읽는 형식으로 쓰던 것(이번 세션 이전부터
  있던 버그), pptx 슬라이드 텍스트 추출이 모든 텍스트 런을 한 줄로 뭉개서 제목 슬라이드의 여러 필드 파싱이
  깨지던 것.
- README: 가져오기/내보내기 지원 형식과 라운드트립 한계 문서화(DOCX/PPTX의 Agenda/A-I List는 평문 번호
  목록으로만 살아남고 실제 표는 못 읽음), FFmpeg torchcodec DLL 못 찾는 문제 트러블슈팅을 PATH 설정만으로는
  부족할 때 FFmpeg *.dll을 torchcodec 폴더에 직접 복사하는 방법으로 갱신.
- 회의 음성 분석: "분석 시작"/"회의록 작성" 2단계를 분석 시작/화자 분리/발표 정리/회의록 작성 4단계로
  분리. "화자 분리"는 저장된 회의의 대본을(원시 라벨이 아니라 저장된 화자 이름까지) 자동 로딩한 채로
  `AudioAnalysisModal`을 재오픈하고, 화자 이름을 바꾸면 즉시 음성 프로필을 등록/보강하며, "분석 시작" 옆의
  "다시 화자 분리" 버튼은 지금까지 등록된 프로필로 모든 화자 라벨을 다시 매칭함. 새
  `/api/voice-profiles/rematch` 라우트(`server/voiceProfiles.mjs`의 `scoreSpeakerProfileMatch`)와,
  이 라우트·`assignSpeakersWithProfiles` 양쪽에 점수 기준으로 이름을 선점하는 2단계 매칭을 추가해서 한
  녹음 안의 서로 다른 두 화자가 같은 저장된 프로필로 동시에 매칭되는 것을 막음. 세그먼트별 화자 입력을
  드롭다운에서 자유 입력으로 바꿔서, 안 겹치는 이름을 입력하면 그 세그먼트가 속한 라벨만 이름이 바뀌고
  (다른 세그먼트는 그대로), 다른 라벨과 이름이 겹치게 되면 자동으로 병합해서 동명이인이 남지 않게 함.
  "발표 정리"는 모든 Agenda 항목의 B5 정리를 한 번에 순차 생성(기존 항목별 팝업은 그대로 유지).
- `imports/회의록 불러오기.{txt,md,json,pdf,docx,pptx}` 테스트 샘플 파일과 `RevisionNote.md`(이 파일,
  커밋별 변경 이력 - 앞으로 커밋할 때마다 계속 추가) 추가.

## `e39fb33` — 2026-08-29 — feat: adaptive STT chunk sizing, meeting location field, real-time refresh, and long-meeting fixes

- STT 청크 크기가 회의 길이에 따라 자동 조정(1/2/5분 구간)되도록 하고 Settings에서 값을 조정할 수 있게 함.
  20분 넘는 오디오 저장이 조용히 실패하던 첨부파일 업로드 용량 제한도 함께 수정(50MB → 200MB, base64
  인플레이션 계산 보정).
- `buildMinutesPrompt`가 모든 Agenda 항목에 B5 발표 정리본이 있으면 원본 대본 전체를 생략하도록 해서, 긴
  회의에서 회의록이 잘리던 문제 수정(47분 회의 기준 회의록 길이가 800자 → 1584자로 회복).
- 회의 기본정보에 장소(location) 필드 추가(폼/상세보기/회의록 프롬프트). 새 회의록 폼에서는 저장 전에는
  의미 없는 상태 배지 대신 장소 필드를 표시.
- 회의 폼의 날짜/장소/시간 행 재배치. 시간 입력을 네이티브 피커 대신 "HH:MM" 직접 입력(범위 clamp)으로
  변경.
- `meetings.json`이 앱 내 저장/가져오기/외부 스크립트 등 어디서 바뀌든 SSE로 자동 새로고침되도록 함(기존
  폴링 방식 대체), 수동 새로고침 버튼도 추가.
- `tools/e2e/` 테스트 도구/픽스처 추가: STT 모델 벤치마크, 청크 크기 스윕, 단어 수 완전성 검사, 4/8/24/
  47/71분 길이 회의 전체 파이프라인 테스트.
- README에 STT 벤치마크, 청크 크기 검증, 처리 시간 예상표 문서화.

## `45fdee0` — 2026-08-25 — docs: fix FFmpeg download instructions to use the pinned 7.1.1 archive build

- `ffmpeg-release-full-shared.7z`(롤링 링크, 항상 최신 버전 가리킴)가 프로젝트가 고정 가정하는
  `ffmpeg-7.1.1-full_build-shared` 경로와 버전이 어긋나던 문제 → release-archive의 버전 고정 빌드로
  안내 변경.

## `bf556fd` — 2026-08-25 — chore: rename screenshot file

- 스크린샷 파일명 변경.

## `c450c4d` — 2026-08-25 — feat: unify audio analysis UI, add MD viewer, harden dictionary matching, prep for 1-hour meetings

- 파일 업로드/PC 소리 녹음 오디오 분석 팝업을 하나로 통일(전처리/엔진/모델/대본 불러오기/화자 편집 공유),
  실제 녹음 시작을 "분석 시작" 클릭 시점으로 지연.
- `MdViewerModal`(앱 내 마크다운 뷰어) 추가 - 발표 자료 MD 변환본/회의록에 사용, 외부 앱으로 여는 방식
  대체. 회의록 필드에 편집/미리보기 토글 추가.
- B5(발표 내용 자동 정리) 출력 형식을 `[발표 내용]`/`[논의 내용]` + `(의견)/(질문)/(답변)/(참고)` 태그
  고정 형식으로 재작성. 발표 자료 우선, 대본은 보조 소스로.
- 1시간 회의 대비: Anthropic max_tokens(1024→8192), Ollama num_ctx(8192) 상향(긴 회의에서 내용이
  조용히 잘리던 문제). B5 입력 대본을 회의 전체가 아니라 해당 Agenda 항목의 추정 구간(가장 가까운
  pause로 스냅)으로 제한.
- 무음 임계값(RMS, 기본 0.004) 아래 오디오는 STT 호출을 건너뛰어 환각(hallucination) 방지.
- 약어/수정 사전 부분 문자열 매칭 버그 3단계 수정: 단순 substring 치환(CDN 안의 CD가 깨짐) → 단어 경계
  적용이 한글 조사 결합(AI를/CPU가)까지 막던 과교정 → 순차 적용 시 한 엔트리의 치환 결과가 다른 엔트리에
  재매칭되던 문제. 스크립트 인식 경계 + 한글 조사 허용 목록 + 원본 기준 단일 패스 치환으로 해결.
- Settings에 System Message 필드 추가(모든 LLM 호출에 공통 적용), Claude/Whisper/WhisperX 상태 확인을
  기본은 설치 여부만 확인하는 가벼운 체크로, 전체 spawn 검증은 "설치 여부 확인" 버튼으로 분리, git 기반
  빌드 버전 계산 제거(체크마다 git 프로세스 3개 spawn하던 것 제거).
- 등록된 회의/음성 프로필 초기화 후 실제 파이프라인(자료→MD→오디오→Whisper CLI STT→Ollama B5→Ollama
  B6)으로 샘플 회의 5건 재생성. `tools/e2e/generate-5-samples.mjs` 추가.
- README/memory-bank 현재 상태 반영 갱신.

## `6114082` — 2026-08-24 — feat: unify recording/file audio analysis UI, add transcript import and editing, fix STT/UX issues

- PC 녹음 팝업을 파일 업로드 팝업과 통일(동일한 전처리/엔진/모델 컨트롤, 대본 불러오기, 세그먼트별 화자
  편집). 녹음 캡처(MediaRecorder)는 "분석 시작" 클릭 시에만 시작(실시간 파형은 팝업 열리자마자 표시).
- 대본 파일 가져오기(`parseTranscriptText`, 구분자 비의존 파서) 추가, 세그먼트별 화자 재지정 드롭다운
  추가(파형 레인은 `segment.speaker` 기반으로 자동 반영).
- 대본 줄 클릭 시 해당 구간으로 재생 위치 이동 + 파형에서 해당 구간 하이라이트.
- 원본/전처리 파형 간 재생 위치(playhead) 드리프트 수정(하나의 duration 기준 공유).
- tsc/vite 자식 프로세스에 windowsHide 추가(Electron spawn 자체는 되돌림 - 메인 창이 안 뜨는 문제),
  CPU/GPU 연산 장치 설정, WhisperX VAD onset/offset 설정 추가.
- Claude CLI/Whisper CLI/WhisperX 상태 확인을 앱 시작 시가 아니라 Settings를 열 때로 지연(시작 시
  서브프로세스 spawn 감소).
- 로컬 Whisper CLI/WhisperX에서 하드코딩된 `--language Korean` 제거(비한국어 청크가 강제로 한국어로
  디코딩되던 문제), 무음에 가까운 청크는 STT 자체를 건너뛰어 환각 방지.
- 청크 처리/대기 진행 카운터 추가(녹음 중지 후 후처리 대기가 멈춘 것처럼 보이던 문제 개선).
- Settings UI 정리(섹션 설명 인라인화, 프로바이더 행 버튼 정렬 통일, 중복 테마 섹션 제거).

## `8841a50` — 2026-08-24 — feat: progressive chunked audio analysis for both file upload and live recording

- 파일 업로드/"PC 소리 녹음" 흐름을 하나의 팝업(`AudioAnalysisModal`)으로 통합: 둘 다 즉시 파형을
  보여주고, "분석 시작" 클릭 후 오디오를 ~15-20초 단위(무음 지점에서 컷, `findQuietCutSample`)로 잘라
  기존 파일 단위 STT+화자분리 파이프라인에 순차로 통과시켜 대본/파형/화자 레인이 전체 완료를 기다리지
  않고 점진적으로 채워지도록 함. 모든 구간이 끝나야 저장 가능.
- 클라이언트 측 코사인 유사도 체크(`speakerSessionLinking.ts`) 추가 - 미등록 화자가 분석 세션 내
  여러 구간에서 매번 새 번호로 리라벨링되지 않고 같은 라벨을 유지하도록 함(등록/기명 화자는 서버의
  영구 음성 프로필 매칭으로 이미 일관됨).
- `systemAudioCapture.ts`를 하나의 연속 MediaRecorder 대신 독립적으로 디코딩 가능한 녹음 구간을
  순환하는 방식으로 재작성 - 캡처 진행 중에도 같은 청크 파이프라인에 태울 수 있게 함. 녹음 제어를
  `MeetingFormModal`에서 팝업 자체로 이동(클릭 시 즉시 열리고 `LiveWaveform`으로 실시간 파형 표시).
- 팝업 크기를 고정 크기 대신 앱 창을 채우는 크기(`ModalShell` "full")로 확대.

## `f98b1d8` — 2026-08-24 — Add runtime app settings data

- 런타임 앱 설정 데이터 파일(`data/runtime/app-settings.json`) 추가.

## `a879af3` — 2026-08-24 — Add sample import and export files

- 약어/수정 사전 내보내기 샘플(`exports/abbreviation-dictionary.json` 등), 회의록 내보내기 샘플, 화자
  분리/STT 테스트용 오디오 샘플(`imports/*.wav`) 다수 추가.

## `1c90915` — 2026-08-23 — feat: file navigator, dictionary/filter overhaul, audio workflow, and startup perf fixes

- OS 파일 선택 창이 막힌 환경을 위한 내장 파일 탐색기(`FileNavigatorModal`) 추가.
- 약어 사전 30개 → 675개로 확장, 필터 모달 개편(TAG/Connection range, `[*]/[+]/[-]` 쿼리 문법),
  self-service 계정 신청 + 관리자 활성화 토글 추가.
- STT 대본을 원본 오디오 첨부파일 옆에 저장, 재생 중 파형 재생위치/대본 하이라이트 동기화, 라벨 없는
  STT 세그먼트가 마지막으로 알려진 화자를 이어받도록 함.
- 시작 속도 개선: `npx tsc`/`npx vite` 호출을 직접 node 진입점 호출로 교체(npx가 매 실행마다 레지스트리
  재확인/프로브하던 비용 제거), Electron 메인 프로세스 빌드와 Vite dev 서버 기동을 순차가 아니라 동시
  실행, dev-서버 준비 확인을 fetch 대신 TCP 헬스체크로 변경(프록시 우회), `start.bat`이 매번 기존 dev
  서버를 강제 종료하던 것을 중단하고 Electron 종료와 무관하게 Vite가 살아있도록(detached+unref) 해서
  최초 요청 시 ~20초 걸리는 모듈 변환 비용을 세션당 1회만 지불하도록 함(PID lock 파일로 중복 실행 방지),
  렌더러의 회의/설정 로드와 메인 프로세스의 git 기반 빌드 정보 조회를 병렬화.
- 로그인 없이 로컬에서 바로 쓰기 위한 "로그인 건너뛰기"(기본 admin 계정) 단축 경로 추가(로그인/회원
  시스템 자체는 유지).
- 샘플 데이터(회의 DB, 첨부파일, 테스트 오디오)를 요청에 따라 git 추적 대상으로 전환.

## `02c4c81` — 2026-08-21 — feat: expand meeting workflows and file picker support

- `DictionaryModal`(약어/수정 사전 관리), `FileNavigatorModal`/`FileNavigatorHost`(내장 파일 탐색기),
  `MemberManagementModal`(회원 관리), `PresentationSummaryModal`(발표 내용 정리), `BoardView`/
  `MeshView`(게시판/네트워크 보기) 등 다수의 화면·모달 신규 추가.
- 인증(`lib/auth.ts`), 게시판(`lib/board.ts`), 사전(`lib/dictionary.ts`), 파일 선택기(`lib/filePicker.ts`),
  설정 미러(`lib/settingsMirror.ts`), 시스템 오디오 캡처(`lib/systemAudioCapture.ts`) 등 라이브러리 모듈
  다수 추가.
- `MeetingFormModal`/`MeetingDetailModal`/`FilterModal`/`ImportModal` 등 기존 화면 대폭 확장.

## `46fdc7c` — 2026-08-17 — Add single-meeting import/export, DB backup split, Naver Clova STT, and speaker diarization

- 사이드바의 가져오기/내보내기를 단건(회의록 하나, 가져오기/내보내기)과 전체 DB 백업/복원(DB저장/
  DB복원)으로 분리, Markdown을 가져오기/내보내기 형식에 추가, DB 백업/복원 기본 형식을 JSON으로.
- Naver Clova Speech를 STT 프로바이더로 추가(enko 대응 ko-KR 언어 설정, Invoke URL/Secret Key 설정).
- 오디오 분석 중 실시간 진행률 표시 추가(로컬 Whisper CLI/WhisperX stdout에서 실제 진행률 파싱, 클라우드/
  mock 프로바이더는 추정치) - 하나의 블로킹 요청 대신 job/poll API로 전환.
- 세 로컬/클라우드 STT 경로 전부에 실제 화자 분리 연결: WhisperX 자체 `--diarize`, Naver Clova 네이티브
  화자 분리, 로컬 Whisper CLI 대본 + 직접 호출한 pyannote 파이프라인(whisperx의 병합 헬퍼 재사용) 병합.
- 브라우저의 수제 WAV 인코더가 float 샘플을 int16으로 반올림하지 않고 버림 처리해서 양자화 편향이 생기고
  (앱을 통해 업로드한 오디오에서만) 화자 분리 클러스터링이 깨지던 실제 버그 발견 및 수정(두 경로를
  단계별로 직접 비교해서 찾음).
- 로컬 Whisper CLI/WhisperX 자식 프로세스의 Windows cp949 콘솔 인코딩 크래시 수정
  (`PYTHONIOENCODING=utf-8`).
- 세션에서 확인한 내용을 memory-bank 지식 파일과 전역 `C:\Claude\memory-bank\`에 기록(Python 서브프로세스
  인코딩, JS const/파라미터 TDZ 충돌, Playwright `getByPlaceholder` 부분일치, Whisper 파일당 언어 고정,
  Vite config-import 재시작 범위, WAV int16 반올림), 다음 세션 계획 로드맵 기록.

## `a4d1972` — 2026-08-16 — Document local STT setup flow

- README에 로컬 STT(Whisper CLI/WhisperX) 설치·설정 절차 문서화(약 320줄 추가).

## `980ac9e` — 2026-08-16 — Initial MeetingNote app

- 최초 커밋. Electron + Vite + React + TypeScript 기반 회의록 앱 골격 생성: 회의록 CRUD 화면
  (`MeetingFormModal`/`MeetingDetailModal`/`CardView`/`ListView`), 가져오기/내보내기/검색/필터 모달,
  Vite dev 서버 미들웨어 기반 API(`vite.config.mts`), STT/LLM 클라이언트(`lib/api.ts`/`lib/llm.ts`),
  오디오 처리(`lib/audio.ts`), 디자인 시스템(`styles/app.css`), 샘플 데이터 생성/검증 도구
  (`tools/generate-*`) 등 전체 초기 구조 작성.
