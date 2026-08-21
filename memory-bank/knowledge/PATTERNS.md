# Patterns

> 검증된 코드 패턴. 복붙 바로 가능한 형태로 유지.

## PhoneBook 이식 파일 (거의 그대로 포트, 도메인 로직만 교체)

`server/envFile.mjs`(100% 동일, 제네릭), `server/llm.mjs`의 `askClaudeCli`/`askAnthropicApi`/`askOllama`/
`checkClaudeCliAvailable`/`checkAnthropicApiKeyConfigured`/`checkOllamaAvailable`, `electron/main.ts`,
`electron/preload.ts`, `ModalShell.tsx`, `ConfirmModal.tsx`, `OllamaConfigModal.tsx`는 PhoneBook 원본을
거의 그대로 포트했다. 새 프로젝트를 PhoneBook 스타일로 만들 때 이 파일들부터 복사해서 시작하면 빠르다.

## 고유 키가 없는 엔티티의 bulk-upsert 중복 판정

**사용 시점:** PhoneBook의 연락처처럼 email/phone 같은 자연 고유키가 없는 엔티티(예: 회의, 일정)를
import bulk-upsert할 때.

```js
// 정규화된 title(trim+lowercase) + 정확히 같은 date로 중복 판정.
// title과 date가 둘 다 비어있으면 매칭시키지 않음(빈 항목끼리 뭉치는 것 방지).
function duplicateKey(title, date) {
  const normalizedTitle = String(title ?? "").trim().toLowerCase();
  const normalizedDate = String(date ?? "").trim();
  if (!normalizedTitle && !normalizedDate) return null;
  return `${normalizedTitle}__${normalizedDate}`;
}
```

## vite.config.mts를 계약(contract)으로 먼저 완성한 뒤 서버 모듈을 병렬 위임

**사용 시점:** 신규 기능을 여러 sub-agent에 병렬로 위임해야 하는데 아직 서버 모듈이 하나도 없을 때.

`vite.config.mts`의 라우트 핸들러와 `import { funcA, funcB } from "./server/x.mjs"` 구문을 먼저 전부 작성해
두면, 그 자체가 각 서버 모듈이 구현해야 할 정확한 함수 시그니처(인자/반환 shape)가 된다. Sub-agent에게
"vite.config.mts를 읽고 거기서 시그니처를 역산하라"고 지시하면 사람이 각 함수 시그니처를 일일이 문서화하지
않아도 병렬 작업 간 인터페이스가 어긋나지 않는다. 실제로 4개 병렬 sub-agent(db/llm, parsers/exporters, audio,
UI)가 이 방식으로 충돌 없이 통합되었고 `tsc -b`가 첫 시도에 0 에러로 통과했다.

## React 모달 간 props 계약을 먼저 고정하고 병렬로 양쪽 작성

**사용 시점:** 모달 A가 모달 B를 내부에서 렌더링하는데, A와 B를 서로 다른 sub-agent에게 동시에 맡겨야 할 때.

B의 `interface BProps { ... }`를 정확히 고정해서 A와 B 양쪽 프롬프트에 "frozen contract"로 동일하게
제공하면, A는 B가 아직 파일로 존재하지 않아도 `import { B } from "./B"`를 가정하고 정확히 그 shape로 호출하는
코드를 작성할 수 있다. (예: `MeetingFormModal.tsx` ↔ `AudioAnalysisModal.tsx` - `attendeeNames`,
`sttProvider`, `onComplete(analysis)` 등 5개 필드를 프롬프트에 고정.)

## 오디오 STT + 화자 분리 파이프라인 (실제 음향 기반 diarization, 2026-08-17 갱신)

**⚠️ 이 항목은 예전에 "pause 기반 휴리스틱"으로 적혀 있었는데 그 코드는 이미 삭제되어 있었다 (stale
문서가 실제 조사를 오도한 사례 - CACHE 플러시 없이 오래 방치하면 이렇게 된다). 2026-08-17 기준 실제
구조로 다시 씀.**

`server/audio/diarize.mjs`의 `diarizeSegments`는 더 이상 pause 휴리스틱을 쓰지 않는다. STT가 반환한
세그먼트 중 `.speaker` 필드가 하나라도 있으면 그대로 통과시키고, 하나도 없으면 전부 단일 화자
`DEFAULT_SPEAKER_LABEL="A"`로 처리한다(라벨→실명 매핑은 그대로: `attendeeNames` 배열 인덱스 매칭, 부족하면
`화자 ${label}` 폴백). 즉 **실제 화자 분리 여부는 각 STT 프로바이더가 `.speaker`를 채워주느냐에 달려있다**.

**사용 시점:** 진짜(음향 기반) 화자 분리가 필요할 때. 세 가지 경로가 있다:

1. **로컬 WhisperX** (`sttLocalWhisperX.mjs`) 와 2. **로컬 Whisper CLI**(`sttLocalWhisperCli.mjs`) 둘 다
   **공용 모듈 `server/audio/pyannoteDiarize.mjs`**를 거친다(2026-08-18, B3에서 통합 — 자세한 배경은
   아래 "B3 갱신" 참고). `HUGGINGFACE_TOKEN`이 `.env`에 있으면 전사 완료 후 별도 후처리 단계로
   `runDiarizeWithEmbeddings()`를 호출해 `whisperx.diarize.DiarizationPipeline(..., return_embeddings=True)`
   → `(diarize_df, {"SPEAKER_00": [float,...], ...})`를 얻고, `assign_word_speakers(diarize_df,
   whisper_result, speaker_embeddings=embeddings)`로 화자 라벨을 병합한다. pyannote 게이트 모델
   (`pyannote/speaker-diarization-community-1`)을 쓰므로 hf.co에서 이용 약관 동의 + 토큰 발급이 최초
   1회 필요(사용자 몫, 자동화 불가). **주의**: pyannote/whisperx는 로딩 중 INFO 로그를 stdout에 쓰므로,
   병합 결과·임베딩을 stdout으로 `print`하면 JSON 파싱이 깨진다 — 반드시 별도 파일에 써서 Node가 그
   파일을 다시 읽어야 한다.
3. **Naver Clova 자체 diarization** (`sttNaverClova.mjs`) — `diarization: {enable: true, speakerCountMin,
   speakerCountMax}`를 요청 params에 넣으면 응답 세그먼트에 `diarization.label`(화자 번호 문자열)이 온다.
   API 자체 기능이라 별도 모델/토큰 불필요, Invoke URL/Secret Key만 있으면 자동 적용. 임베딩은 제공하지
   않으므로 B3의 음성 프로필 매칭은 이 경로에서 적용되지 않는다(위치 기반 폴백만).

**공통 안전장치**: 세 경로 모두 "best-effort, 실패해도 기존 대본은 그대로 반환"(하드 실패 없음) — HF
토큰이 없거나 pyannote 로딩이 실패해도 화자 분리만 빠지고 텍스트 인식 자체는 항상 성공한다.

**B3 갱신(2026-08-18, 화자 음성 프로필 영속화)**: WhisperX는 원래 자체 `--diarize`/`--hf_token` CLI
플래그로 diarization까지 한 번에 처리했는데, 그 플래그는 내부적으로 pyannote를 블랙박스로 호출해서
임베딩을 꺼낼 방법이 없었다. B3에서 음성 프로필(재사용 가능한 화자 식별)을 붙이려면 임베딩이 꼭
필요했으므로, WhisperX 경로도 Whisper-CLI처럼 "순수 전사만 하고 diarization은 공용 모듈로 별도
후처리" 구조로 리팩터했다(`--diarize` 플래그 제거). WhisperX의 `--diarize`도 내부적으로 같은
`DiarizationPipeline`을 호출하므로 정확도가 떨어지지 않을 거라는 가설을, 실제 HF 토큰+GPU 환경에서
`data/test-audio/diarize-2speaker-ko-en.wav`로 리팩터 전후 둘 다 재현해서 검증했다(2명 정확히 분리
유지 확인 — 자세한 내용은 `trouble-shooting.md`의 임계값 버그 항목, `STATE.md`의 B3 체크포인트 참고).

`server/voiceProfiles.mjs`가 `data/db/voiceProfiles.json`에 `{id, name, embeddings: number[][],
updatedAt}`로 화자별 임베딩 샘플(최대 20개 롤링)을 저장하고, 코사인 유사도로 매칭한다(`matchSpeakerProfile`).
매칭 우선순위는 이 회의 등록 참석자 → 그 외 전체 프로필 → 미등록(`server/audio/diarize.mjs`의
`assignSpeakersWithProfiles`, `UNREGISTERED_SPEAKER_PREFIX = "미등록 화자 "`). 확정 매칭은 그 자리에서
`registerVoiceProfile`로 샘플을 추가해 프로필을 계속 보강한다. 미등록 화자는 `AudioAnalysisModal`에서
사용자가 실명으로 바꿀 때만(완료 버튼 클릭 시 자동/최종 이름 diff) `/api/voice-profiles/register`를 통해
새로 등록된다 — `speakerEmbeddings`는 `TranscribeResult`에만 있는 일시적 필드로, 저장되는
`Meeting.audio`에는 절대 안 들어간다(등록 후 버림).

클라이언트(`src/lib/audio.ts`)와 UI(`AudioAnalysisModal.tsx`)의 오디오 처리/화자별 waveform 렌더링 방식은
기존과 동일 - `AudioContext.decodeAudioData` → 모노 믹스다운 → WAV 핸드롤 인코딩, 화자별 레인은 실제 음원
분리가 아니라 전체 mix envelope을 그 화자의 시간 구간에서만 하이라이트하는 근사 표현.

**검증 시 주의(재발 방지)**: Playwright로 다화자 재현 테스트할 때 `getByPlaceholder('이름')`은 기본
부분일치라 "주관자 이름" 필드까지 같이 잡혀서 참석자 데이터가 엉뚱한 칸에 들어간다(`{ exact: true }` 필수).
또한 pyannote 클러스터링은 `min_speakers`/`max_speakers` 힌트 없이는 대화 길이가 짧을 때 실제 화자 수보다
적게 감지하는 경향이 있었다 - 참석자 목록(발표자/주요참석자로 체크된 것만 `attendeeNames`에 들어감,
`MeetingFormModal.tsx`의 `audioAttendeeNames()`)을 반드시 채운 상태로 테스트할 것.

**해결된 실제 버그(2026-08-17): `encodeWav`가 float→int16 변환 시 반올림 대신 버림을 했다.** 브라우저로
업로드한 오디오만 화자 분리가 1명으로 뭉개지는 문제가 있었다 - 처음엔 "pyannote가 이 합성 음성 쌍을
판정 경계선에서 헷갈려 한다"고 잘못 결론 내렸는데(모델 탓으로 돌리기 전에 더 팠어야 했음), 사용자가
"같은 성공 경로를 다시 재현해보라"고 지적한 덕분에 계속 팠다. `src/lib/audio.ts`의 `encodeWav()`에서
```js
const intSample = Math.max(-1, Math.min(1, mono[index])) * 32767;
view.setInt16(offset, intSample, true);
```
`DataView.setInt16`은 정수가 아닌 값을 받으면 **반올림이 아니라 0쪽으로 버림**한다(ECMAScript
ToIntegerOrInfinity). 매 샘플마다 일정한 방향으로 치우친 양자화 오차(~0.5 LSB)가 생기는데, ffmpeg 등
정상적인 인코더는 반올림을 한다. 원본 파일과 브라우저가 재인코딩한 파일을 PCM 샘플 단위로 diff하면
전체 샘플의 ~60%가 딱 ±1 차이였고, 이 정도로 작은 차이가 pyannote 클러스터링 결과를 1명→2명으로
뒤집기에 충분했다(왜 이렇게 작은 차이에 민감한지는 pyannote 내부 구현의 문제이고, 우리 쪽에서 통제
가능한 부분은 "정확한 인코딩"뿐이다).

**해결**: `Math.round()` 추가.
```js
const intSample = Math.round(Math.max(-1, Math.min(1, mono[index])) * 32767);
```
수정 후 브라우저 경로로도 원본 파일과 동일하게 2화자로 정확히 분리되는 것을 반복 확인(2회 연속 동일
결과).

**교훈**: "모델/데이터가 원래 이렇다"는 결론은 반증하기 쉬운 값싼 결론이다 - 같은 성공 경로를 다시
재현해서 진짜 재현 가능한 차이인지부터 확인하고, PCM 샘플처럼 겉보기엔 무해해 보이는 수치라도 실제
바이트를 까서 어디서 갈라지는지 끝까지 추적해야 한다. (중간에 "48kHz→16kHz 이중 리샘플 때문"이라는
다른 가설도 세웠다가 기각했었다 - `decodeAudioFile`을 `new AudioContext({sampleRate: 16000})`로 고쳐
이중 리샘플 자체는 없앴는데, 그것만으로는 안 고쳐져서 진짜 원인이 아니었음이 드러났다. 이 변경 자체는
불필요한 리샘플을 없애는 정당한 개선이라 그대로 유지. 진짜 원인은 그 다음에 찾은 `encodeWav`의 반올림
누락이었다.)

## LLM/STT 프로바이더 선택 설정 패턴 확장 (무료 기본값 + 여러 옵션)

**사용 시점:** "여러 프로바이더 중 설정에서 고르게 해줘, 무료를 기본값으로" 같은 요구사항.

`llmProviders`(PhoneBook)와 동일한 shape의 `sttProviders` 배열을 domain.ts에 병렬로 추가:
```ts
interface SttProviderOption { id; label; description; isFree: boolean; requiresApiKey: boolean; requiresLocalInstall?: boolean }
```
SettingsView는 `providerAvailability()`(LLM)와 `sttAvailability()`(STT) 두 개의 병렬 헬퍼로 준비상태
뱃지(ready/not-ready)를 계산하고, 두 프로바이더 목록을 동일한 `.llm-provider-list`/`.llm-provider-item`
CSS 클래스로 렌더링한다(제네릭 하나로 합치지 않고 병렬 구조 유지 - 각 도메인의 상태 shape이 다르므로).
`defaultSettings.sttProvider = "mock"`처럼 무료 옵션을 기본값으로 고정.

## 문서 라운드트립을 위한 PDF export/import 라벨 포맷 공유

**사용 시점:** "이 앱이 내보낸 파일을 다시 가져오면 원래 데이터로 복원돼야 한다"는 요구사항을 별도 스토리지
포맷 없이 PDF 텍스트만으로 만족시켜야 할 때.

`exportPdf.mjs`가 `제목:`/`날짜:`/`시작:`/`종료:`/`주관자:`/`참석자:` 같은 고정 라벨 + `Agenda`/`A/I List`/
`회의록` 섹션 헤더로 렌더링하고, `importPdf.mjs`(및 `importDocx.mjs`)가 정확히 같은 정규식으로 그 라벨을
파싱한다. 라벨이 없는 제3자 문서는 "첫 줄=제목, 나머지=본문" 폴백으로 처리(PhoneBook의 "이 앱이 내보낸
형식만 안정적으로 파싱" 관례와 동일). `docx`/`pptx` 내보내기는 구조화된 Table/Slide 형식이라 라벨 포맷이
아니므로 재-import 시 라운드트립을 보장하지 않는다(요구사항 자체가 PDF만 보장이었음) - 폴백 경로로 자연스럽게
빠진다.

## pptxgenjs Node.js Buffer 출력

**검증됨(런타임 확인, 2026-08-15):** `await pptx.write({ outputType: "nodebuffer" })`는 실제로 유효한 .pptx
바이너리(ZIP/OOXML, magic bytes `50 4b 03 04`)를 담은 `Buffer`를 반환한다. `docx`의 `Packer.toBuffer(doc)`도
동일하게 검증됨.

## Sub-agent 병렬 위임 시 CSS 토큰 재사용 강제

**사용 시점:** 여러 sub-agent가 각자 새 UI 컴포넌트를 만들 때 디자인 일관성이 깨지기 쉽다.

Wave 2에서 디자인 시스템(app.css의 색상 토큰, `.field`/`.primary-action`/`.status-badge`/
`.editable-table` 등 범용 클래스)을 먼저 통째로 완성해 두고, 이후 모든 sub-agent 프롬프트에 "이 클래스들을
재사용하라, 새 클래스는 최소한으로"라고 명시하면 대부분의 컴포넌트가 새 CSS 없이 완성된다. 실제로 UI 셸 7개
컴포넌트는 새 CSS 없이, 모달 대부분도 기존 클래스만으로 완성됐고, 오직 오디오 파형/스크립트 패널처럼 정말
새로운 시각 요소가 필요한 경우에만(`AudioAnalysisModal`) 기존 토큰 색상을 따라 소량의 CSS를 추가했다.
