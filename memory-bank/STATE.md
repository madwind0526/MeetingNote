# State

## Current Wave

- **Wave:** 11
- **Status:** Done
- **Cache Status:** CLEAN
- **Last Checkpoint:** 사이드바 가져오기/내보내기를 "회의 하나" 단위(DB저장/DB복원은 전체 DB로 분리)로
  재구성 + MD 포맷 추가, Naver Clova STT 프로바이더 추가, 분석 진행률(%) job/poll 구조로 표시, 로컬
  Whisper CLI/WhisperX/Naver Clova 3곳 모두 실제 화자 분리(diarization) 연결(WhisperX 자체
  `--diarize`, Naver Clova 자체 diarization, Whisper CLI는 pyannote 직접 호출해 수동 병합). 클라이언트
  오디오 디코드를 16kHz로 명시(`AudioContext({sampleRate:16000})`)해 불필요한 리샘플 제거하고,
  `encodeWav()`의 float→int16 반올림 누락 버그를 고쳐서(`Math.round` 추가) 브라우저 업로드 경로에서도
  화자 분리가 원본 파일과 동일하게 정확히 동작하는 것까지 확인 완료.

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
- 다음 세션 시작 시 우선순위: **`memory-bank/roadmap.md`부터 확인**(사용자가 2026-08-17 세션 마지막에
  구술한 향후 기능 7개 - 약어 사전, 발표자료+STT 결합 정리, 전체 회의록 합성, 회의 중 A/I 추출, 미등록
  발언자 처리 방안, 화자 음성 프로필 영속화, STT 수정 이력 재적용). 그 다음으로: Electron 패키징
  (`npx electron-builder`) 검증, 회사 PC(오프라인) 이전을 위한 로컬 Whisper 오프라인 설치 번들 준비
  (사용자가 이전에 요청함), 여유가 되면 실제 사람 목소리 다화자 녹음으로도 화자 분리 한 번 더 확인
  (지금까지는 합성 음성으로만 검증됨).
