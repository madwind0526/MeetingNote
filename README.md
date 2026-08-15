# MeetingNote

회의록 작성 데스크톱 앱. 회의 기본정보, 참석자, A/I List, Agenda를 등록하고, 회의 음성 파일을 분석해 화자별
대본을 만든 뒤 LLM으로 회의록을 자동 생성합니다. Card/List 보기, 검색·필터, PDF/Word/PowerPoint/JSON
가져오기·내보내기를 지원합니다.

## 시작하기

```bash
npm install
npm run dev
```

`http://127.0.0.1:5185`에서 브라우저로 바로 확인하거나, `npm start`로 Electron 앱을 실행합니다.

## 주요 기능

- **List / Card 보기** — 등록된 회의록을 요약 카드 또는 표로 확인 (제목, 일시, 회의록 요약, 예정/회의록 작성
  필요/완료 상태)
- **새 회의록 등록** — 기본정보 + 참석자(주요 참석자/발표자) + A/I List 표 + Agenda 표 입력
- **회의 음성 분석** — 전체/화자별 waveform, 시간·텍스트 대본, 노이즈 제거·정규화 전처리 옵션
- **회의록 자동 작성** — Agenda·참석자·음성 대본을 근거로 LLM이 구조화된 회의록 생성
- **가져오기/내보내기** — PDF/Word/PowerPoint/JSON
- **검색 / 필터 / 질문(LLM)** — 저장된 회의록에 대해 자연어로 질문 가능

## 설정

- **AI 질문 및 회의록 작성 (LLM)**: 로컬 검색(무료) / Ollama(무료, 로컬 서버) / Claude CLI(무료, 로컬 설치) /
  Anthropic API(유료, API 키 필요) 중 선택
- **음성 인식 (STT)**: Mock(무료, 기본값) / 로컬 Whisper CLI(무료, 사전 설치 필요) / OpenAI Whisper API(유료,
  API 키 필요) 중 선택

자세한 아키텍처는 `CLAUDE.md`를 참고하세요.
