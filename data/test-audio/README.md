# 테스트용 음성 파일

STT/화자 분리 기능 검증에 쓴 합성 음성 파일. 2화자 파일은 Windows SAPI(`Microsoft Zira Desktop`=영어,
`Microsoft Heami Desktop`=한국어), 8화자 파일은 edge-tts로 생성한 뒤 ffmpeg로 16kHz mono WAV로 변환.

- `diarize-2speaker-ko-en.wav` — 5턴, 2화자(Zira/영어 ↔ Heami/한국어) 대화, 35초. 화자 분리(WhisperX
  `--diarize`, Whisper CLI + pyannote 수동 병합) 검증용 메인 파일. 실제 두 목소리가 번갈아 나오므로
  진짜 다화자 분리 여부를 확인할 수 있다.
- `diarize-seg1~5-*.wav` — 위 파일을 만든 원본 조각(화자별 개별 발화). 다른 조합으로 테스트 음성을
  다시 만들 때 재사용 가능.
- `diarize-2speaker-ko-en.whisper-output.json` — 로컬 Whisper CLI(base 모델)의 원본 전사 결과(참고용).
- `meeting-8speakers-ko.wav` — 8화자(주관자 1, 발표자 4, 참석자 3) 모의 회의, 27턴, 약 4분 27초.
  edge-tts(`ko-KR-SunHiNeural`/`InJoonNeural`/`HyunsuMultilingualNeural` 3종 베이스 보이스에 화자별로
  서로 다른 pitch/rate 오프셋을 줘서 8명을 구분)로 각 대사를 개별 합성한 뒤, 16kHz mono WAV로 변환하고
  턴 사이 0.6초 무음을 넣어 이어붙였다. 발표자 4명이 각각 발표 후 주관자·참석자가 짧게 질문하고
  발표자가 답하는 구조 — 화자 분리(pause 기반 턴 분리 + pyannote 임베딩 매칭) 다화자 실험용.
- `meeting-8speakers-ko.ground-truth.json` — 위 파일을 만들 때 쓴 정답 스크립트. 화자별 실제 이름/역할,
  구간별 시작·종료 시각(초), 대사 원문이 순서대로 들어 있다 — 화자 분리 결과와 대조할 정답지로 사용.

## 알려진 한계

- 두 목소리 다 합성음(TTS)이라 실제 사람 목소리보다 화자 구분이 쉬울 수도, 음향 특성이 비전형적이라
  오히려 어려울 수도 있다 — 실제 화자 분리 정확도 검증은 진짜 녹음으로 별도 확인 필요.
- `diarize-2speaker-ko-en.wav`는 앞부분 전체가 영어, 뒷부분이 한국어로 나뉘어 있어 "화자가 문장
  단위로 언어를 통째로 바꾸는" 극단적 케이스를 재현한다 — 일반적인 "한국어 문장에 영어 용어 섞임"과는
  다르다. Whisper `--language ko` 강제 시 언어 불일치로 전사가 깨지는 걸 확인하는 데 썼다.
- `meeting-8speakers-ko.wav`는 실제 목소리가 3종뿐이라 8명이 pitch/rate 오프셋만으로 나뉜다 —
  같은 베이스 보이스를 쓰는 화자끼리(예: SunHi 기반 주관자/발표자2/참석자1)는 pyannote 임베딩이 실제
  8명의 이질적인 목소리보다 더 가깝게 나올 수 있어, 화자 수를 8로 정확히 갈라내는 난이도가 진짜 8인
  회의보다 오히려 높거나(뭉침) 낮을(피치 차이가 과장된 특징으로 작용) 수 있다.
