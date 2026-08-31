# Trouble Shooting

## localhost 브라우저에서는 Electron preload 전용 파일 탐색 기능이 사라진다

### 증상

Electron 앱(`npm start`)에서는 설정의 `탐색기 방식` 메뉴가 보이고, 새 회의록의 `회의 음성 파일`을 클릭하면 OS 기본 탐색기 또는 내장 파일 탐색기가 정상으로 열린다. 하지만 `http://127.0.0.1:5185` 브라우저 또는 Playwright 접속에서는 설정 메뉴가 숨겨지고, 내장 모드가 저장된 상태에서는 파일 선택 클릭이 아무 일도 안 하는 것처럼 보일 수 있다.

### 원인

`SettingsView`가 `isBuiltinFilePickerAvailable()`일 때만 탐색기 방식 섹션을 렌더링했고, 기존 `isBuiltinFilePickerAvailable()`은 `window.meetingNote?.listDirectory`만 확인했다. 이 값은 Electron preload IPC가 주입될 때만 존재하므로 브라우저 접속에서는 내장 탐색기가 항상 unavailable로 판단됐다. 또한 `pickFileWithNavigator()`도 `window.meetingNote.readFileBase64`에 의존해 브라우저에서 선택한 경로를 `File` 객체로 되돌릴 수 없었다.

### 해결

`src/lib/filePicker.ts`에 localhost 브라우저용 Vite middleware fallback을 추가했다. Electron에서는 기존 IPC를 우선 사용하고, 브라우저에서는 `/api/file-navigator/list`, `/api/file-navigator/read`, `/api/file-navigator/to-project-relative`, `/api/file-navigator/write`를 호출한다. `vite.config.mts`에는 같은 origin 검사 후 `fs.readdir`/`fs.stat`/`readFile`/`writeFile`을 수행하는 라우트를 추가했다. `SettingsView`는 탐색기 방식 섹션을 항상 렌더링하고, 브라우저에서도 내장 탐색기 버튼이 활성화된다.

### 검증

`npm run build` 통과. Playwright로 `http://127.0.0.1:5185`에 로그인 후 설정에서 `탐색기 방식` 섹션과 `내장 파일 탐색기` 버튼 노출 확인. 내장 모드 저장 후 새 회의록의 `회의 음성 파일` 클릭 시 내장 파일 탐색기 모달이 열리고 파일 선택 상태로 반영됨을 확인. 기본 모드로 되돌린 뒤 같은 영역 클릭 시 Playwright가 `File chooser` 이벤트를 감지함을 확인. 콘솔 에러는 기존 `favicon.ico` 404뿐.

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

## Windows 한글 로케일에서 Python 자식 프로세스가 UnicodeEncodeError로 죽는다 (cp949)

### 증상

`server/audio/sttLocalWhisperCli.mjs`가 `cross-spawn`으로 실행하는 로컬 Whisper CLI가 실제 존재하는
음성 파일에서도 종종 "로컬 Whisper 결과 파일을 읽지 못했습니다"만 던지며 실패했다. 원인 로그를 직접
받아보니(`node:child_process`의 stderr) 실제로는:
```
UnicodeEncodeError: 'cp949' codec can't encode character '跑' in position 81: illegal multibyte sequence
Skipping <file> due to UnicodeEncodeError
```
가 찍히고 있었다. Whisper CLI는 이 예외를 자기 내부에서 catch해서 "Skipping..."만 stdout에 찍고
**종료 코드 0으로 정상 종료**해버리므로, Node 쪽 `if (result.code !== 0)` 체크로는 절대 못 잡는다.

### 원인

openai-whisper는 verbose 모드에서 디코딩한 세그먼트 텍스트를 `print()`로 stdout에 찍는데, Python은
Windows에서 콘솔 코드페이지(한글 로케일이면 cp949)를 stdout 인코딩 기본값으로 쓴다. cp949로 표현 안
되는 문자(중국어 한자, 일부 특수기호, tqdm 진행바의 유니코드 블록 문자 등)가 출력에 섞이면 그 순간
`print()`가 죽는다. `child_process.spawn`으로 실행하면 콘솔이 아예 없는데도 Python은 여전히 OS
코드페이지를 기본값으로 잡는다.

### 해결

자식 프로세스 `env`에 `PYTHONIOENCODING=utf-8`, `PYTHONUTF8=1`을 추가하면 Python이 stdout/stderr를
항상 UTF-8로 쓴다.
```js
const child = spawn(command, args, {
  env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
});
```
`sttLocalWhisperCli.mjs`, `sttLocalWhisperX.mjs`(whisperx도 같은 위험이 있어 방어적으로 동일 적용) 둘 다
이렇게 고쳤다.

### 재사용 가능한 교훈

**한글 Windows에서 Node가 Python(또는 다른 비-UTF8-기본 런타임) 자식 프로세스를 spawn하는 프로젝트라면
전부 재현될 수 있다.** 증상이 "종료 코드는 0인데 결과 파일이 없다"처럼 애매하게 나타나는 게 특징이라
디버깅이 오래 걸린다 - 자식 프로세스의 stderr을 직접 캡처해서 진짜 예외 메시지를 보기 전까지는 원인을
알기 어렵다. 새 프로젝트에서 Python 자식 프로세스를 spawn한다면 처음부터 `PYTHONIOENCODING=utf-8`을
기본으로 넣어두는 게 안전하다.

## 순수 .mjs(타입체크 없음)에서 함수 파라미터명이 나중 `const` 선언과 겹치면 TDZ 크래시

### 증상

`transcribeLocalWhisperCli(audioBuffer, fileName, model, durationSec, onProgress)`처럼 파라미터를
추가했는데 실행하면 `Cannot access 'durationSec' before initialization`(TDZ 에러)이 났다. `tsc`는 이
파일들(`server/*.mjs`)을 검사하지 않으므로 컴파일 시점에 전혀 안 잡혔다.

### 원인

같은 함수 스코프 안에 `const durationSec = lastSegment ? lastSegment.endSec : 0;`가 나중에 이미
있었다(진짜 오디오 길이를 계산하는 기존 코드). JS는 `const`/파라미터가 이름이 겹치면 함수 전체
스코프에서 해당 식별자가 TDZ(temporal dead zone)에 들어가므로, 그 `const` 선언보다 앞쪽 코드에서
파라미터를 참조해도 "초기화 전 접근" 에러가 난다 - 파라미터가 단순히 가려지는(shadowing) 게 아니라
아예 접근 자체가 깨진다.

### 해결

파라미터 이름을 `expectedDurationSec`처럼 겹치지 않게 바꿨다. `sttLocalWhisperCli.mjs`,
`sttLocalWhisperX.mjs` 둘 다 같은 실수를 했다(같은 패턴을 복사해서 만들었기 때문).

### 재사용 가능한 교훈

TypeScript 파일에서는 이런 재선언을 컴파일러가 바로 잡아주지만, **이 프로젝트처럼 서버 쪽을 의도적으로
plain `.mjs`로 유지하는 코드베이스에서는 안 잡힌다.** 함수에 새 파라미터를 추가할 때, 특히 기존 함수
본문에 이미 있는 지역 변수명(`durationSec`, `result`, `error` 같은 흔한 이름)과 겹치지 않는지 직접
확인해야 한다. `node --check file.mjs`로 문법 오류는 잡히지만 이런 런타임 TDZ 오류는 실제로 그 코드
경로를 실행해봐야만 드러난다.

## Playwright `getByPlaceholder()`는 기본이 부분일치라 비슷한 placeholder를 가진 다른 필드까지 잡는다

### 증상

폼에 참석자 2명을 추가하고 `getByPlaceholder('이름').nth(0)`/`.nth(1)`로 이름을 채웠는데, 실제
전송된 데이터를 까보면 이름 하나가 엉뚱하게 "주관자" 필드에 들어가 있었다. 참석자 테이블 자체를
스크린샷/스냅샷으로 확인해도 겉보기엔 멀쩡해 보여서 한참 헤맸다.

### 원인

Playwright의 `getByPlaceholder(text)`는 기본적으로 **부분 문자열 일치**다. 참석자 이름 입력의
placeholder는 `"이름"`이고 주관자 입력의 placeholder는 `"주관자 이름"`인데, 후자가 `"이름"`을
포함하므로 `getByPlaceholder('이름')`이 둘 다 매칭시켜 같은 컬렉션에 섞여 들어간다. `nth(0)`이
실제로는 주관자 필드를 가리키고, 의도한 참석자 행들은 인덱스가 하나씩 밀린다.

### 해결

```js
page.getByPlaceholder('이름', { exact: true })
```
정확히 일치하는 것만 잡도록 `exact: true`를 명시한다.

### 재사용 가능한 교훈

한 폼 안에 "X"와 "OO X" 같은 접두사/접미사 관계의 placeholder가 여러 개 있으면 항상 이 함정에 걸릴 수
있다. Playwright로 폼을 채우는 자동화/테스트 스크립트를 짤 때는 `getByPlaceholder`보다 더 좁은 범위
(예: 특정 `<tr>`/`<table>` 안으로 `.locator()`를 먼저 좁힌 뒤 그 안에서 `input[placeholder="이름"]`
CSS 셀렉터로 정확히 매칭)를 쓰는 게 안전하다. 값을 채운 뒤 반드시 `.inputValue()`로 실제 들어간 값을
재확인하는 습관도 이런 off-by-one을 조기에 잡아준다.

## Whisper/WhisperX는 파일당 언어를 한 번만 정하므로 문단 단위 언어 전환(코드스위칭)에 취약하다

### 증상

한국어+영어가 섞인 회의 음성(발화자별로 완전히 다른 언어로 말하는 극단적 케이스)을
`--language ko`로 강제 인식시키면, 영어로 말한 구간이 인식 결과에서 통째로 빠지거나 심하게 깨졌다.
`--language`를 아예 빼서 자동 감지로 돌려도 마찬가지였다 - 로그를 보면
`Detected language: ko (0.62) in first 30s of audio`처럼 **파일 처음 30초의 우세 언어로 한 번만
정하고 그걸로 파일 전체를 밀어붙인다.**

### 원인

Whisper 계열 모델은 언어 감지를 파일 단위(보통 첫 30초 청크)로 한 번만 수행하고 그 언어로 디코딩
경로를 고정한다. 문장 안에 섞인 외국어 단어 정도(코드스위칭 경미한 경우)는 다국어 모델이 어느 정도
버티지만, **화자가 통째로 다른 언어로 전환하는 문단 단위 전환**은 이 구조로는 근본적으로 대응이
안 된다.

### 해결(회피책)

- **Naver Clova Speech**에는 정확히 이 상황을 위한 `language: "enko"`(한국어+영어 혼용 전용) 모드가
  공식으로 있다. `ko-KR`/`en-US`/`enko`/`ja`/`zh-cn`/`zh-tw` 중 선택 가능(`sttNaverClova.mjs`는 현재
  `ko-KR` 고정 - 혼용 회의가 잦다면 `enko`로 바꾸는 게 가장 간단한 해결책).
- Whisper 계열로 로컬/무료를 고집한다면, 오디오를 구간(VAD 또는 화자 전환 지점)별로 쪼갠 뒤 구간마다
  언어를 다시 감지/지정해서 따로 디코딩해야 한다 - CLI 플래그로는 안 되고 직접 파이프라인을 짜야 하는
  큰 작업이다.

### 재사용 가능한 교훈

"다국어 지원"을 Whisper 계열 STT로 구현할 때, **문장 내 외국어 단어 섞임**과 **화자/문단 단위 언어
전환**을 같은 문제로 취급하면 안 된다. 전자는 다국어 모델이 웬만하면 처리하지만, 후자는 파일당 1회
언어 감지라는 구조적 한계에 바로 부딪힌다. 이 구분을 미리 하지 않으면 "언어를 자동 감지로 바꾸면
되겠지"라고 오판하기 쉽다(실제로 해봤지만 안 됐다).

## 브라우저에서 Float32 PCM을 16-bit WAV로 손수 인코딩할 때 `Math.round` 빠뜨리면 화자 분리가 깨진다

### 증상

로컬 Whisper CLI/WhisperX로 화자 분리(diarization)를 테스트했는데, 서버에 curl로 원본 오디오 파일을
직접 보내면 항상 정확히 2명으로 분리되는데, **똑같은 파일을 앱 화면에서 업로드**하면 항상 1명으로만
나왔다. 처음엔 "브라우저가 48kHz로 리샘플했다가 서버가 다시 16kHz로 낮추는 이중 리샘플 때문에 음질이
깨진다"고 의심하고 `AudioContext`에 `sampleRate: 16000`을 명시해 이중 리샘플을 없앴는데도 여전히
1명으로만 나왔다. 원본 파일과 브라우저가 재인코딩한 파일의 PCM 샘플을 직접 diff해보니 전체 샘플의
~60%가 **±1**(16비트 정수 기준 최소 단위, 사람 귀로는 절대 구별 안 되는 크기) 차이밖에 없었는데도
diarization 클러스터링 결과가 뒤집혔다. "그 정도로 작은 차이면 모델이 예민한 거지 우리 잘못이 아니다"로
결론 내리려던 걸, 사용자가 "같은 성공 경로를 다시 mimic하도록 만들라"고 되돌려보낸 덕분에 계속 팠다.

### 원인

`src/lib/audio.ts`의 `encodeWav()`가 Float32 샘플을 16-bit PCM으로 변환할 때:
```js
const intSample = Math.max(-1, Math.min(1, mono[index])) * 32767;
view.setInt16(offset, intSample, true);
```
`intSample`을 반올림하지 않고 그대로 `DataView.setInt16`에 넘긴다. ECMAScript의 `ToIntegerOrInfinity`는
정수가 아닌 값을 **0쪽으로 버림**하지 반올림하지 않는다. 매 샘플마다 일정한 방향으로 치우친 양자화
오차(~0.5 LSB)가 생기는데, ffmpeg 등 정상적인 인코더는 반올림(또는 디더링)을 하므로 원본 파일과 미세하게
달라진다. 그 미세한 차이가 (원인은 알 수 없지만) 이 프로젝트에서 쓰는 pyannote 화자 분리 클러스터링
결과를 뒤집기에 충분했다.

### 해결

```js
const intSample = Math.round(Math.max(-1, Math.min(1, mono[index])) * 32767);
```
`Math.round()` 한 줄 추가로 해결됨. 수정 후 브라우저 업로드 경로로도 원본 파일과 동일하게 2명으로 정확히
분리되는 것을 반복 확인(연속 2회 동일 결과).

### 재사용 가능한 교훈

- 브라우저에서 `Float32Array` PCM 샘플을 손수 16-bit WAV로 인코딩하는 코드를 짤 때는 항상 `Math.round`를
  거쳐야 한다 - `DataView.setInt16`/`setInt8`/`setInt32` 등은 절대 알아서 반올림해주지 않는다.
- "차이가 이렇게 작은데 결과가 이렇게 크게 갈릴 리 없다"는 직관은 ML 모델의 클러스터링/분류 경계에서는
  틀릴 수 있다. 겉보기에 무해해 보이는 수치 차이라도, 같은 입력을 재현 가능하게 반복 실행해서 "정말
  재현되는 차이인지" 먼저 확인하고, 안 되면 "모델이 원래 그렇다"로 결론 내리기 전에 실제 바이트 레벨까지
  파고들어야 한다.

## B3 화자 음성 프로필: 초기 코사인 유사도 임계값(0.75)이 실제 다른 화자 쌍보다 낮아서 오매칭됨

### 증상

`pyannote`의 `DiarizationPipeline(..., return_embeddings=True)`로 얻은 화자 임베딩으로
`matchSpeakerProfile()`을 구현하고 `SIMILARITY_THRESHOLD = 0.75`로 설정했는데, 실제 HF 토큰+GPU로
`data/test-audio/diarize-2speaker-ko-en.wav`(서로 다른 두 화자)를 재현했더니 한 화자만 프로필을
등록했는데도 **두 화자 모두** 그 프로필로 매칭됐다.

### 원인

"임계값이 너무 낮다"고 바로 단정하지 않고, 두 화자의 실제 임베딩 벡터를 직접 저장해서 코사인 유사도를
스크립트로 계산해봤다. 결과: 같은 오디오를 반복 실행했을 때 동일 화자끼리는 ~1.0(당연히 결정론적),
그런데 **이 녹음 안의 서로 다른 두 화자끼리도 0.757**이 나왔다 - 초기 임계값 0.75보다 근소하게 높아서
둘 다 매칭 조건을 통과해버렸다. 매칭 로직 자체(코사인 유사도 계산, 우선순위 정렬)는 정확했고, 문제는
순전히 임계값이 이 임베딩 모델·이 화자 쌍의 실제 분포보다 낮게 잡혀 있었던 것.

### 해결

`server/voiceProfiles.mjs`의 `SIMILARITY_THRESHOLD`를 0.85로 올림. 재현 테스트: 등록된 화자는 다시
정확히 매칭되고, 등록 안 된 다른 화자는 "미등록"으로 남는 것을 확인.

### 재사용 가능한 교훈

- 유사도/거리 기반 매칭에서 "임계값이 이상한 것 같다"는 의심이 들면, 실제 데이터로 both-sides(같은 대상
  vs 다른 대상)의 실측 유사도 분포를 직접 찍어보고 임계값을 잡아야 한다 - 감으로 잡은 값(이번엔 근거
  없이 0.75)은 실제 분포와 어긋날 수 있다.
- 이 프로젝트에서 또 한 번 확인된 패턴(WAV 반올림 버그 항목 참고): "모델/알고리즘이 이상하게 동작하는
  것 같다" 싶을 때 코드 로직을 의심하기 전에, 먼저 실제 중간값(여기선 임베딩 벡터, 그때는 PCM 샘플)을
  직접 찍어서 정말 무엇이 일어나고 있는지 확인하는 게 항상 더 빠르고 정확했다.
- 이 임계값(0.85)은 **합성 음성 1쌍**으로만 검증됐다 - 실제 사람 목소리로 재조정이 필요할 수 있다.

## Vite dev 서버는 `vite.config.mts`가 import하는 모든 파일 변경에도 전체 재시작한다

### 증상

`server/audio/*.mjs`처럼 `vite.config.mts`가 최상단에서 `import`하는 서버 모듈 파일을 수정했더니,
`.env`를 고쳤을 때와 똑같이 `[vite] .env changed, restarting server...`류의 전체 서버 재시작이
일어나고 브라우저가 잠깐 "회의록 0/0, 표시할 회의록이 없습니다"를 보여줬다가 정상으로 돌아왔다.

### 원인

Vite의 config 파일 watcher는 `vite.config.mts` 자체뿐 아니라 그 파일이 정적으로 import하는 의존성
그래프 전체를 감시한다. 이 프로젝트는 `vite.config.mts`에서 `server/**/*.mjs`를 대량으로 import해서
API 라우트 핸들러 안에서 쓰므로, 그 중 아무 파일이나 고쳐도 "config가 바뀌었다"고 판단해 서버 전체를
재시작한다.

### 재사용 가능한 교훈

이건 버그가 아니라 예상된 동작이다. 서버 쪽 `.mjs` 파일을 고친 직후 페이지가 잠깐 빈 목록을 보여주거나
API 요청이 한 번 실패해도 당황할 필요 없다 - 몇 초 뒤 재시작이 끝나면 정상화된다. 다만 재시작 타이밍과
겹쳐서 그 순간에 날아간 API 요청/브라우저 자동화 스크립트는 실패할 수 있으니, 파일을 수정한 직후에는
`netstat`으로 포트가 다시 LISTENING 상태가 됐는지 확인한 뒤에 다음 요청을 보내는 게 안전하다.

## 사전(약어/수정) 치환이 단어 안의 부분 문자열까지 건드린다 - 세 단계로 고쳐야 끝남

### 증상

약어 사전에 `CD` → `(Register) Clock Driver`가 있으면, 본문에 있는 `CDN`(전혀 다른 용어)이
`Clock DriverN`으로 깨졌다. 사용자가 실제 회의록 출력에서 발견해서 보고함.

### 원인 (1단계: 단순 substring)

`server/dictionary.mjs`의 `applyEntriesToText`가 `text.split(entry.from).join(entry.to)`로
치환했다 - 단어 경계 검사가 전혀 없어서 `from`이 다른 단어의 부분 문자열이기만 해도 치환됐다.

### 원인 (2단계: 첫 수정이 과교정)

`\b` 대신 `\p{L}`/`\p{N}` 기반 경계로 1차 수정하니 `CDN`은 안전해졌지만, 한글 조사가 이유 없이
막히는 부작용이 생겼다 - `AI를`/`CPU가`처럼 영문 약어 뒤에 한글 조사가 공백 없이 바로 붙는 건
정상적인 한국어 표기인데, `\p{L}`은 한글도 "글자"로 취급해서 이런 정상 매치까지 막아버렸다.

### 원인 (3단계: 스크립트 인식 경계도 순차 적용 때문에 다시 깨짐)

경계를 "같은 스크립트(라틴+라틴, 한글+한글)일 때만 차단"으로 바꿔서 2단계 문제도 해결했는데, 이번엔
엔트리를 하나씩 순서대로 텍스트에 적용하는 방식 자체가 문제였다. 사전에 `에이아이` → `AI (Artificial
Intelligence)`와 `AI` → `Artificial Intelligence`가 동시에 있으면, 긴 엔트리(`에이아이`)가 먼저
치환되면서 만들어낸 결과물 안의 `AI`를 짧은 엔트리(`AI`)가 또 매치해버려서
`Artificial Intelligence (Artificial Intelligence)`로 이중 치환됐다.

### 해결

세 가지를 모두 갖춰야 한다.

1. **스크립트 인식 경계**: 매치 앞/뒤 글자가 `from`의 첫/끝 글자와 "같은 스크립트"(라틴 vs 한글, 둘 다
   `[A-Za-z0-9]`/`\p{Script=Hangul}` 기준)일 때만 차단. 다른 스크립트끼리는 항상 안전한 경계로 취급.
2. **한글 조사 허용 목록**: 한글 엔트리 뒤에 한글이 바로 붙어도, 그 이어지는 문자열이 흔한 한국어
   조사(은/는/이/가/을/를/에서/으로/...)로 시작하면 차단하지 않는다 - "완전히 같은 스크립트가
   이어진다"만으로는 "다른 단어의 일부"와 "조사가 붙은 것"을 구분 못 한다.
3. **모든 엔트리를 원본 텍스트 기준으로만 매치**: 엔트리를 하나씩 누적 결과에 순차 적용하지 말고,
   전체 엔트리의 매치 위치를 원본 텍스트에서 한 번에 수집(긴 `from`부터, 이미 다른 엔트리가 차지한
   범위는 건너뜀)한 뒤 한 번의 패스로 치환한다 - 그래야 한 엔트리의 치환 결과가 다른 엔트리의 새 입력이
   되는 연쇄를 원천 차단한다.

구현: `server/dictionary.mjs`의 `scriptCategory`/`startsWithKoreanParticle`/`isWholeMatch`/
`applyEntriesToText` (매치 수집 + 겹침 방지 + 단일 패스 재조립).

### 재사용 가능한 교훈

텍스트 치환에서 "단어 경계"를 다룰 때 `\b`(ASCII 전용)도, `\p{L}`(다국어지만 스크립트 무관)도 혼용
스크립트 텍스트(영문 약어 + 한글 조사)에는 둘 다 부족하다. 그리고 여러 규칙을 텍스트에 **순차** 적용하는
설계는, 규칙 개수가 늘어날수록 "치환 결과가 다른 규칙의 입력이 되는" 연쇄 버그를 구조적으로 만들어낸다 -
원본 기준 매치 수집 + 단일 패스 재조립이 근본적으로 더 안전하다.

## B5 발표 구간 windowing: "가장 가까운 pause"가 아니라 "검색 반경 안의 가장 넓은 gap"을 고르고 있었다

### 증상

발표 내용 자동 정리(B5)가 가끔 발표 시작 부분의 발언을 놓쳤다. 특히 Agenda 1번(추정 시작 시각이 항상
정확히 0초)에서 두드러졌다.

### 원인

`server/llm.mjs`의 `snapToNearestPause`는 이름과 달리 "가장 가까운 pause"가 아니라 "검색 반경
(`WINDOW_SEARCH_RADIUS_SEC`, 3분) 안에서 가장 긴 gap"을 선택했다. `estimatedStart = 0`이어도 반경
안 어딘가(예: 2~3분 지점)에 유난히 긴 침묵이 있으면 그쪽으로 스냅되어, 진짜 발표 시작 부분이 window
밖으로 밀려났다.

### 해결

선택 기준을 "target까지의 거리가 가장 가까운 gap(동률이면 더 넓은 gap)"으로 변경. 추가로 Agenda 1번처럼
`estimatedStart`가 이미 0에 아주 가까울 때(`<= WINDOW_EDGE_PADDING_SEC`)는 pause 탐색 자체를 건너뛰고
0초부터 시작 - 0 이전에는 보호할 게 없으니 탐색이 오히려 손해만 될 수 있다.

### 재사용 가능한 교훈

함수 이름이 의도를 말해줘도 실제 선택 기준(가장 가깝다 vs 가장 크다/길다)은 반드시 코드를 직접
확인해야 한다 - 이번 버그는 실제로 사용자가 코드 리뷰에서 직접 짚어줘서 발견됐다.

## 가져오기(import) 라벨 매칭이 글자 사이 공백과 신규 필드(장소/간사)를 놓치고 있었다

### 증상

TXT 가져오기 기능을 추가하면서 사용자가 "장 소", "주 관", "간 사", "제 목"처럼 글자 사이에 공백이 들어간
실제 문서 라벨도 처리되는지 물어봄. 확인해보니 처리되지 않았고, 조사 과정에서 더 근본적인 문제 두 가지를
추가로 발견함.

### 원인

`server/parsers/import{Md,Pdf,Docx,Pptx}.mjs` 네 파일 모두 `LABEL_LINE_RE`로 콜론 앞 라벨을 추출한 뒤
`label === "제목"`처럼 완전 일치로만 비교했다 - 공백이 하나라도 섞이면 매칭 실패. 게다가 `location`(장소)·
`secretary`(간사) 필드가 최근 커밋(`meeting location field`)에서 `domain.ts`에 추가된 뒤, PDF/Word/PPT/MD
어느 가져오기·내보내기 파서도, `server/parsers/importJson.mjs`(JSON 가져오기)도, `MeetingFormModal.tsx`의
"파일에서 가져오기" 필드 복사 로직도 이 두 필드를 다루지 않고 있었다 - 내보냈다가 다시 가져오면 장소/간사가
항상 사라졌다. 추가로 `exportDocx.mjs`/`exportPptx.mjs`는 시작/종료 시각을 "시간: 09:00 ~ 10:00" 한 줄로
합쳐서 썼는데, import 쪽 라벨 매칭은 "시작:"/"종료:"(또는 "일시: 날짜 HH:MM-HH:MM")만 인식해서 이 형식은
애초에 파싱된 적이 없었다. `importPptx.mjs`는 한 슬라이드 안의 모든 `<a:t>` 텍스트 런을 공백으로만 이어
붙여서(`runs.join(" ")`) 여러 줄로 쌓아 올린 제목 슬라이드(날짜/시작/장소/참석자 등)가 통째로 한 줄로
뭉개져 애초에 라벨별 매칭이 불가능했다.

### 해결

1. 4개 import 파서에 `normalizeLabel()`(공백·전각공백 제거 후 비교) 추가, 제목 감지 정규식도 동일하게
   `LABEL_LINE_RE` 매치 후 정규화 비교로 교체.
2. "장소"/"간사" 라벨 인식 추가, "주관자"/"주관", "참석자"/"참석" 같은 2글자 축약형도 별칭으로 인식.
3. 4개 import 파서의 `emptyDraft()`에 `location`/`secretary` 기본값 추가, `importJson.mjs`의
   `toMeetingDraft()`에도 두 필드 통과 로직 추가.
4. 4개 export 빌더(`exportMd`/`exportPdf`/`exportDocx`/`exportPptx`)에 "장소:"/"간사:" 라인 추가하고,
   `exportDocx`/`exportPptx`의 "시간: 시작 ~ 종료" 합본 줄을 "시작:"/"종료:" 별도 줄로 분리(그동안 깨져있던
   DOCX/PPTX 시각 라운드트립도 같이 고쳐짐).
5. `importPptx.mjs`의 `slideXmlToText()`를 `<a:p>` 문단 경계로 텍스트를 모은 뒤 `\n`으로 합치도록 변경(기존
   공백 조인 방식 폐기) - 제목 슬라이드의 라벨별 줄 구분이 살아남게 됨.
6. `MeetingFormModal.tsx`의 "파일에서 가져오기" 필드 복사 목록에 `location`/`secretary` 추가.

### 검증

`npx tsc -b` 통과, 4개 `.mjs` 전부 `node --check` 통과. `imports/회의록 불러오기.txt`(글자 사이 공백 라벨+
장소/간사 포함 샘플)를 실제로 `parseMdMeeting()`에 통과시켜 title/date/startTime/endTime/location/
organizer/secretary/attendees/agenda/actionItems/minutes 전부가 의도대로 채워지는 것을 직접 확인.

### 재사용 가능한 교훈

- 도메인 모델(`domain.ts`)에 필드를 추가할 때, 그 필드를 다루는 경로가 여럿(가져오기 4종 + 내보내기 4종 +
  폼 채우기)인 기능이라면 하나라도 빠뜨리기 쉽다 - 새 필드를 추가하면 "이 필드가 왕복하는 모든 경로"를
  체크리스트로 나열하고 하나씩 확인하는 게 안전하다.
- 라벨 기반 텍스트 파싱(`라벨: 값`)에서 "완전 일치" 비교는 사람이 손으로 정렬용 공백을 넣은 실제 문서에서
  거의 항상 깨진다 - 비교 직전에 공백을 제거하는 정규화 한 단계를 기본으로 넣는 게 싸고 효과적이다.
- PPTX처럼 텍스트가 여러 XML 런/문단으로 쪼개지는 포맷에서 "모든 런을 공백으로 이어붙이기"는 매력적인
  단순화지만 원본의 줄 구조(문단 경계)를 파괴한다 - 문단 단위로 모은 뒤 문단 사이만 개행으로 잇는 방식이
  라벨별 줄 파싱을 살린다.

## "화자 분리" 재오픈 시 저장된 화자 이름이 사라지고, 세그먼트별 자유 입력이 동명이인을 만들어냄

### 증상

`AudioAnalysisModal`에 "기존 대본 자동 로딩"(새로 만든 `existingAnalysis` prop)과 "세그먼트별 화자 자유
입력"을 새로 추가한 뒤 실사용 테스트(Playwright로 실제 회의록 열어서 재현)에서 사용자가 보고한 대로 두 가지가
깨져 있었다. (1) 발표 대본을 "한지민"/"조은우"로 수정하고 완료 → 폼 미리보기에는 정상 반영되는데,
"화자 분리"로 다시 열면 저장했던 이름 대신 `SPEAKER_01`/`SPEAKER_00` 같은 원시 라벨이 다시 나타났다.
(2) 왼쪽 대본에서 세그먼트 하나를 "한지민"으로 직접 타이핑하고, 오른쪽 "화자별 파형"에서도 같은 화자를
"한지민"으로 바꾸면 "한지민"이 두 명(서로 다른 라벨) 생겼다.

### 원인

(1) `useChunkedAudioAnalysis.ts`의 `loadExternalTranscript(segments, fileName)`는 원래 "발언 대본
불러오기"(임의의 텍스트 파일 파싱, 실명 매핑이 없음) 전용으로 설계되어 `speakerMap`을 항상 항등 매핑
(`speakerMap[label] = label`)으로 채운다. 새로 추가한 "기존 분석 결과 자동 로딩" 훅도 같은 함수를
재사용했는데, 이 경우 `existingAnalysis.speakerMap`에 진짜 저장된 표시 이름이 있는데도 무시되고
항등 매핑이 이겼다 - `editedSpeakerMap`을 채우는 "additive" effect는 `result.speakerMap`에서 값을
가져오므로, 항등 매핑이 그대로 화면에 노출됐다.

(2) 세그먼트별 자유 입력(`commitSegmentSpeakerName`)이 타이핑된 이름을 기존 라벨 어디에도 없으면
"디스커넥트된 새 라벨"(라벨 이름 = 타이핑한 이름 그 자체)을 새로 만들도록 되어 있었다. 사용자가 왼쪽에서
먼저 세그먼트를 "한지민"으로 바꾼 시점엔 오른쪽 화자별 파형 쪽 이름이 아직 "미등록 화자 1"이라 매칭에
실패해서 새 라벨을 만들었고, 그 다음 오른쪽에서 "미등록 화자 1"을 "한지민"으로 rename하면서 완전히
별개인 두 번째 "한지민" 항목이 생겼다.

### 해결

(1) 새 useEffect에서 `loadExternalTranscript` 호출 직후 `setEditedSpeakerMap(existingAnalysis.speakerMap)`을
명시적으로 한 번 더 호출해서 저장된 실명 매핑으로 덮어쓴다("additive" effect는 이미 존재하는 키는 안
건드리므로 이 순서가 항상 이긴다).

(2) 세그먼트별 자유 입력에서 "새 라벨 만들기" 분기를 완전히 제거했다. 타이핑한 이름이 **다른** 라벨의
현재 표시 이름과 일치하면 그 라벨로 세그먼트만 옮기고(기존 동작), 일치하지 않으면 **그 세그먼트가 속한
현재 라벨 자체의 이름을 바꾼다**(화자별 파형 입력과 동일한 효과) - 이러면 같은 사람이 어느 입력으로
먼저 이름 붙여지든 항상 하나의 라벨로 수렴한다. `useChunkedAudioAnalysis.ts`의 `updateSegmentSpeaker`도
한때 3번째 `displayName` 인자로 새 라벨을 등록하도록 확장했었는데, 이 설계 변경으로 더 이상 쓰이지 않아
원래 2-인자 형태로 되돌렸다(안 쓰이는 능력을 남겨두지 않기 위해).

### 검증

Playwright로 실제 앱(`http://127.0.0.1:5185`)에 로그인해 "결제 모듈 개발 현황 점검" 회의록을 열고,
분석 시작 → 화자별 파형에서 "한지민"/"조은우"로 rename → 완료 → 폼 미리보기 확인 → "화자 분리" 재오픈 →
저장된 이름이 정확히 다시 뜨는 것 확인(수정 전엔 원시 라벨이 떴음). 세그먼트 자유 입력 + 화자별 파형
rename 조합도 재현해 동명이인이 더 이상 생기지 않는 것 확인.

부수적으로 발견한 것(이번 세션이 만든 버그 아님, 기존 알려진 한계): 음성 프로필 등록 자체는 정상
작동(실제 임베딩과 함께 `data/db/voiceProfiles.json`에 기록됨, blur 시점에 등록되는 것 확인)하지만, 이
프로젝트가 쓰는 합성 음성 테스트 파일(`imports/diarize-2speaker-ko-en.wav`, TTS 생성)은 두 화자가
음향적으로 너무 비슷해서 재매칭 시 서로 다른 두 화자가 같은 프로필로 잘못 매칭되는 경우가 실제로
재현됐다 - `SIMILARITY_THRESHOLD`가 "합성 음성 1쌍으로만 검증됨"이라고 이미 이 문서 상단(B3 화자 음성
프로필 항목)에 적혀 있던 한계가 그대로 재현된 것. 실제 사람 목소리로 테스트하면 다를 수 있다.

### 재사용 가능한 교훈

- 기존 함수를 "이 정도면 비슷하니 재사용해도 되겠지"로 새 용도에 그대로 갖다 쓸 때는, 그 함수가 내부에서
  세우는 가정(여기선 "호출자에게 실명 매핑이 없다")이 새 호출자에도 여전히 성립하는지 반드시 확인해야
  한다 - 성립하지 않으면 조용히 잘못된 기본값으로 덮어써서, 겉으로는 "그럴듯하게 작동하는" 상태로
  버그가 숨는다.
- "이름이 겹치면 합치고 안 겹치면 새로 만든다"는 규칙을 여러 입력 지점(세그먼트별/전체 라벨별)에 각각
  독립적으로 적용하면, 입력 순서에 따라 결과가 달라지는 레이스 유사 버그가 생긴다 - "안 겹치면 새로
  만든다" 대신 "안 겹치면 지금 내가 속한 대상의 이름을 바꾼다"로 바꾸면 입력 순서와 무관하게 항상 하나로
  수렴한다.
- 실제 브라우저로 재현(Playwright)해서 `voiceProfiles.json`/attachments 폴더를 직접 파일로 확인하는 것이,
  코드만 읽고 "이래야 맞다"고 추론하는 것보다 훨씬 빠르고 확실하게 근본 원인을 찾아줬다 - 특히 세션
  상태(embedding 유무)처럼 코드 읽기만으로는 놓치기 쉬운 타이밍 의존적 버그일수록 그렇다.

<!-- 예시 형식:

## [문제 제목]

### 증상

[어떤 에러 또는 현상이 나타났나]

### 원인

[왜 발생했나]

### 해결

[어떻게 고쳤나 — 코드/명령어 포함]

-->
