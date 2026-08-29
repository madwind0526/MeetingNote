import { useCallback, useRef, useState } from "react";
import type { SttProviderId } from "../types/domain";
import { base64ToBlob, transcribeAudioRequest } from "../lib/api";
import type { TranscribeResult } from "../lib/api";
import { computeEnvelopeFromMono, computeRms, decodeAudioFile, encodeWav, findQuietCutSample, mixDownToMono } from "../lib/audio";
import { reconcileUnregisteredSpeakers } from "../lib/speakerSessionLinking";
import type { SessionSpeaker } from "../lib/speakerSessionLinking";
import type { SystemAudioCapture } from "../lib/systemAudioCapture";

// Must match AudioAnalysisModal's BUCKET_COUNT so the incrementally-built envelope lines up with
// the same WaveformCanvas it feeds.
const BUCKET_COUNT = 900;

// Chunk boundary targeting - see src/lib/audio.ts's findQuietCutSample. Chunk size now scales with
// (estimated) total meeting length instead of a single fixed value: a real chunk-size sweep
// (tools/e2e/chunk-size-sweep.mjs, tools/e2e/word-count-verify.mjs) found that processing speed
// keeps improving all the way out to 6-minute chunks with no measurable transcript loss (per-chunk
// STT cost is dominated by a roughly fixed model-load overhead, not audio length - WhisperX took
// ~22-25s per call across every model size on a 35s clip, barely moving with model size). But a
// short meeting doesn't need a giant chunk to see that win, and every chunk delays when its
// transcript appears (worse for live-recording UX, and it caps how fine-grained "분석 중" progress
// can look) - so pick the smallest chunk size whose overhead-amortization win is already realized
// for the meeting's length, rather than always taking the biggest.
const SHORT_MEETING_THRESHOLD_SEC = 600; // 10분
const MEDIUM_MEETING_THRESHOLD_SEC = 1800; // 30분
const SHORT_CHUNK_TARGET_MS = 60000; // 10분 미만 회의 -> 1분 청크
const MEDIUM_CHUNK_TARGET_MS = 120000; // 10~30분 회의 -> 2분 청크
const LONG_CHUNK_TARGET_MS = 300000; // 30분 이상 회의 -> 5분 청크
const QUIET_CHECK_INTERVAL_MS = 300;
const QUIET_AMPLITUDE_THRESHOLD = 0.02;
// Below this, a chunk is treated as having no speech at all and is never sent to STT (see
// processChunk). STT models (Whisper in particular) are prone to hallucinating plausible-sounding
// but entirely fabricated text on near-silent audio (e.g. stock phrases like "다음 영상에서 만나요"),
// so skipping the call outright avoids that instead of trying to filter it out of the response
// afterwards. 0.004 tuned from real recordings, exposed as Settings' 무음 임계값 (silenceThreshold)
// for further tuning - findQuietCutSample's own 0.02 default is for picking the quietest point to
// CUT at (relative comparison against other windows in the same clip), not for judging whether a
// chunk has speech at all, so the two don't need to match.
const DEFAULT_SILENCE_RMS_THRESHOLD = 0.004;

interface ChunkSizeBounds {
  targetMs: number;
  minMs: number;
  maxMs: number;
}

// Settings' 회의 길이별 STT 청크 크기 fields are free-form strings that can be left blank (the input
// shows the built-in default as a placeholder rather than holding it as a live value) - this turns
// one of those strings into a positive minute count, or undefined if blank/not a usable number, so
// pickChunkSizeBounds can fall back to its own default for that tier.
export function parseChunkMinutesSetting(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export interface ChunkMinutesOverrides {
  shortMinutes?: number;
  mediumMinutes?: number;
  longMinutes?: number;
}

// Bounds each ±25% around target, the same ratio the old fixed 60s/45s/75s scheme used - MIN/MAX
// bound findQuietCutSample's word-boundary-safe search window, not a hard chunk-length limit.
function pickChunkSizeBounds(totalDurationSec: number, overrides?: ChunkMinutesOverrides): ChunkSizeBounds {
  const shortMs = (overrides?.shortMinutes ?? SHORT_CHUNK_TARGET_MS / 60000) * 60000;
  const mediumMs = (overrides?.mediumMinutes ?? MEDIUM_CHUNK_TARGET_MS / 60000) * 60000;
  const longMs = (overrides?.longMinutes ?? LONG_CHUNK_TARGET_MS / 60000) * 60000;
  const targetMs = totalDurationSec >= MEDIUM_MEETING_THRESHOLD_SEC ? longMs : totalDurationSec >= SHORT_MEETING_THRESHOLD_SEC ? mediumMs : shortMs;
  return { targetMs, minMs: Math.round(targetMs * 0.75), maxMs: Math.round(targetMs * 1.25) };
}

// Recording mode has no known total duration up front (unlike file mode, which reads it straight
// off the decoded buffer) - Agenda's per-item 예상 소요 시간 is the only length estimate available
// before the meeting actually happens, so its sum stands in for "total duration". No agenda rows
// (or none with a duration) falls back to the shortest tier, matching the old always-60s behavior.
function estimateAgendaDurationSec(agenda?: { durationMinutes: number }[]): number {
  if (!agenda || agenda.length === 0) {
    return 0;
  }
  return agenda.reduce((sum, item) => sum + (item.durationMinutes || 0), 0) * 60;
}

export interface ChunkedAnalysisOptions {
  provider: SttProviderId;
  model: string;
  fileName: string;
  attendeeNames: string[];
  agenda?: { no: number; durationMinutes: number; presenter: string }[];
  preprocessing: { vocalIsolation: boolean; noiseRemoval: boolean; normalize: boolean };
  silenceThreshold?: number;
  chunkMinutesOverrides?: ChunkMinutesOverrides;
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

// Cheap voice-activity proxy reused from the same analyser LiveWaveform already reads - true once
// the current instant is quiet enough to be a safe/natural chunk boundary.
function isAnalyserQuiet(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): boolean {
  analyser.getByteTimeDomainData(buffer);
  let peak = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const deviation = Math.abs(buffer[index] - 128) / 128;
    if (deviation > peak) {
      peak = deviation;
    }
  }
  return peak < QUIET_AMPLITUDE_THRESHOLD;
}

// Shared engine behind AudioAnalysisModal's chunked/progressive analysis for both the file-upload
// and live-recording entry points. Splits audio into windows sized by pickChunkSizeBounds (1/2/5분
// depending on meeting length), runs each through the existing per-file STT+diarization job
// pipeline (transcribeAudioRequest, unchanged), and merges results in as each chunk finishes
// instead of waiting for the whole clip. Cross-chunk "미등록 화자" identity is kept consistent via
// reconcileUnregisteredSpeakers (registered/named speakers already stay consistent on their own via
// the server's persistent voice-profile registry).
export function useChunkedAudioAnalysis() {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState(0);
  const [analyzeError, setAnalyzeError] = useState("");
  const [liveSegments, setLiveSegments] = useState<{ startSec: number; endSec: number; text: string }[]>([]);
  const [result, setResult] = useState<TranscribeResult | null>(null);
  const [envelope, setEnvelope] = useState<Float32Array | null>(null);
  const [finalAudioBlob, setFinalAudioBlob] = useState<Blob | null>(null);
  // Recording mode only - how many segments have been queued for STT vs. actually finished, so the
  // UI can show real progress ("3/5 처리됨") instead of a single indefinite "처리 중..." during the
  // (sometimes long) drain after "녹음 중지", when it's otherwise impossible to tell whether
  // processing is still moving or stuck.
  const [queuedChunkCount, setQueuedChunkCount] = useState(0);
  const [processedChunkCount, setProcessedChunkCount] = useState(0);

  const sessionSpeakersRef = useRef<SessionSpeaker[]>([]);
  const processedMonoChunksRef = useRef<Float32Array[]>([]);
  const cancelledRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const rotateTimerRef = useRef<number | null>(null);
  const recordingQueueRef = useRef<Blob[]>([]);
  const recordingBusyRef = useRef(false);
  const recordingCursorSecRef = useRef(0);
  const recordingFinishedRef = useRef(false);
  const activeOptionsRef = useRef<ChunkedAnalysisOptions | null>(null);

  const reset = useCallback(() => {
    setIsAnalyzing(false);
    setAnalyzeProgress(0);
    setAnalyzeError("");
    setLiveSegments([]);
    setResult(null);
    setEnvelope(null);
    setFinalAudioBlob(null);
    setQueuedChunkCount(0);
    setProcessedChunkCount(0);
    sessionSpeakersRef.current = [];
    processedMonoChunksRef.current = [];
    cancelledRef.current = false;
    recordingQueueRef.current = [];
    recordingBusyRef.current = false;
    recordingCursorSecRef.current = 0;
    recordingFinishedRef.current = false;
  }, []);

  // Folds one chunk's (already speaker-session-reconciled) result into the growing accumulated
  // `result` and waveform - the only place `result`/`envelope` are written, so speakerLabels/
  // speakerMasks/the Save button in AudioAnalysisModal (all derived from `result`) grow
  // automatically with no logic changes there.
  const mergeChunkResult = useCallback((chunkResult: TranscribeResult, chunkStartSec: number, chunkProcessedMono: Float32Array) => {
    const { relabeledMap, updatedKnown } = reconcileUnregisteredSpeakers(
      chunkResult.speakerMap,
      chunkResult.speakerEmbeddings,
      sessionSpeakersRef.current
    );
    sessionSpeakersRef.current = updatedKnown;

    const offsetSegments = chunkResult.transcriptSegments.map((segment) => ({
      ...segment,
      speaker: relabeledMap[segment.speaker] ?? segment.speaker,
      startSec: segment.startSec + chunkStartSec,
      endSec: segment.endSec + chunkStartSec
    }));

    processedMonoChunksRef.current.push(chunkProcessedMono);
    setEnvelope(computeEnvelopeFromMono(concatFloat32(processedMonoChunksRef.current), BUCKET_COUNT));

    setResult((prev) => {
      const nextSpeakerMap: Record<string, string> = { ...prev?.speakerMap };
      const nextEmbeddings: Record<string, number[]> = { ...prev?.speakerEmbeddings };

      for (const rawLabel of Object.keys(chunkResult.speakerMap)) {
        const sessionLabel = relabeledMap[rawLabel];
        nextSpeakerMap[sessionLabel] = sessionLabel;
        const embedding = chunkResult.speakerEmbeddings?.[rawLabel];
        if (embedding) {
          nextEmbeddings[sessionLabel] = embedding;
        }
      }

      return {
        fileName: prev?.fileName ?? chunkResult.fileName,
        durationSec: chunkStartSec + chunkResult.durationSec,
        preprocessing: chunkResult.preprocessing,
        transcriptSegments: [...(prev?.transcriptSegments ?? []), ...offsetSegments],
        speakerMap: nextSpeakerMap,
        analyzedAt: chunkResult.analyzedAt,
        ...(Object.keys(nextEmbeddings).length > 0 ? { speakerEmbeddings: nextEmbeddings } : {})
      };
    });
  }, []);

  const processChunk = useCallback(
    async (chunkMono: Float32Array, sampleRate: number, chunkStartSec: number, options: ChunkedAnalysisOptions) => {
      setLiveSegments([]);
      setAnalyzeProgress(0);

      const silenceThreshold = options.silenceThreshold ?? DEFAULT_SILENCE_RMS_THRESHOLD;
      if (computeRms(chunkMono) < silenceThreshold) {
        setAnalyzeProgress(100);
        mergeChunkResult(
          {
            fileName: options.fileName,
            durationSec: chunkMono.length / sampleRate,
            preprocessing: options.preprocessing,
            transcriptSegments: [],
            speakerMap: {},
            analyzedAt: new Date().toISOString()
          },
          chunkStartSec,
          chunkMono
        );
        setLiveSegments([]);
        return;
      }

      const wavBlob = encodeWav(chunkMono, sampleRate);
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      const chunkResult = await transcribeAudioRequest({
        provider: options.provider,
        model: options.model,
        audioBlob: wavBlob,
        fileName: options.fileName,
        durationSec: chunkMono.length / sampleRate,
        preprocessing: options.preprocessing,
        attendeeNames: options.attendeeNames,
        agenda: options.agenda,
        onProgress: setAnalyzeProgress,
        onPartialSegments: setLiveSegments,
        signal: abortController.signal
      });

      let chunkProcessedMono = chunkMono;
      if (chunkResult.processedAudioBase64) {
        const blob = base64ToBlob(chunkResult.processedAudioBase64, chunkResult.processedAudioMimeType ?? "audio/wav");
        const decoded = await decodeAudioFile(blob);
        chunkProcessedMono = mixDownToMono(decoded);
      }

      mergeChunkResult(chunkResult, chunkStartSec, chunkProcessedMono);
      setLiveSegments([]);
    },
    [mergeChunkResult]
  );

  const finalize = useCallback(() => {
    const concatenated = concatFloat32(processedMonoChunksRef.current);
    if (concatenated.length > 0) {
      // Every decode in this pipeline (decodeAudioFile) runs at a fixed 16kHz - see audio.ts.
      setFinalAudioBlob(encodeWav(concatenated, 16000));
    }
    setIsAnalyzing(false);
  }, []);

  function handleChunkError(error: unknown) {
    if (error instanceof DOMException && error.name === "AbortError") {
      setAnalyzeError("사용자가 분석을 중지했습니다.");
    } else {
      setAnalyzeError(error instanceof Error ? error.message : "분석 중 오류가 발생했습니다.");
    }
  }

  // ---------- File mode: whole buffer already known, chunk boundaries precomputed up front ----------

  const startFileAnalysis = useCallback(
    async (sourceAudioBuffer: AudioBuffer, options: ChunkedAnalysisOptions) => {
      reset();
      setIsAnalyzing(true);
      activeOptionsRef.current = options;

      const mono = mixDownToMono(sourceAudioBuffer);
      const sampleRate = sourceAudioBuffer.sampleRate;
      const totalSamples = mono.length;
      const { targetMs, minMs, maxMs } = pickChunkSizeBounds(totalSamples / sampleRate, options.chunkMinutesOverrides);
      const minSamples = Math.round((minMs / 1000) * sampleRate);
      const targetSamples = Math.round((targetMs / 1000) * sampleRate);
      const maxSamples = Math.round((maxMs / 1000) * sampleRate);

      try {
        let cursor = 0;
        while (cursor < totalSamples) {
          if (cancelledRef.current) {
            break;
          }

          const remaining = totalSamples - cursor;
          const cutSample =
            remaining <= maxSamples ? totalSamples : findQuietCutSample(mono, cursor + minSamples, cursor + maxSamples, cursor + targetSamples);

          await processChunk(mono.subarray(cursor, cutSample), sampleRate, cursor / sampleRate, options);
          cursor = cutSample;
        }
      } catch (error) {
        handleChunkError(error);
      } finally {
        finalize();
      }
    },
    [processChunk, finalize, reset]
  );

  // ---------- Recording mode: chunks arrive over real time via a FIFO drained sequentially ----------

  const drainRecordingQueue = useCallback(
    async (options: ChunkedAnalysisOptions) => {
      if (recordingBusyRef.current) {
        return;
      }
      recordingBusyRef.current = true;

      try {
        while (recordingQueueRef.current.length > 0) {
          if (cancelledRef.current) {
            recordingQueueRef.current = [];
            break;
          }

          const blob = recordingQueueRef.current.shift();
          if (!blob) {
            continue;
          }

          const decoded = await decodeAudioFile(blob);
          const mono = mixDownToMono(decoded);
          const chunkStartSec = recordingCursorSecRef.current;
          recordingCursorSecRef.current += decoded.duration;
          await processChunk(mono, decoded.sampleRate, chunkStartSec, options);
          setProcessedChunkCount((count) => count + 1);
        }
      } catch (error) {
        handleChunkError(error);
      } finally {
        recordingBusyRef.current = false;
        if (recordingFinishedRef.current && recordingQueueRef.current.length === 0) {
          finalize();
        }
      }
    },
    [processChunk, finalize]
  );

  // Starts the rotation timer against an ALREADY-recording SystemAudioCapture (the modal owns
  // starting capture itself, on mount, so a live waveform shows before "분석 시작" is ever clicked -
  // this only starts turning captured segments into transcript/speaker data).
  const startRecordingAnalysis = useCallback(
    (capture: SystemAudioCapture, options: ChunkedAnalysisOptions) => {
      reset();
      setIsAnalyzing(true);
      activeOptionsRef.current = options;

      const { minMs, maxMs } = pickChunkSizeBounds(estimateAgendaDurationSec(options.agenda), options.chunkMinutesOverrides);
      const quietBuffer = new Uint8Array(new ArrayBuffer(capture.analyser.fftSize));
      let lastRotateAt = performance.now();

      rotateTimerRef.current = window.setInterval(() => {
        if (cancelledRef.current || recordingFinishedRef.current) {
          return;
        }

        const elapsed = performance.now() - lastRotateAt;
        if (elapsed < minMs) {
          return;
        }
        if (elapsed < maxMs && !isAnalyserQuiet(capture.analyser, quietBuffer)) {
          return;
        }

        lastRotateAt = performance.now();
        void capture.rotateSegment().then((blob) => {
          recordingQueueRef.current.push(blob);
          setQueuedChunkCount((count) => count + 1);
          void drainRecordingQueue(options);
        });
      }, QUIET_CHECK_INTERVAL_MS);
    },
    [reset, drainRecordingQueue]
  );

  // Stops capturing (flushing the final, possibly partial segment into the queue) but lets already-
  // queued/in-flight chunk processing run to completion - `isAnalyzing` only clears once every
  // chunk, including this last one, is done.
  const stopRecordingAnalysis = useCallback(
    async (capture: SystemAudioCapture) => {
      if (rotateTimerRef.current !== null) {
        window.clearInterval(rotateTimerRef.current);
        rotateTimerRef.current = null;
      }

      const finalBlob = await capture.stopAll();
      recordingFinishedRef.current = true;
      recordingQueueRef.current.push(finalBlob);
      setQueuedChunkCount((count) => count + 1);

      const options = activeOptionsRef.current;
      if (options) {
        void drainRecordingQueue(options);
      }
    },
    [drainRecordingQueue]
  );

  // Aborts the in-flight chunk and stops consuming any further ones. Whatever chunks already merged
  // into `result` are kept - a user who stops early can still save partial progress, same as
  // stopping a live recording early already implies.
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    abortControllerRef.current?.abort();
    if (rotateTimerRef.current !== null) {
      window.clearInterval(rotateTimerRef.current);
      rotateTimerRef.current = null;
    }
    setIsAnalyzing(false);
  }, []);

  // Re-applies a freshly-registered 수정 사전 correction to whatever transcript text is already
  // accumulated (both the finished, speaker-tagged `result` and any still-in-progress `liveSegments`
  // for the chunk currently being transcribed) - mirrors what the single-shot flow used to do
  // directly via setResult, now routed through the hook since it owns both pieces of state.
  const applyTextCorrection = useCallback((from: string, to: string) => {
    const apply = (text: string) => text.split(from).join(to);
    setResult((current) => (current ? { ...current, transcriptSegments: current.transcriptSegments.map((segment) => ({ ...segment, text: apply(segment.text) })) } : current));
    setLiveSegments((current) => current.map((segment) => ({ ...segment, text: apply(segment.text) })));
  }, []);

  // Loads an already-made transcript (parsed by parseTranscriptText) in place of running STT -
  // speaker names from the file double as both the raw label and the display name (there's no
  // diarization output to key off), so they flow straight into speakerMap/transcriptSegments the
  // same shape a real analysis run would have produced.
  const loadExternalTranscript = useCallback(
    (segments: { startSec: number; endSec: number; speaker: string; text: string }[], fileName: string) => {
      reset();

      const speakerMap: Record<string, string> = {};
      let durationSec = 0;
      for (const segment of segments) {
        speakerMap[segment.speaker] = segment.speaker;
        durationSec = Math.max(durationSec, segment.endSec);
      }

      setResult({
        fileName,
        durationSec,
        preprocessing: { vocalIsolation: false, noiseRemoval: false, normalize: false },
        transcriptSegments: segments,
        speakerMap,
        analyzedAt: new Date().toISOString()
      });
    },
    [reset]
  );

  // Reassigns a single utterance to a different (already-known) speaker label - the waveform lane
  // it shows up in follows automatically since speakerMasks in AudioAnalysisModal is derived from
  // transcriptSegments[].speaker, not tracked separately.
  const updateSegmentSpeaker = useCallback((segmentIndex: number, newSpeaker: string) => {
    setResult((current) => {
      if (!current || !current.transcriptSegments[segmentIndex]) {
        return current;
      }
      const nextSegments = current.transcriptSegments.slice();
      nextSegments[segmentIndex] = { ...nextSegments[segmentIndex], speaker: newSpeaker };
      return { ...current, transcriptSegments: nextSegments };
    });
  }, []);

  return {
    isAnalyzing,
    analyzeProgress,
    analyzeError,
    liveSegments,
    result,
    envelope,
    finalAudioBlob,
    queuedChunkCount,
    processedChunkCount,
    startFileAnalysis,
    startRecordingAnalysis,
    stopRecordingAnalysis,
    cancel,
    reset,
    applyTextCorrection,
    loadExternalTranscript,
    updateSegmentSpeaker
  };
}
