# State

## Current Wave

- **Wave:** 10
- **Status:** Done
- **Cache Status:** CLEAN
- **Last Checkpoint:** 첨부 기준 폴더를 `data/attachments`로 되돌리고, 전체 샘플/테스트 첨부 파일을
  `data/attachments/YYYY-MM-DD-{회의 제목}/materials/` 아래에 재생성. legacy `assets/attachments` 삭제,
  전체/테스트 첨부 내부 test 문구 검증, 서버 경로 해석 검증, `npm run build` 통과.

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

## Session Notes

- PhoneBook을 1차 기준으로 삼아 전체 구조를 이식했고(SNS-Reader는 참고자료로만 사용), 오디오 분석·STT
  프로바이더 선택(무료 기본값)처럼 PhoneBook에 없는 신규 기능은 사용자 스펙에 맞춰 새로 설계했다.
- 8개 sub-agent(Wave 3 4개 + Wave 4 4개)를 병렬로 위임했고, 계약(domain.ts → vite.config.mts → app.css)을
  먼저 고정해둔 덕에 통합 시 인터페이스 충돌이 없었다. `tsc -b`가 통합 후 첫 시도에 0 에러로 통과.
- 남은 미검증 항목(실제 환경에서 1회 확인 필요): 로컬 openai-whisper CLI 실제 설치 시 JSON 출력 형태,
  OpenAI Whisper API 실제 응답 형태 (둘 다 `OPENAI_API_KEY`/로컬 설치가 없어 이번 세션에서 호출 불가).
- 다음 세션 시작 시 우선순위: (1) 위 두 미검증 항목을 실제 키/설치 환경에서 확인, (2) Electron 패키징
  (`npx electron-builder`) 검증, (3) 사용자 브라우저 실사용 피드백 반영.
