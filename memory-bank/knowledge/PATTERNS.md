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

## 오디오 STT + 화자 분리 파이프라인 (Web Audio API + pause 기반 휴리스틱)

**사용 시점:** 실제 화자 분리(diarization) 모델 없이 "그럴듯한" 화자별 대본이 필요할 때.

- 클라이언트(`src/lib/audio.ts`): `AudioContext.decodeAudioData` → 모노 믹스다운 → (옵션) RMS 기반 노이즈
  게이트 + peak 정규화 → 16-bit PCM WAV 핸드롤 인코더(44바이트 헤더) → 서버로 업로드. Node 쪽 오디오 디코더
  의존성이 전혀 필요 없다(브라우저가 mp3/wav/m4a 등을 알아서 디코드).
- 서버(`server/audio/diarize.mjs`): STT가 반환한 `{startSec,endSec,text}[]` 세그먼트를 시간순으로 순회하며,
  연속 세그먼트 사이 gap이 `PAUSE_THRESHOLD_SEC`(1.2초)보다 크면 다음 화자 라벨(A→B→C→D, 최대 4명 라운드로빈)
  로 넘어간다. `speakerMap`은 라벨→참석자 실명(발표자/주요참석자 우선순으로 전달된 `attendeeNames` 배열
  인덱스 매칭, 부족하면 `화자 ${label}` 폴백). 참석자가 0명이어도 `Math.max(names.length, 1)`로 최소 1라벨
  동작 보장.
- UI(`AudioAnalysisModal.tsx`): 화자별 waveform 레인은 실제 음원 분리가 아니라, 전체 mix envelope을 그
  화자의 시간 구간에서만 하이라이트(나머지는 dim)하는 방식으로 근사 표현. 사용자가 라벨→실명 매핑을 select로
  수동 정정 가능(휴리스틱의 한계를 UX로 보완).

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
