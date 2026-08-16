# Cache

> 임시 발견사항 저장소. Wave 완료 후 knowledge/ 로 flush하고 이 섹션을 비울 것.
> Sub-agent는 작업 완료 후 발견사항을 아래에 추가한다.

## Active Findings

| 유형 | 발견사항 | 이동 대상 |
|------|----------|-----------|
| (없음) | 2026-08-17, Wave 11(가져오기/내보내기 재구성 + Naver Clova/HF 화자 분리 + encodeWav 반올림 버그 수정) 완료 후 전체 flush됨. 상세 내용은 `knowledge/PATTERNS.md`(오디오 STT+화자 분리 파이프라인 항목, 2026-08-17 갱신), `knowledge/RULES.md`(G-06/G-07), `knowledge/trouble-shooting.md` 참고. 재사용 가능한 항목은 `C:\Claude\memory-bank\`에도 추가함(python-subprocess-cp949-crash, js-const-param-name-collision-tdz, playwright-getbyplaceholder-substring-match, whisper-language-locked-per-file, vite-config-imported-file-restart, web-audio-pcm-int16-rounding). | - |

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
