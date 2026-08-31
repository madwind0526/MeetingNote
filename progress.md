# Progress

## 2026-08-31 세션

### 오늘 진행한 것

- `pyannote/embedding` 게이트 모델 접근 오류를 완전히 해결. 실제 원인은 HuggingFace 액세스 승인 문제가 아니라
  코드 버그 2건이었음:
  - `Model.from_pretrained(..., use_auth_token=...)` 호출 — 설치된 `pyannote.audio` 버전은 파라미터명이
    `token`으로 바뀌어서 `use_auth_token`이 `**kwargs`로 조용히 무시되고 토큰이 아예 전달되지 않고 있었음.
    `token=`으로 수정 (`server/audio/pyannoteDiarize.mjs`).
  - torchcodec/torchaudio용 오디오 백엔드가 이 venv에 설치되어 있지 않아 `Inference()`가 오디오를 못 읽던 문제.
    Python 표준 라이브러리 `wave` 모듈로 직접 16bit PCM mono WAV를 파싱하도록 변경(별도 pip 설치 불필요).
- 클립 기반 화자 등록/분류 전체 파이프라인(분석 시작 → 세그먼트별 수동 태깅 → 음성 프로필 등록 → 화자 분리)을
  실제 앱에서 라이브로 검증 완료.
- `diarizeSegments`(라벨이 하나뿐일 때의 폴백, `server/audio/diarize.mjs`) 버그 발견 및 수정: "미등록 화자 1"이
  아니라 참석자 목록에서 위치 기반(`names[0]`)으로 실명을 바로 붙이고 있었음 — 사용자가 라이브 테스트로 직접
  발견("왜 조은우로 나오지?"). 진짜 진단 신호가 전혀 없는 단일-라벨 케이스에서는
  `UNREGISTERED_SPEAKER_PREFIX`("미등록 화자 N")를 쓰도록 수정.
- "화자 분리"가 이미 등록된 프로필과 실제로 매칭되지 않는 문제 발견 및 수정(`server/voiceProfiles.mjs`):
  동일 화자라도 발화 구간이 다르면 유사도가 0.77~0.79 정도로 나오는데, `classify-clips` 라우트는 항상 엄격한
  임계값(0.85)만 쓰고 있어서 정상적으로 일치하는 경우까지 전부 거부되고 있었음(라이브 실측으로 확인). 이번
  회의의 참석자로 후보를 좁힌 경우에 한해 완화된 임계값(0.75)을 적용하는 fallback을 `scoreSpeakerProfileMatch`에
  추가.
  - 사용자가 "임계값을 낮추면 다른 사람과 구별이 안 될 수도 있다"고 지적 — 실제로 기존 코드 주석에 이 프로젝트의
    같은 테스트 파일에서 서로 다른 화자끼리 0.757까지 나온 실측 사례가 이미 남아 있어(완화 임계값 0.75와 거의
    붙어 있음), 단순 floor만으로는 안전하지 않다는 것이 맞는 지적이었음. 그래서 floor 대신 "1등 후보가 2등
    후보보다 확실히 앞서야 함"(margin ≥ 0.15, `RELAXED_MATCH_MARGIN`)을 추가 조건으로 넣어 재설계 — 실측
    정답 케이스는 격차가 ~0.6이라 여유 있게 통과하고, 애매하게 붙은 경우는 아예 미분류로 남김.
  - 5개 세그먼트 전체로 재검증 완료: 모두 정확한 화자로 분류됨(1/3/5→한지민, 2/4→조은우).
- 사용자 요청으로 `data/db/voiceProfiles.json` 전체 삭제 후 위 수정사항 재검증.
- 메인 화면 4버튼 행(분석 시작/화자 분리/발표 정리/회의록 작성)에서 "화자 분리" 버튼 제거 — 재설계 이전
  잔재로, "분석 시작"과 완전히 동일한 `handleOpenAudioAnalysis()`를 호출하고 있었고 툴팁도 옛 클러스터
  재매칭 방식을 설명하고 있었음. 실제로 의미 있는 "화자 분리"는 오디오 분석 모달 안에 그대로 남아 있음
  (`src/components/modals/MeetingFormModal.tsx`).
- 발표 정리 실패("다음 항목 정리에 실패했습니다: ...") 재현 — Ollama 서버가 꺼져 있을 때 발생, 서버 기동 후
  동일 요청 재현 시 정상 성공. 코드 버그 아님. 다만 클라이언트가 실패 사유를 항상 이 문구로 뭉개서 보여주는
  건 UX 개선 여지로 남겨둠(오늘은 손대지 않음).
- 3분기 프로젝트 진행 현황 공유 회의(7인 참석)에서 "화자 분리가 많이 실패한다" 진단: (1) 주관자 박지훈과
  강태양·배시온이 아직 미등록이라 애초에 맞출 정답이 없었고, (2) 오유진 프로필이 샘플 1개뿐이라 전혀 다른
  화자 구간에도 이상하게 높은 점수(0.31~0.79)를 내서 실제로 박지훈 구간이 오유진으로 오분류될 뻔함(안전장치가
  못 잡음 — 후보군에 진짜 정답이 아예 없어서 "차선 중 최선"이 통과) + 반대로 진짜 이수아 구간은 오유진의
  경쟁 점수 때문에 안전장치에 막혀 미분류로 남음. 오염된 오유진 프로필은 삭제해서 정리함.
- 위 사고를 계기로 **음성 프로필 관리 기능**을 설정 화면에 신규 추가 — `registerVoiceProfile`은 항상
  append만 하고 지우는 기능이 아예 없어서, 한 번 엉뚱한 이름으로 등록된 샘플은 되돌릴 방법이 없었음.
  - 서버: `deleteVoiceProfile(name)` (`server/voiceProfiles.mjs`), `GET/DELETE /api/voice-profiles`
    확장(`vite.config.mts`) — GET 응답에 `profiles: [{name, sampleCount}]` 추가.
  - 클라이언트: `fetchVoiceProfilesRequest`/`deleteVoiceProfileRequest` (`src/lib/api.ts`), 설정 화면에
    "음성 프로필 관리" 섹션 추가(이름·샘플 개수·삭제 버튼, 확인 다이얼로그 포함) (`src/components/SettingsView.tsx`,
    `src/styles/app.css`).
  - 라이브로 삭제 플로우 전체 검증 완료(테스트용 프로필 등록 → 설정에서 삭제 → 목록에서 사라짐 확인, 실제
    프로필들은 그대로 유지되는 것도 확인).

### 진행할 것 / 남은 일

- 방금 고친 `diarize.mjs` + `voiceProfiles.mjs` + 음성 프로필 관리 기능 커밋 (아직 커밋 안 됨).
- 3분기 프로젝트 진행 현황 공유 회의: 박지훈/강태양/배시온 태깅 + 오유진 재등록(샘플 2개 이상) 후 "화자 분리"
  재검증 필요.
- 클립 기반 재설계 플로우를 처음부터 끝까지 다시 한 번 라이브로 재검증
  (분석 시작 → "미등록 화자 1"로 뜨는지 확인 → 세그먼트 태깅 → "화자 분리"로 나머지가 정확히 분류되는지).
- 검증 후 커밋 + `RevisionNote.md` 갱신.
- 테스트 중 만든 `diag-*.mjs` 진단 스크립트는 이미 삭제 완료.

## Attachment Folder Rule

- Attachment files are stored under `data/attachments`.
- Each meeting must use a date-prefixed folder:
  - Format: `YYYY-MM-DD-{회의 제목}`
  - Example: `2026-09-02-고객 피드백 분석 및 대응 방안`
- Do not use title-only folders such as `{회의 제목}` because multiple meetings can share the same title.
- Material files go under:
  - `data/attachments/YYYY-MM-DD-{회의 제목}/materials/{파일명}`
- Audio files go under:
  - `data/attachments/YYYY-MM-DD-{회의 제목}/audio/{파일명}`
- Meeting data stores only the path relative to `data/attachments`.
  - Correct: `2026-09-02-고객 피드백 분석 및 대응 방안/materials/feedback-summary.xlsx`
  - Incorrect: `data/attachments/2026-09-02-고객 피드백 분석 및 대응 방안/materials/feedback-summary.xlsx`
  - Incorrect: `고객 피드백 분석 및 대응 방안/materials/feedback-summary.xlsx`

## Current Attachment Migration

- Existing sample meetings should have test attachment files generated under the date-prefixed folders.
- `data/db/meetings.json` and `data/seed/meetings.sample.json` should both use the same `materialPath` convention.
- The app's default attachment base folder should be `data/attachments`.
- New uploads from the meeting form should pass `YYYY-MM-DD-{회의 제목}` as the meeting folder label.
