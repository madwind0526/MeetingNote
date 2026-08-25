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
