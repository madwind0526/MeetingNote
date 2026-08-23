import { useCallback, useRef, useState } from "react";
import type { SttProviderId } from "../types/domain";
import { base64ToBlob, transcribeAudioRequest } from "../lib/api";
import type { TranscribeResult } from "../lib/api";
import { computeEnvelopeFromMono, decodeAudioFile, encodeWav, findQuietCutSample, mixDownToMono } from "../lib/audio";
import { reconcileUnregisteredSpeakers } from "../lib/speakerSessionLinking";
import type { SessionSpeaker } from "../lib/speakerSessionLinking";
import type { SystemAudioCapture } from "../lib/systemAudioCapture";

// Must match AudioAnalysisModal's BUCKET_COUNT so the incrementally-built envelope lines up with
// the same WaveformCanvas it feeds.
const BUCKET_COUNT = 900;

// Chunk boundary targeting - see src/lib/audio.ts's findQuietCutSample. TARGET is the plain
// fixed-duration fallback, MIN/MAX bound the search window for a quieter (word-boundary-safe) cut.
const TARGET_CHUNK_MS = 15000;
const MIN_CHUNK_MS = 12000;
const MAX_CHUNK_MS = 20000;
const QUIET_CHECK_INTERVAL_MS = 300;
const QUIET_AMPLITUDE_THRESHOLD = 0.02;

export interface ChunkedAnalysisOptions {
  provider: SttProviderId;
  model: string;
  fileName: string;
  attendeeNames: string[];
  agenda?: { no: number; durationMinutes: number; presenter: string }[];
  preprocessing: { vocalIsolation: boolean; noiseRemoval: boolean; normalize: boolean };
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
// and live-recording entry points. Splits audio into ~15s windows, runs each through the existing
// per-file STT+diarization job pipeline (transcribeAudioRequest, unchanged), and merges results in
// as each chunk finishes instead of waiting for the whole clip. Cross-chunk "미등록 화자" identity
// is kept consistent via reconcileUnregisteredSpeakers (registered/named speakers already stay
// consistent on their own via the server's persistent voice-profile registry).
export function useChunkedAudioAnalysis() {
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState(0);
  const [analyzeError, setAnalyzeError] = useState("");
  const [liveSegments, setLiveSegments] = useState<{ startSec: number; endSec: number; text: string }[]>([]);
  const [result, setResult] = useState<TranscribeResult | null>(null);
  const [envelope, setEnvelope] = useState<Float32Array | null>(null);
  const [finalAudioBlob, setFinalAudioBlob] = useState<Blob | null>(null);

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
      const minSamples = Math.round((MIN_CHUNK_MS / 1000) * sampleRate);
      const targetSamples = Math.round((TARGET_CHUNK_MS / 1000) * sampleRate);
      const maxSamples = Math.round((MAX_CHUNK_MS / 1000) * sampleRate);

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

      const quietBuffer = new Uint8Array(new ArrayBuffer(capture.analyser.fftSize));
      let lastRotateAt = performance.now();

      rotateTimerRef.current = window.setInterval(() => {
        if (cancelledRef.current || recordingFinishedRef.current) {
          return;
        }

        const elapsed = performance.now() - lastRotateAt;
        if (elapsed < MIN_CHUNK_MS) {
          return;
        }
        if (elapsed < MAX_CHUNK_MS && !isAnalyserQuiet(capture.analyser, quietBuffer)) {
          return;
        }

        lastRotateAt = performance.now();
        void capture.rotateSegment().then((blob) => {
          recordingQueueRef.current.push(blob);
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

  return {
    isAnalyzing,
    analyzeProgress,
    analyzeError,
    liveSegments,
    result,
    envelope,
    finalAudioBlob,
    startFileAnalysis,
    startRecordingAnalysis,
    stopRecordingAnalysis,
    cancel,
    reset,
    applyTextCorrection
  };
}
