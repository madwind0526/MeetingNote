# Trouble Shooting

> 발생했던 버그와 해결 방법. 같은 문제를 두 번 겪지 않기 위한 기록.

## 여러 sub-agent가 domain.ts를 미리 안 읽으면 shape 불일치가 생길 수 있다 (예방됨, 실제 발생 없음)

### 증상

없음 - 예방적 기록. `ActionItem`/`AgendaItem`에 고유 `id`가 없어 편집 테이블의 React key로 배열 `index`를
쓰는데, 만약 정렬/필터링 로직이 이 배열 순서를 바꾸면 key 충돌이나 잘못된 row 매칭이 생길 수 있다.

### 원인

`domain.ts`의 `ActionItem`/`AgendaItem`은 의도적으로 `id` 필드가 없다(폼 안에서만 배열 순서로 관리, 저장 시
`no` 필드로 1부터 재번호).

### 해결(예방)

편집 테이블 컴포넌트에서는 항상 배열 원본 순서를 유지하고, `no`는 add/remove 시마다
`renumber<T extends {no:number}>()` 헬퍼로만 갱신한다. 정렬 UI를 이 배열에 추가하려면 먼저 `id` 필드를
domain.ts에 추가해야 한다.

## Node 미설치 상태에서 sub-agent가 작성한 서버 모듈은 반드시 실제 npm install + 런타임 스모크테스트로 검증할 것

### 증상

여러 sub-agent가 "npm install이 안 되어 있어 실제 동작을 검증 못했다"고 보고하는 항목이 다수 쌓임
(pptxgenjs Buffer 출력, lucide-react 아이콘 존재 여부, local-whisper-cli/OpenAI Whisper API 응답 형태 등).

### 원인

병렬 sub-agent들은 의도적으로 `npm install`/build를 생략하도록 지시받았다(서로 다른 파일을 동시에 쓰는 중이라
어차피 빌드가 안 되는 상태였으므로).

### 해결

모든 sub-agent 작업이 끝난 뒤 오케스트레이터가 직접 `npm install && npx tsc -b && npx vite build`를 실행하고,
`npm run dev`를 백그라운드로 띄운 뒤 `curl`로 핵심 API 라우트(CRUD, import/export 각 포맷, STT mock,
llm/status, stt/status)를 스모크테스트한다. 이 프로젝트에서는 그 결과:
- `tsc -b`, `vite build` 모두 0 에러로 통과.
- PDF(54KB, `%PDF-` 매직바이트)/DOCX(10.6KB, `PK\x03\x04`)/PPTX(261KB, `PK\x03\x04`)/JSON 내보내기 전부
  실제 유효한 바이너리 생성 확인. **pptxgenjs `outputType:"nodebuffer"` 가정이 맞았음.**
- PDF export → import 라운드트립(제목/날짜/시간/주관자/참석자 정상 복원) 확인.
- STT mock 프로바이더(`/api/stt/transcribe`)가 화자 분리까지 포함해 정상 동작(9개 세그먼트, 라벨→실명 매핑
  정상).
- `checkClaudeCliAvailable()`이 실제 로컬 Claude CLI를 감지함(`claude --version` 성공).
- **여전히 미검증**: 로컬 `openai-whisper` CLI 실제 설치 환경에서의 JSON 출력 형태, OpenAI Whisper API의
  실제 응답 형태(API 키 없어 호출 불가) - 두 항목은 실사용 시 1회 확인 필요.

### 재사용 가능한 교훈

병렬 sub-agent로 대규모 신규 앱을 만들 때, "빌드/설치 생략" 지시는 각 sub-agent 단계에서는 옳지만, 반드시
전체 Wave가 끝난 직후 오케스트레이터가 실제 설치+빌드+런타임 스모크테스트를 수행하는 별도 검증 단계를
넣어야 한다. 그렇지 않으면 여러 "가정"이 쌓인 채로 방치될 위험이 크다.

<!-- 예시 형식:

## [문제 제목]

### 증상

[어떤 에러 또는 현상이 나타났나]

### 원인

[왜 발생했나]

### 해결

[어떻게 고쳤나 — 코드/명령어 포함]

-->
