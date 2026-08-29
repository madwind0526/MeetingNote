# MeetingNote

회의 기본 정보, 참석자, A/I List, Agenda를 관리하고 회의 오디오 파일을 STT로 분석해 회의록 초안을 만드는 PC 앱입니다. React/Vite 기반 화면과 Electron 실행을 지원하며, 로컬 Whisper CLI, WhisperX GPU, OpenAI Whisper API, Mock STT를 선택할 수 있습니다.

## 빠른 시작

```powershell
npm install
npm run dev
```

브라우저에서 `http://127.0.0.1:5185`로 접속하거나, 데스크톱 앱처럼 실행하려면 다음을 사용합니다.

```powershell
npm start
```

## 주요 기능

- 회의록 List/Card 보기
- 회의 기본 정보, 참석자, A/I List, Agenda 편집
- PDF, Word, PowerPoint, JSON 가져오기/내보내기
- 파일 업로드/PC 소리 녹음 오디오를 청크 단위로 실시간 분석(전체·화자별 파형, 대본 불러오기/발언자 수정)
- 원본 파형과 전처리 파형 비교 재생
- Demucs 음성 분리, DeNoise, 정규화 전처리
- Mock, WhisperX, Whisper CLI, Whisper API STT 엔진 선택
- 발표 자료(PDF/Word/PPT) 자동 Markdown 변환 + 앱 내 뷰어
- LLM(Claude CLI/Anthropic API/Ollama) 기반 발표별 내용 정리, 회의록 자동 작성, 회의록 질의
- 약어/수정 사전 자동·소급 치환 (STT 오인식 교정)

## 스크린샷

`Screenshot/` 폴더에 최근 실행 화면 캡처가 있습니다.

## 로컬 STT 구성 개요

권장 구성은 다음과 같습니다.

- Python: `3.10` - `3.12` 권장, 현재 검증 환경은 `3.12.10`
- 가상환경: `.venv-whisperx`
- PyTorch GPU: CUDA 12.8 wheel, 현재 검증 버전 `torch 2.8.0+cu128`
- Whisper CLI: `openai-whisper`
- WhisperX: `whisperx`
- 음성 분리: `demucs`
- FFmpeg: Windows shared build 필요, 현재 검증 경로 `D:\ffmpeg\ffmpeg-7.1.1-full_build-shared\bin`

Python 3.14는 일부 오디오/ML 패키지 호환성 문제가 생길 수 있으므로 이 프로젝트에서는 3.10-3.12 venv를 따로 만드는 편이 안전합니다.

## 1. Python 버전 확인

PowerShell에서 설치된 Python 런처 목록을 확인합니다.

```powershell
py -0p
```

예상 예:

```text
 -V:3.12 * C:\Users\...\Python312\python.exe
 -V:3.14   C:\Users\...\Python314\python.exe
```

3.12가 없다면 python.org에서 Windows installer로 Python 3.12.x를 설치합니다. 설치할 때 `Add python.exe to PATH`는 선택 사항이지만, `py -0p`에서 보여야 합니다.

## 2. WhisperX 전용 venv 생성

프로젝트 루트(`C:\Claude\MeetingNote`)에서 실행합니다.

```powershell
py -3.12 -m venv .venv-whisperx
.\.venv-whisperx\Scripts\python.exe -m pip install --upgrade pip setuptools wheel
```

venv를 활성화해서 써도 되고, 아래처럼 항상 venv 안의 실행 파일을 직접 호출해도 됩니다.

```powershell
.\.venv-whisperx\Scripts\python.exe --version
.\.venv-whisperx\Scripts\pip.exe --version
```

## 3. CUDA/GPU PyTorch 설치

NVIDIA GPU를 사용할 경우 먼저 드라이버와 CUDA 런타임이 정상인지 확인합니다.

```powershell
nvidia-smi
```

이 프로젝트에서 검증한 RTX 5070 환경은 CUDA 12.8 wheel을 사용했습니다.

```powershell
.\.venv-whisperx\Scripts\pip.exe install torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
```

설치 후 CUDA 인식 여부를 확인합니다.

```powershell
.\.venv-whisperx\Scripts\python.exe -c "import torch; print(torch.__version__); print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU')"
```

정상 예:

```text
2.8.0+cu128
True
NVIDIA GeForce RTX 5070
```

CPU 전용으로만 사용할 경우에는 아래처럼 설치할 수 있습니다.

```powershell
.\.venv-whisperx\Scripts\pip.exe install torch torchvision torchaudio
```

단, WhisperX와 Demucs는 CPU에서 많이 느릴 수 있습니다.

## 4. FFmpeg shared build 설치

Whisper CLI는 `ffmpeg.exe`가 필요하고, WhisperX/pyannote/torchcodec은 Windows에서 FFmpeg DLL을 찾을 수 있어야 합니다. 일반 static build보다 shared build를 권장합니다.

1. <https://www.gyan.dev/ffmpeg/builds/> 접속
2. **주의**: 페이지 위쪽 `release builds`의 `ffmpeg-release-full-shared.7z`는 항상 "그 시점의 최신
   버전"을 가리키는 롤링 링크입니다(예: 지금 받으면 7.1.1이 아니라 9.0.1이 나옴) - 이 프로젝트가
   기본으로 가정하는 경로(`ffmpeg-7.1.1-full_build-shared`)와 버전이 어긋나므로, 페이지 아래쪽
   `release-archive` 섹션에서 **`ffmpeg-7.1.1-full_build-shared.zip`**(버전이 고정된 아카이브 빌드,
   확장자도 `.7z`가 아니라 `.zip`)을 받아야 합니다. 다른 버전을 쓰고 싶다면 아래 3~4단계의 경로/버전
   전체를 그 버전으로 맞추거나, `MEETINGNOTE_FFMPEG_BIN` 환경 변수로 실제 설치 경로를 지정하면 됩니다.
3. 예를 들어 아래 경로로 압축 해제

```text
D:\ffmpeg\ffmpeg-7.1.1-full_build-shared\
```

4. 현재 PowerShell 세션에 PATH 추가

```powershell
$env:PATH = "D:\ffmpeg\ffmpeg-7.1.1-full_build-shared\bin;$env:PATH"
$env:MEETINGNOTE_FFMPEG_BIN = "D:\ffmpeg\ffmpeg-7.1.1-full_build-shared\bin"
```

5. 앱에서 계속 사용할 영구 환경 변수로 저장하려면:

```powershell
setx MEETINGNOTE_FFMPEG_BIN "D:\ffmpeg\ffmpeg-7.1.1-full_build-shared\bin"
```

확인:

```powershell
ffmpeg -version
```

## 5. Whisper CLI 설치

OpenAI Whisper CLI는 로컬 Whisper 엔진입니다. 앱의 `Whisper CLI` 선택지에서 사용합니다.

```powershell
.\.venv-whisperx\Scripts\pip.exe install -U openai-whisper
```

설치 확인:

```powershell
.\.venv-whisperx\Scripts\whisper.exe --help
```

PATH 경고가 나와도 venv 안의 `.\.venv-whisperx\Scripts\whisper.exe`를 직접 호출하면 문제 없습니다.

샘플 실행:

```powershell
.\.venv-whisperx\Scripts\whisper.exe imports\sample.wav --model turbo --language ko --device cuda --output_format json --output_dir imports\whisper-cli-test
```

CPU로 실행하려면:

```powershell
.\.venv-whisperx\Scripts\whisper.exe imports\sample.wav --model base --language ko --device cpu --output_format json --output_dir imports\whisper-cli-cpu-test
```

## 6. WhisperX 설치

WhisperX는 Whisper 기반 STT에 정렬/alignment와 VAD를 더한 로컬 엔진입니다. 앱의 `WhisperX` 선택지에서 사용합니다.

```powershell
.\.venv-whisperx\Scripts\pip.exe install whisperx
```

설치 확인:

```powershell
$env:PATH = "D:\ffmpeg\ffmpeg-7.1.1-full_build-shared\bin;$env:PATH"
$env:MEETINGNOTE_FFMPEG_BIN = "D:\ffmpeg\ffmpeg-7.1.1-full_build-shared\bin"

.\.venv-whisperx\Scripts\python.exe -c "import torch, torchcodec, whisperx; print('cuda', torch.cuda.is_available()); print('whisperx ok')"
```

샘플 실행:

```powershell
$env:PATH = "D:\ffmpeg\ffmpeg-7.1.1-full_build-shared\bin;$env:PATH"
$env:MEETINGNOTE_FFMPEG_BIN = "D:\ffmpeg\ffmpeg-7.1.1-full_build-shared\bin"

.\.venv-whisperx\Scripts\whisperx.exe imports\sample.wav --model base --language ko --device cuda --compute_type float16 --output_format json --output_dir imports\whisperx-gpu-test
```

CPU로 실행하려면:

```powershell
.\.venv-whisperx\Scripts\whisperx.exe imports\sample.wav --model base --language ko --device cpu --compute_type int8 --output_format json --output_dir imports\whisperx-cpu-test
```

## 7. Demucs 설치

Demucs는 음악/배경음이 섞인 파일에서 `vocals.wav`를 분리하기 위해 사용합니다. 앱의 전처리 옵션 `Demucs`를 체크하면 STT 전에 음성 분리를 수행하고, 화면에서 원본 파형과 전처리 파형을 비교 재생할 수 있습니다.

```powershell
.\.venv-whisperx\Scripts\pip.exe install demucs
```

샘플 실행:

```powershell
.\.venv-whisperx\Scripts\python.exe -m demucs.separate --two-stems vocals -n htdemucs --device cuda -o imports\demucs-test imports\sample.wav
```

결과 파일:

```text
imports\demucs-test\htdemucs\sample\vocals.wav
imports\demucs-test\htdemucs\sample\no_vocals.wav
```

첫 실행 때는 Demucs 모델을 다운로드하므로 시간이 더 걸릴 수 있습니다.

## 8. 앱에서 사용하는 환경 변수

필수는 아니지만, 기본 경로와 다르게 설치했다면 아래 값을 설정합니다.

```powershell
setx MEETINGNOTE_WHISPERX_PYTHON "C:\Claude\MeetingNote\.venv-whisperx\Scripts\python.exe"
setx MEETINGNOTE_FFMPEG_BIN "D:\ffmpeg\ffmpeg-7.1.1-full_build-shared\bin"
setx MEETINGNOTE_DEMUCS_MODEL "htdemucs"
```

CPU/GPU는 이제 환경 변수가 아니라 앱 설정(Settings → "연산 장치")에서 고릅니다. Whisper CLI/WhisperX/Demucs
세 곳 모두 이 설정 하나를 따르며, WhisperX는 CPU를 고르면 compute type도 자동으로 `int8`로 전환됩니다
(`MEETINGNOTE_WHISPERX_DEVICE`/`MEETINGNOTE_WHISPERX_COMPUTE_TYPE`/`MEETINGNOTE_DEMUCS_DEVICE` 환경 변수는
더 이상 읽지 않습니다).

OpenAI Whisper API를 사용할 경우:

```powershell
setx OPENAI_API_KEY "sk-..."
```

## 9. 앱에서 STT 테스트하는 방법

1. `npm start` 또는 `npm run dev`로 앱 실행
2. 회의 편집 화면에서 오디오 파일 선택
3. `회의 음성 분석` 모달에서 전처리 옵션 선택
   - `Demucs`: 음악/반주에서 vocals만 분리
   - `DeNoise`: 간단한 noise gate
   - `정규화`: 음량 peak 기준 정규화
4. 엔진 선택
   - `Mock`: 실제 STT 없이 화면 테스트
   - `WhisperX`: 로컬 WhisperX GPU/CPU
   - `Whisper CLI`: 로컬 openai-whisper CLI
   - `Whisper API`: OpenAI Whisper API
5. 모델 선택 후 `분석 시작`
6. 분석 후 `전체 파형`에서 `원본`과 `전처리`를 체크해 비교 재생
7. `화자별 파형`은 전처리된 오디오 기준으로 표시

## Whisper CLI vs WhisperX 모델별 처리 시간

같은 오디오 파일 하나를 Whisper CLI 6개 모델(`tiny`/`base`/`small`/`medium`/`large-v3`/
`large-v3-turbo`)과 WhisperX 5개 모델(`tiny`/`base`/`small`/`medium`/`large-v3`)에 각각 돌려서
실제 처리 시간을 측정했습니다(`tools/e2e/benchmark-stt-models.mjs`, 앱이 실제로 쓰는
`transcribeLocalWhisperCli`/`transcribeLocalWhisperX` 함수를 그대로 호출 - 화자 분리 임베딩 추출까지
포함된 end-to-end 시간).

**측정 환경**

| 항목 | 값 |
|------|-----|
| CPU | Intel Core i5-14600KF (14코어/20스레드) |
| GPU | NVIDIA GeForce RTX 5070 (12GB VRAM, 드라이버 596.36) |
| RAM | 64GB |
| 연산 장치 | Settings → 연산 장치 = GPU (`cuda`) |
| 테스트 오디오 | `data/test-audio/diarize-2speaker-ko-en.wav` (16kHz mono, 35.16초, 한/영 2화자 대화) |

**결과**

| 프로바이더 | 모델 | 처리 시간 | 오디오 대비 배속 |
|------------|------|-----------|-------------------|
| Whisper CLI | tiny | 16.4초 | 2.14x |
| Whisper CLI | base | 15.9초 | 2.21x |
| Whisper CLI | small | 20.9초 | 1.68x |
| Whisper CLI | medium | 33.7초 | 1.04x |
| Whisper CLI | large-v3 | 53.2초 | 0.66x |
| Whisper CLI | large-v3-turbo | 18.6초 | 1.89x |
| WhisperX | tiny | 24.1초 | 1.46x |
| WhisperX | base | 22.5초 | 1.56x |
| WhisperX | small | 22.4초 | 1.57x |
| WhisperX | medium | 23.5초 | 1.50x |
| WhisperX | large-v3 | 25.0초 | 1.41x |

**관찰**

- Whisper CLI는 모델 크기에 거의 비례해서 느려집니다(`tiny` 16초 → `large-v3` 53초). 단
  `large-v3-turbo`는 대형 모델인데도 18.6초로 `small`보다 빨라서, 정확도가 필요하면
  `large-v3-turbo`가 `large-v3`보다 합리적인 선택입니다.
- WhisperX는 모델 크기와 거의 무관하게 22~25초로 평평합니다 - VAD·배치 디코딩·정렬 파이프라인의 고정
  오버헤드가 이 정도 길이(35초)의 클립에서는 모델 자체의 추론 시간보다 더 크게 작용하기 때문으로
  보입니다.
- 이 클립 길이(35초) 기준으로는 Whisper CLI의 tiny/base/large-v3-turbo가 WhisperX보다 절대 시간이
  더 빠릅니다. 다만 이 숫자에는 순수 추론 시간뿐 아니라 매번의 모델 로딩 시간도 포함돼 있습니다 -
  Whisper CLI/WhisperX 둘 다 호출마다 새 프로세스를 띄우고 모델을 처음부터 다시 로드하기 때문입니다
  (상주 프로세스 없음).
- **긴 회의에서는 이 로딩 비용이 줄어들지 않고 오히려 반복됩니다.** 앱의 실시간 분석은 녹음을 통째로
  한 번에 STT에 보내지 않고 약 60초 단위 청크로 잘라서 매 청크마다 별도로 STT를 호출합니다
  (`useChunkedAudioAnalysis.ts`의 `TARGET_CHUNK_MS`). 이 표의 측정 클립(35초, 1회 호출)은 그 청크
  하나 분량과 길이가 비슷하므로, 표의 숫자를 "청크 1개당 비용"으로 보면 됩니다 - 1시간 회의라면
  이 비용이 약 60회(3600초 ÷ 60초) 반복되는 셈이라, 오디오가 길어져도 청크당 로딩 비중은
  줄어들지 않습니다. 상주 프로세스로 모델을 한 번만 로드해두고 청크마다 재사용하는 구조로 바꾸면
  이 반복 비용을 없앨 수 있지만, 현재는 구현돼 있지 않습니다.
- 정확도(화자 분리 품질, 인식 정확도)는 이 표에 포함되지 않았습니다 - 순수 처리 시간만 비교한
  결과입니다.

### 청크 크기별 대본 완전성(단어 수) 검증

청크를 크게 잡으면 처리 시간은 줄어들지만(위 벤치마크), 혹시 한 번의 STT 호출에 너무 긴 오디오를
넣었을 때 Whisper가 대본 일부를 잘라서 돌려주지는 않는지 실제 단어 수를 세어 검증했습니다
(`tools/e2e/word-count-verify.mjs`). 같은 오디오를 청크 크기만 다르게 잘라서 STT를 호출한 뒤, 반환된
`transcriptSegments`의 텍스트를 모두 이어붙여 단어 수/글자 수를 비교하는 방식입니다.

| 오디오 | 청크 크기 | 청크 수 | 단어 수 | 글자 수 |
|--------|-----------|---------|---------|---------|
| `base-5min.wav` (3.95분, 1회 분량) | 15초 | 16 | 286 | 1,327 |
| `base-5min.wav` (3.95분, 1회 분량) | 120초(2분) | 2 | 330 | 1,556 |
| `triple-3x.wav` (11.85분, `base-5min.wav`를 3회 이어붙인 동일 내용) | 120초(2분) | 6 | 979 | 4,636 |
| `triple-3x.wav` (11.85분, `base-5min.wav`를 3회 이어붙인 동일 내용) | 240초(4분) | 3 | 991 | 4,688 |
| `triple-3x.wav` (11.85분, `base-5min.wav`를 3회 이어붙인 동일 내용) | 360초(6분) | 2 | 996 | 4,679 |

**관찰**

- 청크를 15초 → 120초로 키워도 단어 수가 줄지 않았습니다. 오히려 286개 → 330개로 늘었는데, 청크
  경계가 16개(15초)에서 2개(120초)로 줄면서 경계에서 잘려 나가던 문장이 줄어든 것으로 보입니다. 즉
  청크를 크게 잡아서 대본이 누락되는 현상은 관찰되지 않았고, 오히려 잘게 자를수록 경계 손실이 더
  큽니다.
- `triple-3x.wav`는 `base-5min.wav`를 그대로 3번 이어붙인 파일이라 이론적으로 단어 수는
  `base-5min.wav` 120초 결과(330개)의 3배(≈990개)여야 합니다. 실제 120/240/360초 결과(979~996개)가
  이 범위에 정확히 들어맞아, 청크를 2분·4분·6분까지 키워도 내용 손실이 없다는 것을 다시 확인했습니다.
- 이유는 Whisper가 한 번의 호출 안에서 긴 오디오를 내부적으로 30초 슬라이딩 윈도우로 나눠 처리하기
  때문입니다 - 즉 STT 결과가 실제로 잘릴 수 있는 지점은 청크 크기 자체가 아니라
  `TRANSCRIBE_TIMEOUT_MS`(`server/audio/sttLocalWhisperCli.mjs`, 현재 10분 - 한 번의 Whisper CLI
  호출이 이 시간을 넘기면 강제 종료됨)입니다.
- 원본 텍스트를 포함한 전체 결과: `data/test-audio/duration-bench/word-count-verify-result.json`.

### 회의 길이별 예상 회의록 작성 시간 (추정치)

지금까지 실측한 청크 크기별 처리 시간(위 두 절)과 실제 5/8/24/47/71분 회의록 생성 결과(음성 인식 →
발표 내용 정리 → 회의록 작성까지 이어지는 전체 파이프라인, `tools/e2e/generate-duration-meetings.mjs`)를
바탕으로 청크당 평균 처리 시간을 구하고, 그 값으로 10분/30분/1시간/2시간 회의의 예상 처리 시간을
계산했습니다 - 실측이 아니라 계산으로 뽑은 추정치입니다.

**계산에 쓴 청크당 평균 음성 인식(STT) 처리 시간(실측)**: 60초 청크 ≈ 23초, 120초 청크 ≈ 25초, 300초(5분)
청크 ≈ 38초. 발표 내용 정리(안건별 요약)는 안건 수에만 비례하고 회의 길이와 거의 무관하게 평균 ≈ 47초,
회의록 작성도 이번 세션에 전체 대본을 생략하도록 고친 뒤로는 회의 길이와 무관하게 평균 ≈ 17초로 측정돼,
두 값 모두 회의 길이에 상관없이 고정값으로 더했습니다.

| 회의 시간 | Chunk 크기 | 회의록 작성까지 걸리는 시간 (추정) |
|:---------:|:----------:|:-------------------------------------:|
| 10분 | 1분 (10개 청크) | 약 4.9분 |
| 30분 | 2분 (15개 청크) | 약 7.3분 |
| 1시간 | 5분 (12개 청크) | 약 8.7분 |
| 2시간 | 5분 (24개 청크) | 약 16.3분 |

**관찰**

- "Chunk 크기" 열은 회의 길이별로 실제 적용되는 청크 크기입니다(10분→1분, 30분→2분, 1시간·2시간→5분 -
  현재 `pickChunkSizeBounds`의 최대 티어가 5분이라 1시간을 넘어가도 청크 크기는 더 커지지 않습니다).
- 회의록 작성 단계가 이번 세션에 전체 대본을 생략하도록 고쳐지기 전이었다면 이 표의 "회의록 작성까지
  걸리는 시간" 열은 회의가 길어질수록 계속 늘어났을 것입니다(47분 회의에서 실제로 관찰된 회의록 품질
  저하 참고) - 지금은 발표 내용 정리·회의록 작성 둘 다 회의 길이와 무관한 고정 비용이라 표의 차이는 거의
  전적으로 음성 인식 청크 수 차이에서 나옵니다.

## 10. 트러블슈팅

### torch.cuda.is_available()가 False

- `nvidia-smi`가 정상인지 확인
- venv에 CPU용 PyTorch가 설치된 경우 GPU wheel로 다시 설치

```powershell
.\.venv-whisperx\Scripts\pip.exe uninstall -y torch torchaudio torchvision
.\.venv-whisperx\Scripts\pip.exe install torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
```

### torchcodec import 에러

대부분 FFmpeg shared DLL을 못 찾는 문제입니다.

```powershell
$env:PATH = "D:\ffmpeg\ffmpeg-7.1.1-full_build-shared\bin;$env:PATH"
$env:MEETINGNOTE_FFMPEG_BIN = "D:\ffmpeg\ffmpeg-7.1.1-full_build-shared\bin"
.\.venv-whisperx\Scripts\python.exe -c "import torchcodec; print('torchcodec ok')"
```

static build가 아니라 `full_build-shared` 계열을 사용해야 합니다.

### pip 설치 중 PATH warning

예:

```text
The script whisper.exe is installed in ...\Scripts which is not on PATH.
```

venv 안의 실행 파일을 직접 쓰면 됩니다.

```powershell
.\.venv-whisperx\Scripts\whisper.exe --help
```

### Demucs를 켰는데도 음악이 조금 들림

Demucs는 source separation 모델이라 완벽한 무음 제거기는 아닙니다. 보컬과 악기가 강하게 겹친 음원, 리버브가 많은 음원, 라이브 녹음에서는 반주 잔향이 남을 수 있습니다. 그래도 STT 입력은 `vocals.wav`를 사용하며, 앱에서는 분석 후 `원본`과 `전처리` 파형을 비교 재생할 수 있습니다.

### WhisperX가 너무 느림

- Settings → "연산 장치"에서 GPU가 선택되어 있는지 확인 (compute type은 자동으로 GPU=float16/CPU=int8로 맞춰짐)
- 작은 모델부터 테스트: `tiny`, `base`, `small`
- 화자 구간이 자주 끊기거나 너무 뭉친다면 Settings의 VAD onset/offset 값을 조정

## 빌드

```powershell
npm run build
```

## 저장소에 포함하지 않는 항목

아래 항목은 `.gitignore`로 제외합니다.

- `.venv-whisperx/`
- `node_modules/`
- `dist/`, `dist-electron/`
- `data/runtime/` (Settings 등 로컬 실행 상태)
- `imports/`, `exports/`
- `*.tsbuildinfo`, `*.log`, `tmp_*`

`data/db/`(회의록 DB)와 `data/attachments/`(첨부파일 원본)는 오히려 의도적으로 커밋됩니다 - 회의록이
참조하는 `materialPath`/`audioPath`가 실제로 존재해야 clone/pull한 환경에서도 첨부파일 열기·Markdown
변환본 보기가 정상 동작합니다. 새 회의록을 만들거나 첨부파일을 추가한 뒤에는 `data/db/`와
`data/attachments/`도 함께 커밋해야 합니다.
