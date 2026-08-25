# Cache

> 임시 발견사항 저장소. Wave 완료 후 knowledge/ 로 flush하고 이 섹션을 비울 것.
> Sub-agent는 작업 완료 후 발견사항을 아래에 추가한다.

## Active Findings

| 유형 | 발견사항 | 이동 대상 |
|------|----------|-----------|
| (없음) | 2026-08-25 세션 완료 후 전체 flush됨. 사전 substring/스크립트 인식 경계 버그, B5 windowing nearest-pause 버그는 `knowledge/trouble-shooting.md`로, STT 대본/발표정리/회의록 md 파일 저장 패턴과 재생-하이라이트 지연 보정 패턴은 `knowledge/PATTERNS.md`로 이동. Wave 요약은 `STATE.md` 참고. | - |

---

## 유형 분류

| 유형 | 이동 대상 |
|------|-----------|
| 코드 패턴 | `knowledge/PATTERNS.md` |
| 규칙/원칙 | `knowledge/RULES.md` |
| 버그/해결 | `knowledge/trouble-shooting.md` |

---

## Flush 방법

Wave 완료 시:
1. 각 항목을 위 표에 따라 `knowledge/` 파일로 이동
2. Active Findings 테이블 비우기
3. `STATE.md`의 Cache Status → `CLEAN`으로 업데이트
