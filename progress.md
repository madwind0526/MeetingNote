# Progress

## 2026-09-02 세션

### 오늘 진행한 것

- 앱 실제 실행 확인(`npm start` → Electron 창 "MeetingNote" 정상 기동, 기존에 떠있던 Vite dev 서버 재사용).
- 클러스터 기반 화자 분리 재도입 여부 결정을 위해 긴 오디오로 재측정(사용자 요청) — 30분(6인) 30.7s(고정
  비용 7.4s + 실제 diarize 22.4s), 71분(6인) 76.0s(고정 7.2s + 실제 diarize 67.9s). 회의가 길어질수록
  고정 비용 비중은 작아지고 실제 diarize 계산 시간이 오디오 길이에 거의 비례해서 지배적이 됨(실시간의
  1.2~3.5%, GPU에서 30~80배속) — 긴 회의는 상주 워커를 붙여도 이 계산 시간 자체는 줄지 않음.
  - 코드를 다시 확인해 중요한 정정: 지금 diarization(재도입 시)은 **STT chunk마다 그 chunk 오디오로 따로
    호출**되는 chunk 단위 구조(`sttLocalWhisperX.mjs`/`sttLocalWhisperCli.mjs`의
    `audioPath: inputPath`) — 사용자 회사가 고친 것과 동일한 문제. 재도입 시 STT 전체 완료 후 조립된 전체
    파일로 1회만 도는 구조로 바꿔야 함.
  - 반대로 **이미 활성화되어 있는** 클립 기반 "화자 분리"(`classify-clips`)는 처음부터 전체 오디오
    방식(pending 세그먼트 전부를 한 번에 배치 호출)이라 사용자 회사 방식과 이미 동일함 — 이 부분은 변경
    불필요.
  - chunk 단위 vs 전체 오디오 배치의 실제 매칭 결과 **일관성** 비교(사용자 질문): 지금처럼 전체를 한 번에
    처리하면 모든 클립이 그 시점의 완성된(사용자가 다 태깅을 마친) profile registry 하나로 통일되게
    비교됨. Chunk마다 그때그때 처리하면, 아직 뒤쪽에 등장하는 사람을 안 태깅한 이른 시점에 앞쪽 chunk가
    먼저 처리되어 같은 사람의 목소리인데도 chunk 순서(타이밍)에 따라 결과가 갈리는 구조적 불일치가 생길 수
    있음 — 전체 오디오 방식이 일관성 면에서도 명백히 유리, 현재 구현 유지가 맞음.
- **음성 프로필 관리 UI를 카드뷰 팝업으로 재설계**(사용자 요청):
  - 신규 공용 컴포넌트 `src/components/modals/VoiceProfileManagerModal.tsx` — `ModalShell` 기반,
    `.card-grid`(기존 회의 카드뷰와 같은 그리드) 안에 프로필마다 카드(이름 + 샘플 개수), 카드 우측 상단에
    삭제 아이콘(`.voice-profile-card-delete`, `.voice-profile-card` 스타일 신규 추가, meeting-card와 같은
    시각적 패턴).
  - Settings: 기존 인라인 리스트를 제거하고 "계정 관리" 섹션과 동일한 패턴으로 설명 + "수정" 버튼만 남김 →
    클릭 시 위 모달이 팝업(App.tsx가 `showVoiceProfileManagement` 상태로 소유, 기존 `onOpenMemberManagement`
    패턴 그대로 따름).
  - 오디오 분석 모달: "분석 시작"/"화자 분리" 오른쪽에 "화자 편집" 버튼 신규 추가(녹음 모드·파일 모드 두
    군데 모두) — 클릭 시 같은 모달이 `overlayZIndex=1000`으로 중첩 팝업(이미 열려있는 "회의 음성 분석" 모달
    위에 뜨는 "수정 사전 등록" 팝업과 동일한 z-index 패턴). 프로필 삭제 시 `onProfilesChanged` 콜백으로
    `refreshProfileNames()`를 호출해 화자 선택 드롭다운의 초록/흰색 표시를 즉시 갱신.
  - 처음엔 "화자 편집" 버튼을 `ghost-action`으로 만들었다가, 사용자가 "분석 시작"/"화자 분리"와 스타일이
    다르다고 지적 — 세 버튼 모두 `primary-action`으로 통일.
  - Playwright로 라이브 검증: Settings 수정 버튼 → 카드뷰 팝업, 오디오 분석 모달 화자 편집 버튼 → 같은
    팝업이 올바른 z-index로 중첩되는 것, 세 버튼 스타일이 동일해진 것까지 전부 확인.
- **화자 선택 드롭다운(SpeakerPicker) 버그 수정 + 역할 뱃지 추가**(사용자 지적):
  - 버그: `MeetingFormModal`의 `audioAttendeeNames()`가 간사(`draft.secretary`)를 아예 빼먹고 있었고,
    `isKeyAttendee`가 꺼진 일반 참석자도 조용히 걸러내고 있었음 — 그래서 드롭다운에 일부 사람만 보였음.
    `audioAttendeeRoles()`로 재작성해서 주관자·간사·발표자·참석자를 전부(우선순위: 주관자 > 간사 > 발표자
    > 참석자, 중복 이름은 가장 높은 역할로 한 번만) 포함하도록 수정 — "미등록 화자 N" 같은 세션 전용
    라벨과는 무관하게 항상 전체 명단이 뜸.
  - 뱃지: 주관자/간사/발표자 세 가지만 색을 다르게(보라/파랑/주황) 표시, 일반 참석자는 뱃지 없음(사용자가
    이 3개만 요청). 새 공용 타입 `SpeakerRoleBadge`/`SpeakerRoleEntry`(`types/domain.ts`)로
    `MeetingFormModal` → `AudioAnalysisModal` → `SpeakerPicker`까지 롤 정보를 전달, 기존 초록(has-profile)
    표시와 뱃지가 한 줄에서 같이 동작하도록 `<li>`를 flex로 재구성.
  - 정렬: 사용자 요청으로 드롭다운 이름을 항상 가나다순(`localeCompare(..., "ko")`)으로 정렬.
  - Playwright로 라이브 검증(3분기 프로젝트 회의 - 주관자 박지훈이 참석자 목록에 없는 케이스 포함): 강태양·
    배시온(뱃지 없음), 김민서·이수아·정도윤·최하은(발표자, 주황), 박지훈(주관자, 보라 - 참석자 배열에
    없는데도 정상 표시), 오유진(간사, 파랑 - 참석자 배열에도 있지만 간사가 우선), 전체 가나다순 정렬, 이미
    등록된 프로필(박지훈)의 초록색 표시와 뱃지가 동시에 잘 보이는 것까지 스크린샷으로 확인.
- **SpeakerPicker 드롭다운 닫기 버그 수정**(사용자 지적: "V를 다시 눌러야 닫힘, 바깥 클릭으로도 닫히면
  좋겠음"): `containerRef` + `document.addEventListener("mousedown", ...)` 방식의 바깥 클릭 감지를
  `useEffect`로 추가(드롭다운이 열려있을 때만 리스너 등록). Playwright로 라이브 검증 — ▼로 드롭다운을 연 뒤
  모달 제목(다른 영역)을 클릭하면 정상적으로 닫히는 것 확인.
- **화자 편집(프로필 삭제) 후 재등록 안 되던 버그 수정**(사용자 지적): `applySegmentSpeakerName`이 세그먼트를
  "이미 존재하는 라벨"로 병합하는 분기(`otherLabel` 매칭)에서는 `enrollSegmentClip`을 호출하지 않고 있었음 —
  라벨 이름이 이미 있으면 "이미 등록됨"으로 잘못 간주한 것. 하지만 화자 편집 팝업에서 그 이름의 프로필을
  삭제해도 세션 중인 라벨은 그대로 남아있으므로, 삭제 후 그 이름으로 재태깅해도 다시 등록되지 않는 문제로
  이어짐. 병합 분기에서도 항상 `enrollSegmentClip`을 호출하도록 수정(이미 건강한 프로필이면 샘플 하나
  추가되는 것뿐이라 무해함). Playwright로 라이브 검증: 정도윤 프로필을 화자 편집에서 삭제(`voiceProfiles.json`
  에서 사라짐 확인) → 다른 세그먼트를 드롭다운에서 "정도윤"으로 선택(병합 경로) → `voiceProfiles.json`에
  정도윤이 새 샘플 1개로 재등록되고 `updatedAt`이 클릭 시각과 일치하는 것까지 확인.
- **"화자 분리" 버튼이 클릭 직후 바로 반응하지 않는 문제 수정**(사용자 지적: "눌렀을 때 클릭이 된 건지 안 된
  건지 몰라서 여러 번 누르게 됨"): `handleClassifyRemainingSegments`가 `setIsClassifyingRemaining(true)` 직후
  대기 중인 세그먼트 전부를 `sliceAudioBufferToWav`로 동기적으로 자르는 무거운 작업을 하고 있어서, 회의가
  길고 대기 세그먼트가 많을수록 그 작업이 끝나기 전까지는 "화자 분리 중..." 버튼 텍스트/비활성화가 화면에
  그려지지 않았음(state는 이미 갱신됐지만 브라우저가 그 사이 페인트할 기회가 없었음). 클립 자르기 시작 전에
  `await new Promise((resolve) => requestAnimationFrame(resolve));`를 추가해 브라우저가 로딩 상태를 먼저
  그리도록 함. Playwright로 라이브 검증: 클릭 후 실제 `classify-clips` 네트워크 요청이 정상적으로 나가고
  결과도 이전과 동일하게 반영되는 것 확인(3분기 프로젝트 회의에서 정도윤 세그먼트 자동 매칭 재확인).

### 진행할 것 / 남은 일

- 오늘 배치(음성 프로필 관리 카드뷰 재설계 + 버튼 스타일 통일 + 화자 드롭다운 버그 수정/역할 뱃지/가나다순
  정렬 + 긴 오디오 재측정 결과 + 드롭다운 바깥 클릭 닫기 + 화자 편집 후 재등록 버그 + 화자 분리 버튼 반응성
  개선) 커밋 필요 — 아직 커밋 안 됨.
- **클러스터 기반 화자 분리를 "분석 시작"에 다시 켤지** 여전히 사용자 결정 대기 중 — 이번에 추가된 30분/71분
  실측치까지 포함해서 위에 정리됨. 켜기로 하면: (1) chunk 단위 → 전체 파일 1회 구조로 변경,
  (2) 클러스터 임베딩을 `registerVoiceProfile`로 자동 등록하는 옛 경로는 절대 살리지 말고 "미등록 화자 N"
  라벨링 용도로만 사용.

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
- 회의록 헤더(제목/일시/장소/주관자/참석자) 줄바꿈 깨짐 수정: `MINUTES_SYSTEM_PROMPT`에 아무 형식 지시가 없어서
  LLM마다(심지어 같은 모델도 실행마다) 한 줄로 뭉개거나 줄바꿈하거나 제각각이었음 — 헤더를 반드시 markdown
  목록(`- **일시:** ...`)으로 쓰라는 지시를 명시적으로 추가, 결제 모듈 회의로 재생성해서 확인.
- 사용자 질문으로 세 가지 성능 실측 진행(추측 대신 실제 코드 경로에 타이밍 로그를 넣어 측정):
  - **화자 분리**(`classify-clips`, pyannote/embedding, 7개 세그먼트): 총 8.45s 중 python 프로세스
    시작+torch/pyannote import 5.72s(68%) + 모델 로딩 0.99s(12%) + 실제 추론 0.26s(3%) + ffmpeg 클립
    추출 0.52s(6%) — 실제 계산은 거의 공짜고 프로세스 기동 비용이 80%.
  - **발표 정리+회의록 작성**(Ollama gemma4:8B, Agenda 4개짜리 회의): 발표 정리 순차 합계 57.0s(항목별
    8.0~21.1s) + 회의록 작성 19.2s = 총 76.2s. 별도로 이 Ollama 서버가 동시 요청을 진짜 병렬 처리하는지
    직접 테스트(2개 동시 요청 → wall clock이 합이 아니라 더 느린 쪽과 같음, 18.3s ≈ max(18.3s, 6.4s)) —
    확인됨.
  - **클러스터 기반 화자 분리**(`DiarizationPipeline`, 사용자가 "분석 시작"에서 다시 켤지 검토 요청): 34초
    2인 오디오 9.6s(import 5.4s + 파이프라인 구성 2.1s + 실제 diarize 1.2s), 287초 8인 오디오 12.9s(import
    5.4s + 구성 2.0s + 실제 diarize 4.6s) — "화자 분리"용 단일 임베딩 모델보다 로딩할 모델이 더 많아 기동
    비용이 조금 더 크고, 실제 diarize 계산 시간은 오디오 길이에 비례해서 늘어남(긴 회의일수록 이 부분이
    커짐 - 47분/71분짜리 회의는 직접 측정하지 않았으나 대략 비례 외삽하면 실제 diarize만 40~60초대로
    추정됨, 확인된 값 아님).
- 위 실측을 바탕으로 **화자 분리에 상주 Python 워커 도입**(사용자 승인) — `server/audio/pyannoteDiarize.mjs`의
  `runEmbedClips`를 매 호출 새 프로세스 spawn 방식에서, 모델을 한 번만 로드하고 stdin/stdout으로 JSON 한 줄씩
  주고받는 상주 워커 방식으로 재작성(`buildEmbedWorkerScript`/`ensureEmbedWorker`/`killEmbedWorker`, 모듈
  전역 싱글턴, 서버 프로세스 수명과 함께 감). 라이브로 검증: 세그먼트 5개를 개별 태깅하는 상황을 재현했더니
  첫 호출만 10.09s, 나머지 4개는 0.01~0.02s — 이전엔 5개 전부 각각 ~8초였을 것.
- **발표 정리 병렬화는 보류** — 사용자가 순차(serial) 유지를 명시적으로 선택. 코드 변경 없음(이미 순차).
- **클러스터 기반 화자 분리 재도입 여부는 사용자 결정 대기** — 위 실측 수치(짧은 회의 +9.6s, 5분짜리 +12.9s,
  긴 회의는 더 클 것으로 추정)를 근거로 판단 필요. 재도입하더라도 예전처럼 클러스터 임베딩을 곧바로
  `registerVoiceProfile`로 자동 등록하면 안 됨(오염 버그 재발) — 클러스터링은 "미등록 화자 N"을 여러 개로
  정확히 나누는 용도로만 쓰고, 프로필 등록은 지금처럼 세그먼트 클립 태깅 경로로만 유지해야 안전.

### 진행할 것 / 남은 일

- 오늘 두 번째 배치(회의록 헤더 줄바꿈 수정, 화자 분리 상주 워커, 발표 정리는 그대로 유지) 커밋 필요 —
  아직 커밋 안 됨.
- **클러스터 기반 화자 분리를 "분석 시작"에 다시 켤지** 사용자 결정 대기 중 — 실측 수치는 위에 정리됨.
  결정되면: `AUTO_DIARIZE_ON_TRANSCRIBE`를 조건부로 켜되, 클러스터 임베딩을 그대로 `registerVoiceProfile`에
  넘기던 옛 `assignSpeakersWithProfiles` 경로 대신 "여러 개의 미등록 화자 N으로만 라벨링, 등록은 절대 안 함"
  하는 새 경로가 필요함(`server/audio/diarize.mjs`).
- 3분기 프로젝트 진행 현황 공유 회의: 박지훈/강태양/배시온 태깅 + 오유진 재등록(샘플 2개 이상) 후 "화자 분리"
  재검증은 아직 안 함.
- 테스트 중 만든 `diag-*.mjs` 진단 스크립트는 매번 삭제 완료.

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
