import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Pause, Play, RotateCcw, RotateCw, SlidersHorizontal, Square, Users } from "lucide-react";
import { ModalShell } from "./ModalShell";
import type { AudioAnalysis, SttProviderId } from "../../types/domain";
import { computeEnvelope, decodeAudioFile, encodeWav, mixDownToMono } from "../../lib/audio";
import { base64ToBlob, registerVoiceProfileRequest, transcribeAudioRequest } from "../../lib/api";
import type { TranscribeResult } from "../../lib/api";

// Must match server/audio/diarize.mjs's UNREGISTERED_SPEAKER_PREFIX exactly - marks a speaker
// label whose auto-assigned name means "no voice profile matched yet", so renaming it here is
// what registers a brand-new profile (see handleComplete below).
const UNREGISTERED_SPEAKER_PREFIX = "미등록 화자 ";

interface AudioAnalysisModalProps {
  file: File;
  attendeeNames: string[];
  sttProvider: SttProviderId;
  onClose: () => void;
  onComplete: (analysis: AudioAnalysis) => void;
}

// Number of waveform buckets sampled across the whole clip - fine enough resolution for a
// wide modal without redrawing thousands of individual sample points.
const BUCKET_COUNT = 900;
const FULL_WAVE_HEIGHT = 90;
const LANE_WAVE_HEIGHT = 34;

const WAVE_COLOR = "#2f9e8f";
const TRACK_COLOR = "rgba(150, 150, 150, 0.12)";
const DIM_COLOR = "rgba(150, 150, 150, 0.15)";
// Gray for the already-analyzed portion of the waveform during analysis (WAVE_COLOR itself marks
// what's still ahead), so completed vs. remaining is visible at a glance instead of only via the
// moving analysis-progress line.
const PROGRESSED_WAVE_COLOR = "rgba(150, 150, 150, 0.55)";
const SEEK_STEP_SECONDS = 5;
const SEGMENT_EDGE_SECONDS = 0.06;
const SPEAKER_SEGMENT_PADDING_SECONDS = 0.35;

type PlaybackSource = "original" | "processed";

const STT_PROVIDER_OPTIONS: { id: SttProviderId; label: string }[] = [
  { id: "mock", label: "Mock" },
  { id: "local-whisperx", label: "WhisperX" },
  { id: "local-whisper-cli", label: "Whisper CLI" },
  { id: "openai-whisper", label: "Whisper API" },
  { id: "naver-clova", label: "Naver Clova" }
];

const STT_MODEL_OPTIONS_BY_PROVIDER: Record<SttProviderId, string[]> = {
  mock: ["mock"],
  "local-whisper-cli": ["turbo", "tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"],
  "local-whisperx": ["tiny", "base", "small", "medium", "large-v3"],
  "openai-whisper": ["whisper-1"],
  "naver-clova": ["default"]
};

function defaultSttModel(provider: SttProviderId): string {
  if (provider === "local-whisper-cli") {
    return "turbo";
  }
  if (provider === "local-whisperx") {
    return "base";
  }
  return STT_MODEL_OPTIONS_BY_PROVIDER[provider][0];
}

function formatMmSs(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function drawEnvelope(
  canvas: HTMLCanvasElement,
  envelope: Float32Array,
  containerWidth: number,
  height: number,
  activeMask?: boolean[],
  analysisProgressFraction?: number
) {
  const devicePixelRatio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(containerWidth));

  canvas.width = width * devicePixelRatio;
  canvas.height = height * devicePixelRatio;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = TRACK_COLOR;
  context.fillRect(0, 0, width, height);

  const bucketCount = envelope.length;
  if (bucketCount === 0) {
    return;
  }

  const barWidth = width / bucketCount;
  const midY = height / 2;

  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const value = envelope[bucketIndex];
    const barHeight = Math.max(1, value * height);
    const x = bucketIndex * barWidth;

    let fillColor: string;
    if (typeof analysisProgressFraction === "number") {
      const bucketFraction = bucketIndex / bucketCount;
      fillColor = bucketFraction <= analysisProgressFraction ? PROGRESSED_WAVE_COLOR : WAVE_COLOR;
    } else {
      const isActive = !activeMask || activeMask[bucketIndex];
      fillColor = isActive ? WAVE_COLOR : DIM_COLOR;
    }

    context.fillStyle = fillColor;
    context.fillRect(x, midY - barHeight / 2, Math.max(1, barWidth - 0.5), barHeight);
  }
}

interface WaveformCanvasProps {
  envelope: Float32Array;
  height: number;
  activeMask?: boolean[];
  currentTime?: number;
  durationSec?: number;
  // 0-100 - independent of playback, marks how far the STT job has progressed through the clip
  // so the user can see roughly where analysis currently is without waiting for it to finish.
  analysisProgressPercent?: number;
}

function WaveformCanvas({ envelope, height, activeMask, currentTime = 0, durationSec = 0, analysisProgressPercent }: WaveformCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const playheadPercent = durationSec > 0 ? Math.min(Math.max((currentTime / durationSec) * 100, 0), 100) : 0;

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) {
      return;
    }

    const analysisProgressFraction = typeof analysisProgressPercent === "number" ? analysisProgressPercent / 100 : undefined;

    const redraw = () => {
      if (container.clientWidth > 0) {
        drawEnvelope(canvas, envelope, container.clientWidth, height, activeMask, analysisProgressFraction);
      }
    };

    redraw();

    const observer = new ResizeObserver(redraw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [envelope, height, activeMask, analysisProgressPercent]);

  return (
    <div className="waveform-canvas-wrap" ref={containerRef} style={{ height }}>
      <canvas ref={canvasRef} />
      {durationSec > 0 && <span className="waveform-playhead" style={{ left: `${playheadPercent}%` }} />}
      {typeof analysisProgressPercent === "number" && (
        <span className="waveform-analysis-line" style={{ left: `${Math.min(Math.max(analysisProgressPercent, 0), 100)}%` }} />
      )}
    </div>
  );
}

export function AudioAnalysisModal({ file, attendeeNames, sttProvider, onClose, onComplete }: AudioAnalysisModalProps) {
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const sourceAudioBufferRef = useRef<AudioBuffer | null>(null);
  const analyzeAbortControllerRef = useRef<AbortController | null>(null);
  const sourceAudioUrlRef = useRef("");
  const processedAudioUrlRef = useRef("");
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [sourceEnvelope, setSourceEnvelope] = useState<Float32Array | null>(null);
  const [envelope, setEnvelope] = useState<Float32Array | null>(null);
  const [sourceAudioUrl, setSourceAudioUrl] = useState("");
  const [processedAudioUrl, setProcessedAudioUrl] = useState("");
  const [playbackSource, setPlaybackSource] = useState<PlaybackSource>("original");
  const [currentTime, setCurrentTime] = useState(0);
  // The <audio> element's own duration - not the Web Audio API-decoded AudioBuffer's duration
  // (durationSec/sourceDurationSec below). The two aren't guaranteed to agree exactly, and since
  // currentTime always comes from this same <audio> element, dividing it by a duration decoded
  // through a different pipeline is what let the playhead drift off the real playback position -
  // it has to be measured against its own element's duration to stay exactly in sync.
  const [audioElementDurationSec, setAudioElementDurationSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const [isDecoding, setIsDecoding] = useState(true);
  const [decodeError, setDecodeError] = useState("");

  const [vocalIsolation, setVocalIsolation] = useState(false);
  const [noiseRemoval, setNoiseRemoval] = useState(false);
  const [normalize, setNormalize] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<SttProviderId>(sttProvider);
  const [sttModel, setSttModel] = useState(defaultSttModel(sttProvider));

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState(0);
  const [analyzeError, setAnalyzeError] = useState("");
  const [result, setResult] = useState<TranscribeResult | null>(null);
  // Live segments parsed straight from the local STT process while it's still running - no
  // speaker label yet (diarization only runs once the whole job finishes), so the transcript
  // panel shows them plainly until `result` replaces them with the final, speaker-tagged list.
  const [liveSegments, setLiveSegments] = useState<{ startSec: number; endSec: number; text: string }[]>([]);
  const [editedSpeakerMap, setEditedSpeakerMap] = useState<Record<string, string>>({});

  function replaceProcessedAudioUrl(blob: Blob) {
    if (processedAudioUrlRef.current) {
      URL.revokeObjectURL(processedAudioUrlRef.current);
    }

    const nextUrl = URL.createObjectURL(blob);
    processedAudioUrlRef.current = nextUrl;
    setProcessedAudioUrl(nextUrl);
  }

  useEffect(() => {
    let cancelled = false;
    setIsDecoding(true);
    setDecodeError("");
    setCurrentTime(0);
    setIsPlaying(false);
    setActiveSpeaker(null);

    decodeAudioFile(file)
      .then((buffer) => {
        if (cancelled) {
          return;
        }
        sourceAudioBufferRef.current = buffer;
        const nextEnvelope = computeEnvelope(buffer, BUCKET_COUNT);
        setAudioBuffer(buffer);
        setSourceEnvelope(nextEnvelope);
        setEnvelope(nextEnvelope);
      })
      .catch(() => {
        if (!cancelled) {
          setDecodeError("오디오 파일을 읽을 수 없습니다.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsDecoding(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [file]);

  useEffect(() => {
    if (sourceAudioUrlRef.current) {
      URL.revokeObjectURL(sourceAudioUrlRef.current);
    }

    const nextUrl = URL.createObjectURL(file);
    sourceAudioUrlRef.current = nextUrl;
    setSourceAudioUrl(nextUrl);
    setProcessedAudioUrl("");
    setPlaybackSource("original");

    return () => {
      if (sourceAudioUrlRef.current) {
        URL.revokeObjectURL(sourceAudioUrlRef.current);
        sourceAudioUrlRef.current = "";
      }
      if (processedAudioUrlRef.current) {
        URL.revokeObjectURL(processedAudioUrlRef.current);
        processedAudioUrlRef.current = "";
      }
    };
  }, [file]);

  useEffect(() => {
    setSelectedProvider(sttProvider);
    setSttModel(defaultSttModel(sttProvider));
  }, [sttProvider]);

  const speakerLabels = useMemo(() => (result ? Object.keys(result.speakerMap) : []), [result]);

  // Approximation only: the source audio is not truly source-separated, so a lane simply
  // highlights the shared full-mix envelope wherever that speaker's turns fall in time.
  const speakerMasks = useMemo(() => {
    const masks: Record<string, boolean[]> = {};
    if (!result || !envelope) {
      return masks;
    }

    const duration = result.durationSec || audioBuffer?.duration || 0;
    const bucketCount = envelope.length;

    for (const label of speakerLabels) {
      const segments = result.transcriptSegments.filter((segment) => segment.speaker === label);
      const mask = new Array<boolean>(bucketCount).fill(false);

      for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
        const bucketStart = (bucketIndex / bucketCount) * duration;
        const bucketEnd = ((bucketIndex + 1) / bucketCount) * duration;
        mask[bucketIndex] = segments.some((segment) => bucketStart < segment.endSec && bucketEnd > segment.startSec);
      }

      masks[label] = mask;
    }

    return masks;
  }, [result, envelope, audioBuffer, speakerLabels]);

  const preprocessLocked = isAnalyzing;
  const durationSec = audioBuffer?.duration ?? 0;
  const sourceDurationSec = sourceAudioBufferRef.current?.duration ?? durationSec;
  const processedAudioAvailable = Boolean(processedAudioUrl);
  const activeAudioUrl = playbackSource === "processed" && processedAudioUrl ? processedAudioUrl : sourceAudioUrl;
  // Prefer the <audio> element's own duration over the Web Audio API-decoded AudioBuffer's
  // duration - see audioElementDurationSec above for why. Falls back to the buffer-decoded
  // duration before metadata has loaded (e.g. right after switching source).
  const playbackDurationSec = audioElementDurationSec || (playbackSource === "original" ? sourceDurationSec : durationSec);
  const sttModelOptions = STT_MODEL_OPTIONS_BY_PROVIDER[selectedProvider];

  function segmentsForSpeaker(label: string) {
    if (speakerLabels.length <= 1 && durationSec > 0) {
      return [{ startSec: 0, endSec: durationSec }];
    }

    return (result?.transcriptSegments ?? [])
      .filter((segment) => segment.speaker === label)
      .map((segment) => ({
        startSec: Math.max(0, segment.startSec - SPEAKER_SEGMENT_PADDING_SECONDS),
        endSec: Math.min(durationSec || segment.endSec, segment.endSec + SPEAKER_SEGMENT_PADDING_SECONDS)
      }))
      .sort((a, b) => a.startSec - b.startSec);
  }

  function segmentAtTime(label: string, seconds: number) {
    return segmentsForSpeaker(label).find((segment) => seconds >= segment.startSec && seconds < segment.endSec - SEGMENT_EDGE_SECONDS);
  }

  function nextSegmentForSpeaker(label: string, seconds: number) {
    const segments = segmentsForSpeaker(label);
    return segments.find((segment) => segment.endSec > seconds + SEGMENT_EDGE_SECONDS) ?? segments[0] ?? null;
  }

  useEffect(() => {
    const audio = audioElementRef.current;
    if (!audio) {
      return;
    }

    const handleTimeUpdate = () => {
      const time = audio.currentTime;
      setCurrentTime(time);

      if (!activeSpeaker || audio.paused) {
        return;
      }

      const activeSegment = segmentAtTime(activeSpeaker, time);
      if (activeSegment) {
        return;
      }

      const nextSegment = nextSegmentForSpeaker(activeSpeaker, time);
      if (nextSegment && nextSegment.startSec > time) {
        audio.currentTime = nextSegment.startSec;
        setCurrentTime(nextSegment.startSec);
        return;
      }

      audio.pause();
      setActiveSpeaker(null);
    };
    const handleEnded = () => {
      setIsPlaying(false);
      setActiveSpeaker(null);
    };
    const handlePause = () => setIsPlaying(false);
    const handlePlay = () => setIsPlaying(true);
    const handleDurationChange = () => setAudioElementDurationSec(Number.isFinite(audio.duration) ? audio.duration : 0);

    audio.addEventListener("timeupdate", handleTimeUpdate);
    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("pause", handlePause);
    audio.addEventListener("play", handlePlay);
    audio.addEventListener("durationchange", handleDurationChange);
    // durationchange may have already fired (metadata loaded) before this listener was attached.
    handleDurationChange();

    return () => {
      audio.removeEventListener("timeupdate", handleTimeUpdate);
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("pause", handlePause);
      audio.removeEventListener("durationchange", handleDurationChange);
      audio.removeEventListener("play", handlePlay);
    };
  }, [activeSpeaker, sourceAudioUrl, processedAudioUrl, playbackSource, result]);

  // The waveform playhead and the play/pause button both have to track the <audio> element's real
  // state as tightly as possible. The 'timeupdate'/'play'/'pause' events above are what the rest of
  // this component's logic (segment auto-advance, etc.) reacts to, but they're not a reliable
  // source for driving the UI on their own - browsers only guarantee 'timeupdate' fires "a few
  // times a second" and can throttle it further, and 'play'/'pause' have been observed not to fire
  // at all for some programmatic play() calls despite playback genuinely starting. Polling the
  // element's own `paused`/`currentTime` directly every frame instead sidesteps both problems: the
  // white bar and the play/pause icon can never end up stuck reflecting a stale event that never
  // arrived while the element itself is actually playing.
  useEffect(() => {
    let frameId: number;
    const tick = () => {
      const audio = audioElementRef.current;
      if (audio) {
        setIsPlaying(!audio.paused);
        if (!audio.paused) {
          setCurrentTime(audio.currentTime);
        }
      }
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frameId);
  }, []);

  function clearAnalysisResult() {
    setResult(null);
    setEditedSpeakerMap({});
    setLiveSegments([]);
  }

  function restoreOriginalAudioPreview() {
    const sourceAudioBuffer = sourceAudioBufferRef.current;
    if (sourceAudioBuffer) {
      const nextEnvelope = sourceEnvelope ?? computeEnvelope(sourceAudioBuffer, BUCKET_COUNT);
      setAudioBuffer(sourceAudioBuffer);
      setEnvelope(nextEnvelope);
    }
    if (processedAudioUrlRef.current) {
      URL.revokeObjectURL(processedAudioUrlRef.current);
      processedAudioUrlRef.current = "";
    }
    setProcessedAudioUrl("");
    setPlaybackSource("original");
    resetPlaybackPosition();
  }

  function handleProviderChange(provider: SttProviderId) {
    setSelectedProvider(provider);
    setSttModel(defaultSttModel(provider));
    clearAnalysisResult();
    restoreOriginalAudioPreview();
  }

  function handleModelChange(model: string) {
    setSttModel(model);
    clearAnalysisResult();
    restoreOriginalAudioPreview();
  }

  function handleVocalIsolationChange(checked: boolean) {
    setVocalIsolation(checked);
    clearAnalysisResult();
    restoreOriginalAudioPreview();
  }

  function handleNoiseRemovalChange(checked: boolean) {
    setNoiseRemoval(checked);
    clearAnalysisResult();
    restoreOriginalAudioPreview();
  }

  function handleNormalizeChange(checked: boolean) {
    setNormalize(checked);
    clearAnalysisResult();
    restoreOriginalAudioPreview();
  }

  function handlePlaybackSourceChange(source: PlaybackSource) {
    if (source === "processed" && !processedAudioAvailable) {
      return;
    }

    resetPlaybackPosition();
    setPlaybackSource(source);
  }

  function seekBy(deltaSeconds: number) {
    const audio = audioElementRef.current;
    if (!audio) {
      return;
    }

    seekTo(audio.currentTime + deltaSeconds);
  }

  function seekTo(seconds: number) {
    const audio = audioElementRef.current;
    if (!audio) {
      setCurrentTime(Math.min(Math.max(seconds, 0), durationSec));
      return;
    }

    const nextTime = Math.min(Math.max(seconds, 0), playbackDurationSec || audio.duration || 0);
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  }

  function resetPlaybackPosition() {
    const audio = audioElementRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    setActiveSpeaker(null);
    setCurrentTime(0);
    setIsPlaying(false);
  }

  async function togglePlayback() {
    const audio = audioElementRef.current;
    if (!audio) {
      return;
    }

    if (audio.paused) {
      setActiveSpeaker(null);
      await audio.play();
      return;
    }

    setActiveSpeaker(null);
    audio.pause();
  }

  async function toggleSpeakerPlayback(label: string) {
    const audio = audioElementRef.current;
    if (!audio) {
      return;
    }

    if (!audio.paused && activeSpeaker === label) {
      audio.pause();
      setActiveSpeaker(null);
      return;
    }

    const current = audio.currentTime;
    const currentSegment = segmentAtTime(label, current);
    const targetSegment = currentSegment ?? nextSegmentForSpeaker(label, current);
    if (!targetSegment) {
      return;
    }

    setActiveSpeaker(label);
    if (playbackSource !== "processed" && processedAudioAvailable) {
      setPlaybackSource("processed");
      setCurrentTime(targetSegment.startSec);
      requestAnimationFrame(() => {
        const nextAudio = audioElementRef.current;
        if (!nextAudio) {
          return;
        }
        nextAudio.currentTime = targetSegment.startSec;
        void nextAudio.play();
      });
      return;
    }

    if (!currentSegment) {
      audio.currentTime = targetSegment.startSec;
      setCurrentTime(targetSegment.startSec);
    }
    await audio.play();
  }

  async function handleAnalyze() {
    if (!audioBuffer) {
      return;
    }

    setIsAnalyzing(true);
    setAnalyzeProgress(0);
    setAnalyzeError("");
    setLiveSegments([]);

    const abortController = new AbortController();
    analyzeAbortControllerRef.current = abortController;

    try {
      resetPlaybackPosition();
      const sourceAudioBuffer = sourceAudioBufferRef.current ?? audioBuffer;
      // 정규화/DeNoise no longer run here - the server applies the full Demucs -> 정규화 -> DeNoise
      // chain in that fixed order (see server/audio/audioPreprocess.mjs), which requires Demucs to
      // see this untouched original mixdown for the cleanest vocal separation. What gets uploaded
      // here is just a format conversion (decoded audio -> WAV), not preprocessing.
      const mono = mixDownToMono(sourceAudioBuffer);
      const wavBlob = encodeWav(mono, sourceAudioBuffer.sampleRate);
      const analysis = await transcribeAudioRequest({
        provider: selectedProvider,
        model: sttModel,
        audioBlob: wavBlob,
        fileName: file.name,
        durationSec: sourceAudioBuffer.duration,
        preprocessing: { vocalIsolation, noiseRemoval, normalize },
        attendeeNames,
        onProgress: setAnalyzeProgress,
        onPartialSegments: setLiveSegments,
        signal: abortController.signal
      });

      const processedAudioBlob = analysis.processedAudioBase64
        ? base64ToBlob(analysis.processedAudioBase64, analysis.processedAudioMimeType ?? "audio/wav")
        : wavBlob;
      const processedAudioBuffer = await decodeAudioFile(processedAudioBlob);
      setAudioBuffer(processedAudioBuffer);
      setEnvelope(computeEnvelope(processedAudioBuffer, BUCKET_COUNT));
      replaceProcessedAudioUrl(processedAudioBlob);
      setPlaybackSource("processed");

      setResult(analysis);
      setEditedSpeakerMap({ ...analysis.speakerMap });
      resetPlaybackPosition();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setAnalyzeError("사용자가 분석을 중지했습니다.");
      } else {
        setAnalyzeError(error instanceof Error ? error.message : "분석 중 오류가 발생했습니다.");
      }
    } finally {
      setIsAnalyzing(false);
      analyzeAbortControllerRef.current = null;
    }
  }

  function handleStopAnalyze() {
    analyzeAbortControllerRef.current?.abort();
  }

  function speakerOptions(label: string): string[] {
    const values = new Set<string>();
    const autoValue = result?.speakerMap[label];

    if (autoValue) {
      values.add(autoValue);
    }
    for (const name of attendeeNames) {
      if (name) {
        values.add(name);
      }
    }

    return Array.from(values);
  }

  async function handleComplete() {
    if (!result) {
      return;
    }
    const { processedAudioBase64, processedAudioMimeType, processedFileName, speakerEmbeddings, ...persistableResult } = result;
    void processedAudioBase64;
    void processedAudioMimeType;
    void processedFileName;

    // A "미등록" speaker the user just renamed to a real name registers a brand-new voice profile
    // - a confirmed match during diarization itself already registered automatically server-side
    // (see assignSpeakersWithProfiles), so this only ever fires for speakers that had no match.
    if (speakerEmbeddings) {
      for (const [label, autoName] of Object.entries(result.speakerMap)) {
        const finalName = editedSpeakerMap[label];
        const embedding = speakerEmbeddings[label];

        if (autoName.startsWith(UNREGISTERED_SPEAKER_PREFIX) && finalName && finalName !== autoName && embedding) {
          try {
            await registerVoiceProfileRequest(finalName, embedding);
          } catch {
            // Best-effort - a registration failure shouldn't block saving the meeting itself.
          }
        }
      }
    }

    onComplete({ ...(persistableResult as AudioAnalysis), speakerMap: editedSpeakerMap });
    onClose();
  }

  return (
    <ModalShell
      title="회의 음성 분석"
      onClose={onClose}
      width="xwide"
      footer={
        <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
          <button className="ghost-action" onClick={onClose} type="button">
            취소
          </button>
          <button className="primary-action" disabled={!result} onClick={handleComplete} type="button">
            완료 (대본 저장)
          </button>
        </div>
      }
    >
      {isDecoding && <div className="audio-analysis-status">오디오 파일을 분석 준비 중입니다...</div>}
      {!isDecoding && decodeError && <div className="audio-analysis-status error">{decodeError}</div>}

      {!isDecoding && !decodeError && audioBuffer && sourceEnvelope && envelope && (
        <div className="audio-analysis-layout">
          <div className="audio-analysis-transcript-panel">
            <div className="waveform-window-title">
              <FileText size={16} />
              발언 대본
            </div>

            {!result && liveSegments.length === 0 && (
              <p className="audio-analysis-placeholder">분석 시작 버튼을 누르면 시간과 발언 내용이 여기에 표시됩니다.</p>
            )}

            {result && (
              <ul className="audio-analysis-transcript-list">
                {result.transcriptSegments.map((segment, index) => (
                  <li className="audio-analysis-transcript-row" key={`${segment.speaker}-${index}`}>
                    <div className="audio-analysis-transcript-meta">
                      <span className="audio-analysis-transcript-time">
                        {formatMmSs(segment.startSec)}-{formatMmSs(segment.endSec)}
                      </span>
                      <span className="audio-analysis-transcript-speaker">{editedSpeakerMap[segment.speaker] ?? segment.speaker}</span>
                    </div>
                    <p className="audio-analysis-transcript-text">{segment.text}</p>
                  </li>
                ))}
              </ul>
            )}

            {!result && liveSegments.length > 0 && (
              <ul className="audio-analysis-transcript-list">
                {liveSegments.map((segment, index) => (
                  <li className="audio-analysis-transcript-row" key={`live-${index}`}>
                    <div className="audio-analysis-transcript-meta">
                      <span className="audio-analysis-transcript-time">
                        {formatMmSs(segment.startSec)}-{formatMmSs(segment.endSec)}
                      </span>
                      <span className="audio-analysis-transcript-speaker">인식 중...</span>
                    </div>
                    <p className="audio-analysis-transcript-text">{segment.text}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="audio-analysis-main">
            <section className="waveform-window">
              <div className="audio-preprocess-header">
                <div className="waveform-window-title">
                  <SlidersHorizontal size={16} />
                  전처리 옵션
                </div>
                <span className="field-hint">선택한 항목은 Demucs → 정규화 → DeNoise 순서로 적용됩니다.</span>
              </div>

              <div className="audio-stt-control-row">
                <div className="audio-preprocess-options">
                  <label className="export-archive-option compact">
                    <input
                      checked={vocalIsolation}
                      disabled={preprocessLocked || selectedProvider === "mock"}
                      onChange={(event) => handleVocalIsolationChange(event.target.checked)}
                      type="checkbox"
                    />
                    <span>
                      <strong>Demucs</strong>
                    </span>
                  </label>

                  <label className="export-archive-option compact">
                    <input
                      checked={normalize}
                      disabled={preprocessLocked || selectedProvider === "mock"}
                      onChange={(event) => handleNormalizeChange(event.target.checked)}
                      type="checkbox"
                    />
                    <span>
                      <strong>정규화</strong>
                    </span>
                  </label>

                  <label className="export-archive-option compact">
                    <input
                      checked={noiseRemoval}
                      disabled={preprocessLocked || selectedProvider === "mock"}
                      onChange={(event) => handleNoiseRemovalChange(event.target.checked)}
                      type="checkbox"
                    />
                    <span>
                      <strong>DeNoise</strong>
                    </span>
                  </label>
                </div>

                <label className="stt-model-picker">
                  <span>엔진</span>
                  <select disabled={isAnalyzing} onChange={(event) => handleProviderChange(event.target.value as SttProviderId)} value={selectedProvider}>
                    {STT_PROVIDER_OPTIONS.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="stt-model-picker">
                  <span>모델</span>
                  <select
                    disabled={isAnalyzing || sttModelOptions.length < 2}
                    onChange={(event) => handleModelChange(event.target.value)}
                    value={sttModel}
                  >
                    {sttModelOptions.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>

            <section className="waveform-window">
              <div className="waveform-window-title">전체 파형</div>
              <div className="audio-waveform-compare">
                <label className={`audio-waveform-choice ${playbackSource === "original" ? "active" : ""}`}>
                  <input
                    checked={playbackSource === "original"}
                    onChange={() => handlePlaybackSourceChange("original")}
                    type="checkbox"
                  />
                  <span className="audio-waveform-choice-label">원본</span>
                  <WaveformCanvas
                    analysisProgressPercent={isAnalyzing ? analyzeProgress : undefined}
                    currentTime={currentTime}
                    durationSec={playbackSource === "original" ? playbackDurationSec : sourceDurationSec}
                    envelope={sourceEnvelope}
                    height={FULL_WAVE_HEIGHT}
                  />
                </label>

                {processedAudioAvailable && (
                  <label className={`audio-waveform-choice ${playbackSource === "processed" ? "active" : ""}`}>
                    <input
                      checked={playbackSource === "processed"}
                      onChange={() => handlePlaybackSourceChange("processed")}
                      type="checkbox"
                    />
                    <span className="audio-waveform-choice-label">전처리</span>
                    <WaveformCanvas
                      currentTime={currentTime}
                      durationSec={playbackSource === "processed" ? playbackDurationSec : durationSec}
                      envelope={envelope}
                      height={FULL_WAVE_HEIGHT}
                    />
                  </label>
                )}
              </div>
              {activeAudioUrl && (
                <>
                  <audio ref={audioElementRef} src={activeAudioUrl} />
                  <input
                    aria-label="재생 위치"
                    className="audio-scrub-slider"
                    disabled={!playbackDurationSec}
                    max={playbackDurationSec || 0}
                    min={0}
                    onChange={(event) => seekTo(Number(event.target.value))}
                    onInput={(event) => seekTo(Number(event.currentTarget.value))}
                    step={0.1}
                    type="range"
                    value={Math.min(currentTime, playbackDurationSec || 0)}
                  />
                  <div className="audio-playback-controls">
                    <div className="audio-playback-left">
                      <button className="icon-control-button" onClick={() => seekBy(-SEEK_STEP_SECONDS)} title="5초 뒤로" type="button">
                        <RotateCcw size={17} />
                      </button>
                      <button className="icon-control-button primary" onClick={togglePlayback} title={isPlaying ? "일시정지" : "재생"} type="button">
                        {isPlaying ? <Pause size={18} /> : <Play size={18} />}
                      </button>
                      <button className="icon-control-button" onClick={() => seekBy(SEEK_STEP_SECONDS)} title="5초 앞으로" type="button">
                        <RotateCw size={17} />
                      </button>
                      <span className="audio-playback-time">
                        {formatMmSs(currentTime)} / {formatMmSs(playbackDurationSec)}
                      </span>
                    </div>
                    <div className="audio-playback-right">
                      {isAnalyzing && (
                        <button className="danger-action" onClick={handleStopAnalyze} title="분석 중지" type="button">
                          <Square size={14} />
                          중지
                        </button>
                      )}
                      <button
                        className={isAnalyzing ? "primary-action analyze-progress-button" : "primary-action"}
                        disabled={!audioBuffer || isAnalyzing}
                        onClick={handleAnalyze}
                        style={isAnalyzing ? { ["--analyze-progress" as string]: `${analyzeProgress}%` } : undefined}
                        type="button"
                      >
                        {isAnalyzing ? `분석 중... ${analyzeProgress}%` : "분석 시작"}
                      </button>
                    </div>
                  </div>
                  {analyzeError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{analyzeError}</span>}
                </>
              )}
            </section>

            {result && (
              <section className="waveform-window">
                <div className="waveform-window-title">
                  <Users size={16} />
                  화자별 파형
                </div>

                <div className="speaker-lanes">
                  {speakerLabels.map((label, index) => (
                    <div className="speaker-lane-row" key={label}>
                      <div className="speaker-lane-chip">{index + 1}</div>
                      <input
                        list={`speaker-options-${index}`}
                        onChange={(event) => setEditedSpeakerMap((prev) => ({ ...prev, [label]: event.target.value }))}
                        placeholder="화자 이름"
                        type="text"
                        value={editedSpeakerMap[label] ?? ""}
                      />
                      <datalist id={`speaker-options-${index}`}>
                        {speakerOptions(label).map((name) => (
                          <option key={name} value={name} />
                        ))}
                      </datalist>
                      <button
                        className="speaker-lane-play-button"
                        onClick={() => toggleSpeakerPlayback(label)}
                        title={isPlaying && activeSpeaker === label ? "일시정지" : "재생"}
                        type="button"
                      >
                        {isPlaying && activeSpeaker === label ? <Pause size={15} /> : <Play size={15} />}
                      </button>
                      <WaveformCanvas
                        activeMask={speakerMasks[label]}
                        currentTime={currentTime}
                        durationSec={playbackSource === "processed" ? playbackDurationSec : durationSec}
                        envelope={envelope}
                        height={LANE_WAVE_HEIGHT}
                      />
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      )}
    </ModalShell>
  );
}
