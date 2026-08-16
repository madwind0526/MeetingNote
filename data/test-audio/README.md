# 테스트용 음성 파일

STT/화자 분리 기능 검증에 쓴 합성 음성 파일. Windows SAPI(`Microsoft Zira Desktop`=영어,
`Microsoft Heami Desktop`=한국어)로 생성한 뒤 ffmpeg로 16kHz mono WAV로 변환.

- `diarize-2speaker-ko-en.wav` — 5턴, 2화자(Zira/영어 ↔ Heami/한국어) 대화, 35초. 화자 분리(WhisperX
  `--diarize`, Whisper CLI + pyannote 수동 병합) 검증용 메인 파일. 실제 두 목소리가 번갈아 나오므로
  진짜 다화자 분리 여부를 확인할 수 있다.
- `diarize-seg1~5-*.wav` — 위 파일을 만든 원본 조각(화자별 개별 발화). 다른 조합으로 테스트 음성을
  다시 만들 때 재사용 가능.
- `diarize-2speaker-ko-en.whisper-output.json` — 로컬 Whisper CLI(base 모델)의 원본 전사 결과(참고용).

## 알려진 한계

- 두 목소리 다 합성음(TTS)이라 실제 사람 목소리보다 화자 구분이 쉬울 수도, 음향 특성이 비전형적이라
  오히려 어려울 수도 있다 — 실제 화자 분리 정확도 검증은 진짜 녹음으로 별도 확인 필요.
- `diarize-2speaker-ko-en.wav`는 앞부분 전체가 영어, 뒷부분이 한국어로 나뉘어 있어 "화자가 문장
  단위로 언어를 통째로 바꾸는" 극단적 케이스를 재현한다 — 일반적인 "한국어 문장에 영어 용어 섞임"과는
  다르다. Whisper `--language ko` 강제 시 언어 불일치로 전사가 깨지는 걸 확인하는 데 썼다.
