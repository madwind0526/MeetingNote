# Rules

> 이 프로젝트의 규칙과 컨벤션. 모든 sub-agent가 반드시 따라야 함.

## G-01: 코드 주석은 영어만 사용 (MANDATORY)

**규칙:** 모든 코드 주석(`//`, `/* */`, `///`)은 영어로 작성. 한글 주석 금지.
**이유:** 소스 파일 내 한글은 인코딩 문제 및 빌드 오류를 유발할 수 있음.
**적용 시점:** 코드 작성 또는 수정 시 항상. UI 텍스트(사용자에게 보이는 문자열)는 한국어 유지.

## G-03: 버튼/라벨 등 UI 텍스트에 영어 단어 혼용 금지

**규칙:** "Load/분석"처럼 사용자에게 보이는 버튼/라벨 텍스트에 영어 단어를 한글과 섞어 쓰지 않는다. 순수
한국어(또는 널리 통용되는 고유명사·약어, 예: "PDF", "LLM")만 사용.
**이유:** G-02(UI는 한국어) 규칙과 충돌하며 일관성이 깨짐. 자연어 스펙 문구를 그대로 UI 라벨에 옮기면 이런
혼용이 생기기 쉽다.
**적용 시점:** 스펙/요구사항 문서에 영어가 섞인 표현이 있어도, 실제 UI 컴포넌트에 옮길 때는 자연스러운
한국어 라벨로 바꿔 쓴다 (예: "Load/분석" → "분석 시작").

## G-04: 대규모 신규 앱은 계약(contract) 우선 → 병렬 sub-agent 위임

**규칙:** PhoneBook 스타일의 신규 프로젝트를 만들 때는 (1) 타입 모델(`domain.ts`) → (2) API 계약
(`vite.config.mts`의 라우트+import 시그니처, `lib/api.ts`) → (3) 디자인 시스템(`app.css` 토큰+범용 클래스)
순서로 먼저 직접 작성해 "계약"을 고정한 뒤, 그 계약을 프롬프트에 포함해 서버 모듈/UI 컴포넌트를 여러
sub-agent에 병렬 위임한다.
**이유:** 계약이 먼저 고정되어 있으면 병렬로 작업해도 인터페이스가 어긋나지 않는다. 실제로 이 순서로 4+4개
sub-agent를 병렬 실행했고 `tsc -b`가 통합 후 0 에러로 통과했다.
**적용 시점:** 새 Electron+Vite+React+TS 프로젝트를 기존 프로젝트(PhoneBook 등) 스타일로 만들 때.

## G-05: 프로젝트 루트에 start.bat / stop.bat 필수 (`C:\Claude\Club` 패턴)

**규칙:** 프로젝트 루트에 `start.bat`(포트 5185에 남아있는 이전 프로세스 정리 후 `npm start`)와
`stop.bat`(포트 5185 프로세스 + `WINDOWTITLE eq MeetingNote*` 필터로 `electron.exe`만 종료)을 항상
유지한다. 이 규칙은 글로벌 CLAUDE.md의 New Project Protocol에도 등록되어 있어 모든 신규 프로젝트에 적용된다.
**이유:** `npm start`가 띄우는 Vite dev 서버/Electron 자식 프로세스는 부모를 죽여도 SIGTERM을 못 받아 포트에
계속 남는다(`taskkill`로 부모만 죽이면 소용없음). 이 세션에서 `EADDRINUSE`로 여러 번 재시작이 막혔던 문제가
바로 이것이었다. `stop.bat`이 `WINDOWTITLE` 필터를 쓰는 이유는 `electron.exe`라는 이미지 이름이 모든
Electron 앱(PhoneBook, SNS-Reader 등)에서 공유되므로, 필터 없이 죽이면 무관한 다른 프로젝트의 창까지
닫히기 때문이다.
**적용 시점:** 새 Electron 프로젝트를 시작할 때 처음부터 만들어 둔다. 이미 있는 프로젝트에서 재시작이 자꾸
막히면 (`Port XXXX is already in use`) 가장 먼저 `stop.bat` 실행 여부부터 확인한다.

## G-06: `server/*.mjs`에 새 파라미터 추가 시 같은 스코프의 기존 지역 변수명과 충돌 확인 (MANDATORY)

**규칙:** `server/**/*.mjs`는 의도적으로 plain JS라 `tsc`가 검사하지 않는다. 함수에 새 파라미터를 추가할
때, 그 함수 본문에 이미 있는 지역 변수명(특히 `result`, `error`, `durationSec` 같은 흔한 이름)과 겹치지
않는지 직접 확인한다. 겹치면 TDZ 크래시(`Cannot access 'X' before initialization`)가 나는데, `node
--check`로도 안 잡히고 그 코드 경로를 실제로 실행해야만 드러난다.
**이유:** `sttLocalWhisperCli.mjs`/`sttLocalWhisperX.mjs` 둘 다 `expectedDurationSec` 이전에 `durationSec`
파라미터로 추가했다가 함수 뒷부분의 기존 `const durationSec = ...`와 충돌해 런타임 크래시가 났다(자세한
내용: `trouble-shooting.md`, 글로벌 `C:\Claude\memory-bank\js-const-param-name-collision-tdz.md`).
**적용 시점:** `server/*.mjs` 파일의 기존 함수에 파라미터를 추가/변경할 때마다.

## G-07: Python 자식 프로세스 spawn 시 `PYTHONIOENCODING=utf-8` 필수 (MANDATORY)

**규칙:** `cross-spawn`/`child_process.spawn`으로 Python 스크립트/CLI(Whisper, WhisperX, 임의의 Python
도구)를 실행할 때는 항상 `env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }`를 넘긴다.
**이유:** 한글 Windows(cp949 콘솔 코드페이지)에서 Python이 stdout에 cp949로 표현 안 되는 문자를 출력하면
`UnicodeEncodeError`로 죽는데, 스크립트가 이걸 내부에서 catch하고 종료 코드 0으로 끝나버려서 Node 쪽
`exitCode !== 0` 체크로는 못 잡는다("결과 파일이 없다"는 애매한 증상만 보임). 실제로
`sttLocalWhisperCli.mjs`에서 이 문제로 정상 음성 파일도 인식 실패했다.
**적용 시점:** 새 Python 자식 프로세스 호출 코드를 작성할 때마다.

<!-- 예시 형식:

## [규칙 이름]

**규칙:** [한 줄 요약]
**이유:** [왜 이 규칙이 필요한가]
**적용 시점:** [언제 이 규칙이 발동되나]

-->
