import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Mic, Pause, Play, RotateCcw, RotateCw, SlidersHorizontal, Square, Upload, Users } from "lucide-react";
import { ModalShell } from "./ModalShell";
import type { AudioAnalysis, SttProviderId } from "../../types/domain";
import { computeEnvelope, decodeAudioFile } from "../../lib/audio";
import { registerVoiceProfileRequest, rematchSpeakerProfilesRequest } from "../../lib/api";
import { saveDictionary } from "../../lib/dictionary";
import type { DictionaryState } from "../../lib/dictionary";
import { parseTranscriptText } from "../../lib/transcript";
import { UNREGISTERED_SPEAKER_PREFIX } from "../../lib/speakerSessionLinking";
import { isSystemAudioCaptureSupported, startSystemAudioCapture } from "../../lib/systemAudioCapture";
import type { SystemAudioCapture } from "../../lib/systemAudioCapture";
import { useChunkedAudioAnalysis } from "../../hooks/useChunkedAudioAnalysis";
import type { ChunkMinutesOverrides } from "../../hooks/useChunkedAudioAnalysis";
import { LiveWaveform } from "../LiveWaveform";

type AudioSource = { kind: "file"; file: File } | { kind: "recording" };

interface AudioAnalysisModalProps {
  source: AudioSource;
  // Already-saved analysis for this meeting's audio (edit mode reopening "분석 시작"/"화자 분리"
  // on a file that's already been analyzed once) - auto-loaded into the transcript panel on mount
  // (see the loadExternalTranscript effect below) so the user isn't staring at an empty popup
  // just to look at or correct an already-produced transcript. No speakerEmbeddings here (that
  // field never gets persisted, see handleComplete), so a session reopened this way has nothing
  // for "다시 화자 분리" to re-match against until a fresh "분석 시작" run repopulates them.
  existingAnalysis?: AudioAnalysis;
  attendeeNames: string[];
  // Agenda order + 발표 시간(분) - passed straight through to transcribeAudioRequest as a soft
  // voice-matching hint (see server/audio/diarize.mjs). Optional since a brand-new meeting can
  // have no agenda rows yet.
  agenda?: { no: number; durationMinutes: number; presenter: string }[];
  sttProvider: SttProviderId;
  // Settings' 무음 임계값 (silenceThreshold) - see useChunkedAudioAnalysis's
  // DEFAULT_SILENCE_RMS_THRESHOLD. Optional so a caller that hasn't threaded it through yet still
  // falls back to that default.
  silenceThreshold?: number;
  // Settings' 회의 길이별 STT 청크 크기 fields, already parsed to numbers (see
  // useChunkedAudioAnalysis's parseChunkMinutesSetting) - optional per-tier so a caller that
  // hasn't threaded it through, or a blank field, falls back to pickChunkSizeBounds's own default.
  chunkMinutesOverrides?: ChunkMinutesOverrides;
  // The word-correction popup (수정 사전 등록) reads/writes through this shared cache - see
  // MeetingFormModal/App.tsx - instead of fetching its own copy, which would silently diverge
  // from whatever the Dictionary modal has open in the same session and risk one clobbering the
  // other's write.
  dictionary: DictionaryState;
  onDictionaryChange: (next: DictionaryState) => void;
  onClose: () => void;
  onComplete: (analysis: AudioAnalysis) => void | Promise<void>;
  // Fired once for source.kind === "recording", the moment the recorded segments are stitched
  // into one final playable File (recording stopped and every queued chunk finished) - lets
  // MeetingFormModal retain it as the attachment exactly like a picked file (see
  // handleStopSystemRecording's old setPendingAudioFile call, now moved here).
  onRecordingFinalized?: (file: File) => void;
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
// Distinct from WAVE_COLOR (teal) on purpose - marks the segment whose transcript text was just
// clicked, on the full-clip waveform (see handleTranscriptRowClick below).
const HIGHLIGHT_COLOR = "#e6a23c";
const SEEK_STEP_SECONDS = 5;
const SEGMENT_EDGE_SECONDS = 0.06;
const SPEAKER_SEGMENT_PADDING_SECONDS = 0.35;
const PLAYBACK_VISUAL_LATENCY_SECONDS = 0.12;

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
  analysisProgressFraction?: number,
  durationSec?: number,
  highlightRange?: { startSec: number; endSec: number }
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

    if (highlightRange && durationSec && durationSec > 0) {
      const bucketStartTime = (bucketIndex / bucketCount) * durationSec;
      const bucketEndTime = ((bucketIndex + 1) / bucketCount) * durationSec;
      if (bucketStartTime < highlightRange.endSec && bucketEndTime > highlightRange.startSec) {
        fillColor = HIGHLIGHT_COLOR;
      }
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
  // Marks the clicked transcript segment's time range in a distinct color (see
  // handleTranscriptRowClick) - only meaningful together with durationSec.
  highlightRange?: { startSec: number; endSec: number };
}

function WaveformCanvas({
  envelope,
  height,
  activeMask,
  currentTime = 0,
  durationSec = 0,
  analysisProgressPercent,
  highlightRange
}: WaveformCanvasProps) {
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
        drawEnvelope(canvas, envelope, container.clientWidth, height, activeMask, analysisProgressFraction, durationSec, highlightRange);
      }
    };

    redraw();

    const observer = new ResizeObserver(redraw);
    observer.observe(container);
    return () => observer.disconnect();
  }, [envelope, height, activeMask, analysisProgressPercent, durationSec, highlightRange]);

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

// Splits transcript text into whitespace-separated tokens so each word can carry its own
// right-click handler - the corrected-word popup this opens registers a 수정 사전 entry (see
// AudioAnalysisModal's handleWordContextMenu/handleSaveCorrection below).
function EditableTranscriptText({ text, onWordContextMenu }: { text: string; onWordContextMenu: (event: React.MouseEvent, word: string) => void }) {
  return (
    <p className="audio-analysis-transcript-text">
      {text.split(/(\s+)/).map((token, index) =>
        token.trim() ? (
          <span className="transcript-editable-word" key={index} onContextMenu={(event) => onWordContextMenu(event, token)}>
            {token}
          </span>
        ) : (
          token
        )
      )}
    </p>
  );
}

export function AudioAnalysisModal({
  source,
  existingAnalysis,
  attendeeNames,
  agenda,
  sttProvider,
  silenceThreshold,
  chunkMinutesOverrides,
  dictionary,
  onDictionaryChange,
  onClose,
  onComplete,
  onRecordingFinalized
}: AudioAnalysisModalProps) {
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const activeTranscriptRowRef = useRef<HTMLLIElement | null>(null);
  const sourceAudioBufferRef = useRef<AudioBuffer | null>(null);
  const sourceAudioUrlRef = useRef("");
  const processedAudioUrlRef = useRef("");

  // ---------- Chunked/progressive analysis (shared engine for both file and recording) ----------
  const analysis = useChunkedAudioAnalysis();

  // ---------- Recording mode: capture starts as soon as the modal mounts, independent of
  // whether chunked analysis has been started yet (see handleStartRecordingAnalyze) ----------
  const captureRef = useRef<SystemAudioCapture | null>(null);
  const [capture, setCapture] = useState<SystemAudioCapture | null>(null);
  const [isRecordingActive, setIsRecordingActive] = useState(source.kind === "recording");
  const [recordingElapsedSec, setRecordingElapsedSec] = useState(0);
  const [captureError, setCaptureError] = useState("");
  const [recordedFile, setRecordedFile] = useState<File | null>(null);
  const [hasStartedRecordingAnalysis, setHasStartedRecordingAnalysis] = useState(false);

  // The file this modal is actually working with right now - a picked file immediately, or the
  // stitched recording once it's ready (null the whole time recording is still in progress).
  const activeFile = source.kind === "file" ? source.file : recordedFile;

  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [sourceEnvelope, setSourceEnvelope] = useState<Float32Array | null>(null);
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
  const [isDecoding, setIsDecoding] = useState(source.kind === "file");
  const [decodeError, setDecodeError] = useState("");

  const [vocalIsolation, setVocalIsolation] = useState(false);
  const [noiseRemoval, setNoiseRemoval] = useState(false);
  const [normalize, setNormalize] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<SttProviderId>(sttProvider);
  const [sttModel, setSttModel] = useState(defaultSttModel(sttProvider));

  const {
    result,
    liveSegments,
    envelope: processedEnvelope,
    isAnalyzing,
    analyzeProgress,
    analyzeError,
    queuedChunkCount,
    processedChunkCount
  } = analysis;
  const [editedSpeakerMap, setEditedSpeakerMap] = useState<Record<string, string>>({});

  // 화자 이름을 고치는 즉시(입력창 포커스 아웃) 그 라벨의 embedding으로 음성 프로필을 등록/보강한다 -
  // "화자 분리" 버튼을 누르기 전에도 프로필이 쌓이도록. 같은 세션에서 같은 (label, name) 조합을 반복
  // 등록하지 않도록 추적만 하고, 실패해도 조용히 무시(최선 노력 - handleComplete의 기존 등록 로직이
  // 그물망 역할을 한다).
  const registeredProfileKeysRef = useRef<Set<string>>(new Set());
  const [isRematchingSpeakers, setIsRematchingSpeakers] = useState(false);
  const [rematchError, setRematchError] = useState("");

  async function registerProfileForLabel(label: string, name: string) {
    const embedding = result?.speakerEmbeddings?.[label];
    if (!name || !embedding) {
      return;
    }

    const key = `${label}::${name}`;
    if (registeredProfileKeysRef.current.has(key)) {
      return;
    }
    registeredProfileKeysRef.current.add(key);

    try {
      await registerVoiceProfileRequest(name, embedding);
    } catch {
      // best-effort - handleComplete registers unregistered-speaker renames again on save
    }
  }

  // Renaming a whole label (this input) can end up with the same display name as some OTHER
  // label - typically because a per-segment edit (commitSegmentSpeakerName) already minted a
  // brand-new label with that name for one utterance before this label got renamed to match it.
  // Rather than leaving two entries under the same name, fold the other label(s) into this one:
  // every segment on them moves here and their speakerMap entries are dropped.
  function mergeDuplicateLabelsInto(label: string, name: string) {
    const duplicates = speakerLabels.filter((other) => other !== label && (editedSpeakerMap[other] ?? other) === name);
    if (duplicates.length === 0) {
      return;
    }

    analysis.mergeSpeakerLabels(duplicates, label);
    setEditedSpeakerMap((prev) => {
      const next = { ...prev };
      for (const duplicate of duplicates) {
        delete next[duplicate];
      }
      return next;
    });
  }

  async function handleSpeakerNameBlur(label: string) {
    const name = editedSpeakerMap[label]?.trim();
    if (!name) {
      return;
    }
    mergeDuplicateLabelsInto(label, name);
    await registerProfileForLabel(label, name);
  }

  // "화자 분리": re-matches every label's already-known embedding against the voice-profile
  // registry as it stands right now (including whatever handleSpeakerNameBlur just registered),
  // so a label that was "미등록"/wrong can flip to a name reinforced earlier in this same session.
  async function handleRematchSpeakers() {
    if (!result?.speakerEmbeddings) {
      return;
    }

    setIsRematchingSpeakers(true);
    setRematchError("");

    try {
      const speakerMap = await rematchSpeakerProfilesRequest(result.speakerEmbeddings, attendeeNames);
      setEditedSpeakerMap((prev) => {
        const next = { ...prev };
        for (const [label, matchedName] of Object.entries(speakerMap)) {
          if (matchedName) {
            next[label] = matchedName;
          }
        }
        return next;
      });
    } catch (error) {
      setRematchError(error instanceof Error ? error.message : "화자 재매칭에 실패했습니다.");
    } finally {
      setIsRematchingSpeakers(false);
    }
  }

  // 발언 대본 word right-click -> "수정하기" 메뉴 -> 수정 사전 등록 (see EditableTranscriptText above).
  const [wordContextMenu, setWordContextMenu] = useState<{ x: number; y: number; word: string } | null>(null);
  const [correctionDraft, setCorrectionDraft] = useState<{ from: string; to: string } | null>(null);
  const [isSavingCorrection, setIsSavingCorrection] = useState(false);
  const [correctionError, setCorrectionError] = useState("");

  // 발언 대본 불러오기 - loads an already-made transcript instead of running STT (see parseTranscriptText).
  const transcriptFileInputRef = useRef<HTMLInputElement | null>(null);
  const [transcriptLoadError, setTranscriptLoadError] = useState("");

  function replaceProcessedAudioUrl(blob: Blob) {
    if (processedAudioUrlRef.current) {
      URL.revokeObjectURL(processedAudioUrlRef.current);
    }

    const nextUrl = URL.createObjectURL(blob);
    processedAudioUrlRef.current = nextUrl;
    setProcessedAudioUrl(nextUrl);
  }

  // Recording mode: start capturing as soon as the modal mounts (before "분석 시작" is ever
  // clicked) so the live waveform is visible immediately, matching the file-mode popup already
  // showing the original waveform as soon as it opens.
  useEffect(() => {
    if (source.kind !== "recording") {
      return;
    }

    let cancelled = false;

    if (!isSystemAudioCaptureSupported()) {
      setCaptureError("이 환경에서는 PC 소리 녹음을 지원하지 않습니다.");
      setIsRecordingActive(false);
      return;
    }

    startSystemAudioCapture((message) => {
      if (!cancelled) {
        setCaptureError(message);
      }
    })
      .then((next) => {
        if (cancelled) {
          void next.stopAll();
          return;
        }
        captureRef.current = next;
        setCapture(next);
      })
      .catch((error) => {
        if (!cancelled) {
          setCaptureError(error instanceof Error ? error.message : "PC 소리 녹음을 시작하지 못했습니다.");
          setIsRecordingActive(false);
        }
      });

    return () => {
      cancelled = true;
      void captureRef.current?.stopAll();
      captureRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isRecordingActive || !hasStartedRecordingAnalysis) {
      return;
    }

    const timer = window.setInterval(() => setRecordingElapsedSec((current) => current + 1), 1000);
    return () => window.clearInterval(timer);
  }, [isRecordingActive, hasStartedRecordingAnalysis]);

  useEffect(() => {
    if (!activeFile) {
      return;
    }

    let cancelled = false;
    setIsDecoding(true);
    setDecodeError("");
    setCurrentTime(0);
    setIsPlaying(false);
    setActiveSpeaker(null);

    decodeAudioFile(activeFile)
      .then((buffer) => {
        if (cancelled) {
          return;
        }
        sourceAudioBufferRef.current = buffer;
        const nextEnvelope = computeEnvelope(buffer, BUCKET_COUNT);
        setAudioBuffer(buffer);
        setSourceEnvelope(nextEnvelope);
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
  }, [activeFile]);

  useEffect(() => {
    if (!activeFile) {
      return;
    }

    if (sourceAudioUrlRef.current) {
      URL.revokeObjectURL(sourceAudioUrlRef.current);
    }

    const nextUrl = URL.createObjectURL(activeFile);
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
  }, [activeFile]);

  // Once every chunk (file: all precomputed windows; recording: capture stopped and its queue
  // drained) is done, swap playback over to the stitched processed audio - the same "processed
  // audio becomes available" moment the single-shot flow used to reach right after its one
  // transcribeAudioRequest call resolved.
  useEffect(() => {
    if (!analysis.finalAudioBlob) {
      return;
    }

    if (source.kind === "recording" && !recordedFile) {
      const file = new File([analysis.finalAudioBlob], `pc-audio-${Date.now()}.wav`, { type: "audio/wav" });
      setRecordedFile(file);
      onRecordingFinalized?.(file);
      return;
    }

    let cancelled = false;
    decodeAudioFile(analysis.finalAudioBlob).then((processedAudioBuffer) => {
      if (cancelled) {
        return;
      }
      setAudioBuffer(processedAudioBuffer);
      replaceProcessedAudioUrl(analysis.finalAudioBlob as Blob);
      setPlaybackSource("processed");
      resetPlaybackPosition();
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis.finalAudioBlob]);

  // Reopening "분석 시작"/"화자 분리" on a file that already has a saved transcript loads it
  // straight into the transcript panel via the same loadExternalTranscript path the manual
  // "불러오기" button uses - the user doesn't have to click "불러오기" and repick the transcript
  // file they just saved. File mode only; a fresh recording never has anything to preload. Runs
  // once on mount - if the user runs a fresh "분석 시작" afterward, startFileAnalysis's own
  // reset() overwrites this intentionally.
  //
  // loadExternalTranscript itself seeds speakerMap with an identity mapping (label -> label) -
  // correct for its original caller (a picked transcript .txt file, which has no separate display
  // names), but wrong here: it would show raw labels like "SPEAKER_01" instead of the names
  // already saved on this meeting (or "미등록 화자 N"). Overwriting editedSpeakerMap with the saved
  // speakerMap right after fixes that - the "additive" effect below only fills in labels missing
  // from editedSpeakerMap, so this always wins over the identity default.
  useEffect(() => {
    if (source.kind !== "file" || !existingAnalysis || existingAnalysis.transcriptSegments.length === 0) {
      return;
    }

    analysis.loadExternalTranscript(existingAnalysis.transcriptSegments, existingAnalysis.fileName);
    setEditedSpeakerMap(existingAnalysis.speakerMap);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Additive: seeds a default entry for any speaker label newly added to `result` (as each chunk
  // merges in) without ever overwriting one the user already renamed via the input fields below -
  // renaming a speaker mid-analysis has to survive later chunks completing.
  useEffect(() => {
    if (!result) {
      return;
    }

    setEditedSpeakerMap((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [label, autoName] of Object.entries(result.speakerMap)) {
        if (!(label in next)) {
          next[label] = autoName;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [result]);

  useEffect(() => {
    setSelectedProvider(sttProvider);
    setSttModel(defaultSttModel(sttProvider));
  }, [sttProvider]);

  const speakerLabels = useMemo(() => (result ? Object.keys(result.speakerMap) : []), [result]);

  // Approximation only: the source audio is not truly source-separated, so a lane simply
  // highlights the shared full-mix envelope wherever that speaker's turns fall in time. Falls back
  // to sourceEnvelope when there's no processed envelope yet - notably a transcript loaded via
  // "불러오기" never runs a chunk through the analysis pipeline, so processedEnvelope stays null.
  const activeMaskEnvelope = processedEnvelope ?? sourceEnvelope;
  const speakerMasks = useMemo(() => {
    const masks: Record<string, boolean[]> = {};
    if (!result || !activeMaskEnvelope) {
      return masks;
    }

    // Prefer the real decoded buffer's duration (known up front for a picked file, or the true
    // final total once a recording is stitched) over result.durationSec, which is only a running
    // cumulative-so-far total while chunked analysis is still in progress.
    const duration = audioBuffer?.duration || result.durationSec || 0;
    const bucketCount = activeMaskEnvelope.length;

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
  }, [result, activeMaskEnvelope, audioBuffer, speakerLabels]);

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
  const playbackVisualTime = Math.min(
    Math.max(currentTime - (isPlaying ? PLAYBACK_VISUAL_LATENCY_SECONDS : 0), 0),
    playbackDurationSec || currentTime
  );
  const activeTranscriptIndex = useMemo(() => {
    if (!result) {
      return -1;
    }

    return result.transcriptSegments.findIndex(
      (segment) => playbackVisualTime >= segment.startSec && playbackVisualTime < segment.endSec
    );
  }, [playbackVisualTime, result]);

  // Clicking a transcript row (handleTranscriptRowClick) seeks playback to that segment's start,
  // which makes activeTranscriptIndex resolve back to that same segment - so the clicked segment's
  // range on the full waveform can just follow activeTranscriptIndex instead of tracking its own
  // separate "selected" state.
  const activeTranscriptRange = useMemo(() => {
    if (!result || activeTranscriptIndex < 0) {
      return undefined;
    }
    const segment = result.transcriptSegments[activeTranscriptIndex];
    return segment ? { startSec: segment.startSec, endSec: segment.endSec } : undefined;
  }, [result, activeTranscriptIndex]);

  function handleTranscriptRowClick(startSec: number) {
    seekTo(startSec);
  }

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

  useEffect(() => {
    if (isPlaying && activeTranscriptIndex >= 0) {
      activeTranscriptRowRef.current?.scrollIntoView({ block: "nearest" });
    }
  }, [activeTranscriptIndex, isPlaying]);

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

  // Closes the word right-click menu on any subsequent click/scroll/Escape elsewhere - a plain
  // right-click menu is expected to dismiss itself as soon as the user looks away from it.
  useEffect(() => {
    if (!wordContextMenu) {
      return;
    }

    const closeMenu = () => setWordContextMenu(null);
    // Right-clicking a *different* word already moves the menu itself (its own onContextMenu
    // handler calls setWordContextMenu with the new position) - this listener firing right after
    // on the same event would otherwise immediately clobber that back to null, so it only closes
    // for a right-click that lands outside any editable word.
    const closeOnOutsideContextMenu = (event: MouseEvent) => {
      if (!(event.target as HTMLElement | null)?.closest(".transcript-editable-word")) {
        closeMenu();
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("contextmenu", closeOnOutsideContextMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("contextmenu", closeOnOutsideContextMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [wordContextMenu]);

  function handleWordContextMenu(event: React.MouseEvent, word: string) {
    event.preventDefault();
    setWordContextMenu({ x: event.clientX, y: event.clientY, word });
  }

  function openCorrectionDraftForMenu() {
    if (!wordContextMenu) {
      return;
    }

    setCorrectionError("");
    setCorrectionDraft({ from: wordContextMenu.word, to: wordContextMenu.word });
    setWordContextMenu(null);
  }

  // Registers the correction into the shared 수정 사전 (merges into whatever's already saved there
  // - never overwrites it) and immediately re-applies it to the transcript already on screen, so
  // the fix is visible without waiting for a future re-analysis or the Dictionary modal's own
  // "적용하기" button.
  async function handleSaveCorrection() {
    if (!correctionDraft || !correctionDraft.from.trim()) {
      return;
    }

    setIsSavingCorrection(true);
    setCorrectionError("");

    try {
      const saved = await saveDictionary({
        ...dictionary,
        corrections: [...dictionary.corrections, { id: crypto.randomUUID(), from: correctionDraft.from, to: correctionDraft.to, description: "" }]
      });
      onDictionaryChange(saved);

      analysis.applyTextCorrection(correctionDraft.from, correctionDraft.to);

      setCorrectionDraft(null);
    } catch (error) {
      setCorrectionError(error instanceof Error ? error.message : "수정 사전 등록에 실패했습니다.");
    } finally {
      setIsSavingCorrection(false);
    }
  }

  function clearAnalysisResult() {
    analysis.reset();
    setEditedSpeakerMap({});
  }

  function triggerTranscriptFilePick() {
    transcriptFileInputRef.current?.click();
  }

  async function handleTranscriptFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    setTranscriptLoadError("");

    try {
      const text = await file.text();
      const segments = parseTranscriptText(text);
      if (segments.length === 0) {
        setTranscriptLoadError("발언 대본 형식을 인식하지 못했습니다. 예: [00:00-00:05] [화자] 발언 내용");
        return;
      }

      setEditedSpeakerMap({});
      restoreOriginalAudioPreview();
      analysis.loadExternalTranscript(segments, activeFile?.name ?? file.name);
    } catch {
      setTranscriptLoadError("발언 대본 파일을 읽을 수 없습니다.");
    }
  }

  function restoreOriginalAudioPreview() {
    const sourceAudioBuffer = sourceAudioBufferRef.current;
    if (sourceAudioBuffer) {
      setAudioBuffer(sourceAudioBuffer);
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

  function handlePlaybackSourceChange(nextPlaybackSource: PlaybackSource) {
    if (nextPlaybackSource === "processed" && !processedAudioAvailable) {
      return;
    }

    resetPlaybackPosition();
    setPlaybackSource(nextPlaybackSource);
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
    // File mode only - recording mode's "분석 시작" is handleStartRecordingAnalyze below, since it
    // has to run against the still-live capture instead of an already-decoded buffer.
    const sourceAudioBuffer = sourceAudioBufferRef.current;
    if (!sourceAudioBuffer || !activeFile) {
      return;
    }

    resetPlaybackPosition();
    await analysis.startFileAnalysis(sourceAudioBuffer, {
      provider: selectedProvider,
      model: sttModel,
      fileName: activeFile.name,
      attendeeNames,
      agenda,
      preprocessing: { vocalIsolation, noiseRemoval, normalize },
      silenceThreshold,
      chunkMinutesOverrides
    });
  }

  function handleStopAnalyze() {
    analysis.cancel();
  }

  function handleStartRecordingAnalyze() {
    if (!capture) {
      return;
    }

    // The popup shows the live waveform as soon as it opens, but actual recording (the
    // MediaRecorder capturing data) only starts here, on the user's explicit "분석 시작" click.
    capture.startRecording();
    setHasStartedRecordingAnalysis(true);
    analysis.startRecordingAnalysis(capture, {
      provider: selectedProvider,
      model: sttModel,
      fileName: "recording.wav",
      attendeeNames,
      agenda,
      preprocessing: { vocalIsolation, noiseRemoval, normalize },
      silenceThreshold,
      chunkMinutesOverrides
    });
  }

  async function handleStopRecording() {
    if (!capture) {
      return;
    }

    setIsRecordingActive(false);
    await analysis.stopRecordingAnalysis(capture);
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

  // ---------- Per-segment speaker editing (free text, not limited to the already-known labels) ----------

  // Suggestions for the per-segment speaker input's datalist - every speaker name known so far in
  // this analysis, so typing can autocomplete to an existing person without forcing a rigid
  // dropdown-only choice. Deduped: two labels can transiently (or, before a merge, briefly)
  // display the same name, and duplicate <option> values under one name would otherwise give
  // React two list children with the same key.
  const segmentSpeakerSuggestions = Array.from(new Set(speakerLabels.map((label) => editedSpeakerMap[label] ?? label)));

  // Holds in-progress edits for the per-segment speaker input while the user is still typing -
  // committing (which can reassign the segment and possibly mint a brand-new speaker label) only
  // happens on blur/Enter, not on every keystroke, the same as the 화자 이름 inputs' registration.
  const [segmentSpeakerDrafts, setSegmentSpeakerDrafts] = useState<Record<number, string>>({});

  function segmentSpeakerInputValue(index: number, speaker: string): string {
    return segmentSpeakerDrafts[index] ?? editedSpeakerMap[speaker] ?? speaker;
  }

  // Typing a name for one segment either moves it to a DIFFERENT already-known speaker (the name
  // matches another label's current display name - "this line was actually them") or mints a
  // brand-new label just for this one segment when the name doesn't match anyone else - every
  // other segment still on the old label is left untouched (this is what makes per-segment
  // editing actually per-segment, instead of renaming the whole speaker). If that new name later
  // collides with another label (e.g. the 화자별 파형 input renames the original label to the same
  // name), handleSpeakerNameBlur's merge step folds them back into one entry - duplicates get
  // resolved at the point they'd occur, rather than by refusing to mint new labels here.
  function commitSegmentSpeakerName(index: number, speaker: string) {
    const draft = segmentSpeakerDrafts[index];
    if (draft === undefined) {
      return;
    }
    setSegmentSpeakerDrafts((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });

    const name = draft.trim();
    if (!name || name === (editedSpeakerMap[speaker] ?? speaker)) {
      return;
    }

    const otherLabel = speakerLabels.find((label) => label !== speaker && (editedSpeakerMap[label] ?? label) === name);

    if (otherLabel) {
      analysis.updateSegmentSpeaker(index, otherLabel);
      return;
    }

    // The new label IS the typed name (labels are just string keys) - a later segment typed with
    // this exact same new name naturally matches it via the otherLabel branch above instead of
    // minting yet another duplicate.
    analysis.updateSegmentSpeaker(index, name, name);
    setEditedSpeakerMap((prev) => ({ ...prev, [name]: name }));
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

    await onComplete({ ...(persistableResult as AudioAnalysis), speakerMap: editedSpeakerMap });
    onClose();
  }

  return (
    <>
    <ModalShell
      title="회의 음성 분석"
      onClose={onClose}
      width="full"
      footer={
        <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
          <button className="ghost-action" onClick={onClose} type="button">
            취소
          </button>
          <button className="primary-action" disabled={!result || isAnalyzing} onClick={handleComplete} type="button">
            완료 (대본 저장)
          </button>
        </div>
      }
    >
      {isDecoding && <div className="audio-analysis-status">오디오 파일을 분석 준비 중입니다...</div>}
      {!isDecoding && decodeError && <div className="audio-analysis-status error">{decodeError}</div>}

      {source.kind === "recording" && !activeFile && (
        <div className="audio-analysis-layout">
          <div className="audio-analysis-transcript-panel">
            <div className="waveform-window-title">
              <FileText size={16} />
              발언 대본
              <button
                className="ghost-action"
                disabled={isAnalyzing}
                onClick={triggerTranscriptFilePick}
                style={{ width: "fit-content", marginLeft: "auto" }}
                type="button"
              >
                <Upload size={14} />
                불러오기
              </button>
            </div>
            <input accept=".txt,.md" hidden onChange={(event) => void handleTranscriptFileChange(event)} ref={transcriptFileInputRef} type="file" />
            {!!result && <span className="field-hint">단어를 마우스 오른쪽 버튼으로 클릭하면 수정 사전에 등록, 발언자는 옆의 선택 상자로 바꿀 수 있습니다.</span>}
            {transcriptLoadError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{transcriptLoadError}</span>}

            {!result && liveSegments.length === 0 && (
              <p className="audio-analysis-placeholder">
                {hasStartedRecordingAnalysis
                  ? "녹음 중에도 대본이 실시간으로 채워집니다."
                  : "분석 시작 버튼을 누르면 녹음이 시작되고, 이미 만들어진 발언 대본을 불러올 수도 있습니다."}
              </p>
            )}

            {result && (
              <ul className="audio-analysis-transcript-list">
                {result.transcriptSegments.map((segment, index) => (
                  <li className="audio-analysis-transcript-row" key={`${segment.speaker}-${index}`}>
                    <div className="audio-analysis-transcript-meta">
                      <span className="audio-analysis-transcript-time">
                        {formatMmSs(segment.startSec)}-{formatMmSs(segment.endSec)}
                      </span>
                      <input
                        className="audio-analysis-transcript-speaker-select"
                        list={`segment-speaker-options-${index}`}
                        onBlur={() => commitSegmentSpeakerName(index, segment.speaker)}
                        onChange={(event) => setSegmentSpeakerDrafts((prev) => ({ ...prev, [index]: event.target.value }))}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                        type="text"
                        value={segmentSpeakerInputValue(index, segment.speaker)}
                      />
                      <datalist id={`segment-speaker-options-${index}`}>
                        {segmentSpeakerSuggestions.map((name) => (
                          <option key={name} value={name} />
                        ))}
                      </datalist>
                    </div>
                    <EditableTranscriptText onWordContextMenu={handleWordContextMenu} text={segment.text} />
                  </li>
                ))}
              </ul>
            )}

            {liveSegments.length > 0 && (
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
              <div className="waveform-window-title">
                <Mic size={16} />
                {!isRecordingActive ? "녹음 종료 - 마지막 구간 처리 중" : hasStartedRecordingAnalysis ? "PC 소리 녹음 중" : "PC 소리 대기 중"}
                {isRecordingActive && hasStartedRecordingAnalysis && <span className="live-caption-recording-dot" />}
                {hasStartedRecordingAnalysis && (
                  <span className="field-hint" style={{ marginLeft: "auto" }}>
                    {isRecordingActive
                      ? `${Math.floor(recordingElapsedSec / 60)
                          .toString()
                          .padStart(2, "0")}:${(recordingElapsedSec % 60).toString().padStart(2, "0")} · 처리됨 ${processedChunkCount}개`
                      : queuedChunkCount > 0
                        ? `${processedChunkCount}/${queuedChunkCount}개 구간 처리 중...`
                        : "처리 중..."}
                  </span>
                )}
              </div>
              <LiveWaveform analyser={capture?.analyser ?? null} height={90} />
              {captureError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{captureError}</span>}
              {analyzeError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{analyzeError}</span>}

              <div className="audio-playback-controls">
                <div className="audio-playback-right" style={{ marginLeft: "auto" }}>
                  {isRecordingActive && hasStartedRecordingAnalysis && (
                    <button className="danger-action" onClick={() => void handleStopRecording()} type="button">
                      <Square size={14} />
                      녹음 중지
                    </button>
                  )}
                  <button
                    className="primary-action"
                    disabled={!capture || !isRecordingActive || hasStartedRecordingAnalysis}
                    onClick={handleStartRecordingAnalyze}
                    type="button"
                  >
                    {hasStartedRecordingAnalysis ? "분석 중..." : "분석 시작"}
                  </button>
                  {result?.speakerEmbeddings && Object.keys(result.speakerEmbeddings).length > 0 && (
                    <button
                      className="primary-action"
                      disabled={isRematchingSpeakers}
                      onClick={() => void handleRematchSpeakers()}
                      title="화자 이름을 고친 뒤 눌러, 지금까지 등록된 음성 프로필로 화자를 다시 매칭합니다"
                      type="button"
                    >
                      {isRematchingSpeakers ? "재분류 중..." : "다시 화자 분리"}
                    </button>
                  )}
                </div>
              </div>
              {rematchError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{rematchError}</span>}
            </section>

            {result && (
              <section className="waveform-window">
                <div className="waveform-window-title">
                  <Users size={16} />
                  화자 목록
                </div>

                <div className="speaker-lanes">
                  {speakerLabels.map((label, index) => (
                    <div className="speaker-lane-row" key={label}>
                      <div className="speaker-lane-chip">{index + 1}</div>
                      <input
                        list={`speaker-options-live-${index}`}
                        onBlur={() => void handleSpeakerNameBlur(label)}
                        onChange={(event) => setEditedSpeakerMap((prev) => ({ ...prev, [label]: event.target.value }))}
                        placeholder="화자 이름"
                        type="text"
                        value={editedSpeakerMap[label] ?? ""}
                      />
                      <datalist id={`speaker-options-live-${index}`}>
                        {speakerOptions(label).map((name) => (
                          <option key={name} value={name} />
                        ))}
                      </datalist>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      )}

      {!isDecoding && !decodeError && audioBuffer && sourceEnvelope && (
        <div className="audio-analysis-layout">
          <div className="audio-analysis-transcript-panel">
            <div className="waveform-window-title">
              <FileText size={16} />
              발언 대본
              <button
                className="ghost-action"
                disabled={isAnalyzing}
                onClick={triggerTranscriptFilePick}
                style={{ width: "fit-content", marginLeft: "auto" }}
                type="button"
              >
                <Upload size={14} />
                불러오기
              </button>
            </div>
            <input accept=".txt,.md" hidden onChange={(event) => void handleTranscriptFileChange(event)} ref={transcriptFileInputRef} type="file" />
            {!!result && <span className="field-hint">단어를 마우스 오른쪽 버튼으로 클릭하면 수정 사전에 등록, 발언자는 옆의 선택 상자로 바꿀 수 있습니다.</span>}
            {transcriptLoadError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{transcriptLoadError}</span>}

            {!result && liveSegments.length === 0 && (
              <p className="audio-analysis-placeholder">분석 시작 버튼을 누르거나, 이미 만들어진 발언 대본을 불러올 수 있습니다.</p>
            )}

            {result && (
              <ul className="audio-analysis-transcript-list">
                {result.transcriptSegments.map((segment, index) => (
                  <li
                    aria-current={index === activeTranscriptIndex ? "true" : undefined}
                    className={`audio-analysis-transcript-row ${index === activeTranscriptIndex ? "active" : ""}`}
                    key={`${segment.speaker}-${index}`}
                    onClick={() => handleTranscriptRowClick(segment.startSec)}
                    ref={index === activeTranscriptIndex ? activeTranscriptRowRef : undefined}
                    style={{ cursor: "pointer" }}
                    title="클릭하면 이 구간의 음성 파형으로 이동합니다"
                  >
                    <div className="audio-analysis-transcript-meta">
                      <span className="audio-analysis-transcript-time">
                        {formatMmSs(segment.startSec)}-{formatMmSs(segment.endSec)}
                      </span>
                      <input
                        className="audio-analysis-transcript-speaker-select"
                        list={`segment-speaker-options-file-${index}`}
                        onBlur={() => commitSegmentSpeakerName(index, segment.speaker)}
                        onChange={(event) => setSegmentSpeakerDrafts((prev) => ({ ...prev, [index]: event.target.value }))}
                        onClick={(event) => event.stopPropagation()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.currentTarget.blur();
                          }
                        }}
                        type="text"
                        value={segmentSpeakerInputValue(index, segment.speaker)}
                      />
                      <datalist id={`segment-speaker-options-file-${index}`}>
                        {segmentSpeakerSuggestions.map((name) => (
                          <option key={name} value={name} />
                        ))}
                      </datalist>
                    </div>
                    <EditableTranscriptText onWordContextMenu={handleWordContextMenu} text={segment.text} />
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
                    currentTime={playbackVisualTime}
                    // playbackDurationSec (not sourceDurationSec) even when this isn't the active
                    // source - currentTime always comes from the same <audio> element regardless of
                    // which waveform is shown, so both canvases need the same denominator or their
                    // playhead bars (and highlightRange) drift apart from each other.
                    durationSec={playbackDurationSec}
                    envelope={sourceEnvelope}
                    height={FULL_WAVE_HEIGHT}
                    highlightRange={activeTranscriptRange}
                  />
                </label>

                {processedEnvelope && (
                  <label className={`audio-waveform-choice ${playbackSource === "processed" ? "active" : ""}`}>
                    <input
                      checked={playbackSource === "processed"}
                      disabled={!processedAudioAvailable}
                      onChange={() => handlePlaybackSourceChange("processed")}
                      type="checkbox"
                    />
                    <span className="audio-waveform-choice-label">전처리</span>
                    <WaveformCanvas
                      currentTime={playbackVisualTime}
                      // Same playbackDurationSec as the 원본 canvas above, for the same reason - the
                      // playhead (and highlightRange) has to use one shared denominator across both
                      // waveforms or they drift out of sync with each other.
                      durationSec={playbackDurationSec}
                      envelope={processedEnvelope}
                      height={FULL_WAVE_HEIGHT}
                      highlightRange={activeTranscriptRange}
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
                      {result?.speakerEmbeddings && Object.keys(result.speakerEmbeddings).length > 0 && (
                        <button
                          className="primary-action"
                          disabled={isRematchingSpeakers}
                          onClick={() => void handleRematchSpeakers()}
                          title="화자 이름을 고친 뒤 눌러, 지금까지 등록된 음성 프로필로 화자를 다시 매칭합니다"
                          type="button"
                        >
                          {isRematchingSpeakers ? "재분류 중..." : "다시 화자 분리"}
                        </button>
                      )}
                    </div>
                  </div>
                  {analyzeError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{analyzeError}</span>}
                  {rematchError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{rematchError}</span>}
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
                        onBlur={() => void handleSpeakerNameBlur(label)}
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
                        currentTime={playbackVisualTime}
                        durationSec={playbackSource === "processed" ? playbackDurationSec : durationSec}
                        envelope={processedEnvelope ?? sourceEnvelope}
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

    {wordContextMenu && (
      <div
        className="transcript-word-context-menu"
        onClick={(event) => event.stopPropagation()}
        style={{ position: "fixed", top: wordContextMenu.y, left: wordContextMenu.x }}
      >
        <button onClick={openCorrectionDraftForMenu} type="button">
          수정하기
        </button>
      </div>
    )}

    {correctionDraft && (
      <ModalShell
        footer={
          <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
            <button className="ghost-action" onClick={() => setCorrectionDraft(null)} type="button">
              취소
            </button>
            <button
              className="primary-action"
              disabled={isSavingCorrection || !correctionDraft.from.trim()}
              onClick={() => void handleSaveCorrection()}
              type="button"
            >
              {isSavingCorrection ? "저장 중..." : "저장"}
            </button>
          </div>
        }
        onClose={() => setCorrectionDraft(null)}
        overlayZIndex={1000}
        title="수정 사전 등록"
        width="narrow"
      >
        <div className="field full">
          <label>수정 전</label>
          <input
            onChange={(event) => setCorrectionDraft((current) => current && { ...current, from: event.target.value })}
            value={correctionDraft.from}
          />
        </div>
        <div className="field full">
          <label>수정 후</label>
          <input
            autoFocus
            onChange={(event) => setCorrectionDraft((current) => current && { ...current, to: event.target.value })}
            value={correctionDraft.to}
          />
          <span className="field-hint">저장 즉시 이 대본에 반영되고, 이후 새로 분석되는 회의록에도 자동으로 적용됩니다.</span>
        </div>
        {correctionError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{correctionError}</span>}
      </ModalShell>
    )}
    </>
  );
}
