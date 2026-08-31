// Browser-only audio pipeline: decode an uploaded file via Web Audio API, produce waveform
// envelope data for canvas rendering, and re-encode as a WAV Blob for upload to the server STT
// endpoint. No Node APIs are used here. Actual preprocessing (Demucs/정규화/DeNoise) happens
// server-side in the fixed order Demucs -> 정규화 -> DeNoise - see server/audio/audioPreprocess.mjs
// - so Demucs always sees this untouched original mixdown, never audio 정규화/DeNoise already
// altered client-side first.

// 16000 Hz because that's the rate every local STT/diarization model here actually runs at
// internally (Whisper, WhisperX, pyannote all resample to 16kHz regardless of input). Decoding at
// the OS's default output rate (typically 48kHz) instead - the default when no rate is requested -
// forces a lossy 16k->48k->16k round trip once this audio reaches the server, which measurably
// degrades pyannote's speaker embeddings enough to merge distinct speakers into one cluster (the
// transcribed text stays readable either way; diarization's finer acoustic detail does not).
const TARGET_SAMPLE_RATE = 16000;

export async function decodeAudioFile(file: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });

  try {
    return await audioContext.decodeAudioData(arrayBuffer);
  } finally {
    void audioContext.close();
  }
}

export function mixDownToMono(audioBuffer: AudioBuffer): Float32Array {
  const channelCount = audioBuffer.numberOfChannels;
  const mono = new Float32Array(audioBuffer.length);

  if (channelCount === 0) {
    return mono;
  }

  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    const channelData = audioBuffer.getChannelData(channelIndex);
    for (let sampleIndex = 0; sampleIndex < channelData.length; sampleIndex += 1) {
      mono[sampleIndex] += channelData[sampleIndex];
    }
  }

  for (let sampleIndex = 0; sampleIndex < mono.length; sampleIndex += 1) {
    mono[sampleIndex] /= channelCount;
  }

  return mono;
}

// Crops [startSec, endSec) out of an already-decoded AudioBuffer and re-encodes just that range
// as its own standalone WAV blob - used to build a short, single-utterance clip for per-segment
// voice-profile enrollment/classification (see AudioAnalysisModal.tsx) without re-uploading the
// whole recording just to embed one line.
export function sliceAudioBufferToWav(buffer: AudioBuffer, startSec: number, endSec: number): Blob {
  const mono = mixDownToMono(buffer);
  const startSample = Math.max(0, Math.floor(startSec * buffer.sampleRate));
  const endSample = Math.min(mono.length, Math.ceil(endSec * buffer.sampleRate));
  return encodeWav(mono.subarray(startSample, Math.max(startSample, endSample)), buffer.sampleRate);
}

export function computeEnvelopeFromMono(mono: Float32Array, bucketCount: number): Float32Array {
  const envelope = new Float32Array(bucketCount);

  if (bucketCount <= 0 || mono.length === 0) {
    return envelope;
  }

  const samplesPerBucket = mono.length / bucketCount;

  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const start = Math.floor(bucketIndex * samplesPerBucket);
    const end = Math.min(mono.length, Math.floor((bucketIndex + 1) * samplesPerBucket));

    let peak = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      const amplitude = Math.abs(mono[sampleIndex]);
      if (amplitude > peak) {
        peak = amplitude;
      }
    }

    envelope[bucketIndex] = peak;
  }

  return envelope;
}

export function computeEnvelope(audioBuffer: AudioBuffer, bucketCount: number): Float32Array {
  return computeEnvelopeFromMono(mixDownToMono(audioBuffer), bucketCount);
}

// 20ms at TARGET_SAMPLE_RATE (16kHz) - short-window RMS scoring granularity for findQuietCutSample.
const SILENCE_WINDOW_SAMPLES = Math.round(TARGET_SAMPLE_RATE * 0.02);

function windowRms(mono: Float32Array, start: number, end: number): number {
  let sumSquares = 0;
  const count = Math.max(1, end - start);
  for (let index = start; index < end; index += 1) {
    sumSquares += mono[index] * mono[index];
  }
  return Math.sqrt(sumSquares / count);
}

// Same RMS calculation as findQuietCutSample's per-window scoring, but over an entire chunk - used
// by useChunkedAudioAnalysis to skip sending a near-silent chunk to STT at all (see its
// SILENCE_RMS_THRESHOLD).
export function computeRms(mono: Float32Array): number {
  return windowRms(mono, 0, mono.length);
}

// Used by chunked analysis (useChunkedAudioAnalysis) to avoid slicing a chunk boundary through the
// middle of a word: scans [searchStartSample, searchEndSample) for the quietest short window and
// returns its center as the cut point, instead of always cutting at a fixed sample count. Falls
// back to `fallbackSample` (the plain fixed-duration boundary) when the whole search window is
// continuously loud (e.g. uninterrupted speech spans it) rather than waiting for silence that never
// comes - an imperfect cut is better than an unbounded chunk.
export function findQuietCutSample(
  mono: Float32Array,
  searchStartSample: number,
  searchEndSample: number,
  fallbackSample: number,
  quietThreshold = 0.02
): number {
  const start = Math.max(0, Math.min(searchStartSample, mono.length));
  const end = Math.max(start, Math.min(searchEndSample, mono.length));

  let bestSample = -1;
  let bestRms = Infinity;

  for (let cursor = start; cursor + SILENCE_WINDOW_SAMPLES <= end; cursor += SILENCE_WINDOW_SAMPLES) {
    const rms = windowRms(mono, cursor, cursor + SILENCE_WINDOW_SAMPLES);
    if (rms < bestRms) {
      bestRms = rms;
      bestSample = cursor + Math.floor(SILENCE_WINDOW_SAMPLES / 2);
    }
  }

  if (bestSample === -1 || bestRms > quietThreshold) {
    return Math.max(0, Math.min(fallbackSample, mono.length));
  }

  return bestSample;
}

export function encodeWav(mono: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = mono.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset: number, value: string) {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  }

  // Standard 44-byte RIFF/WAVE header for 16-bit PCM mono audio.
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono channel
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true); // bits per sample
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let index = 0; index < mono.length; index += 1) {
    // setInt16 truncates toward zero on a non-integer input (ECMAScript ToIntegerOrInfinity), not
    // round-to-nearest - without Math.round this quantizes every sample with a consistent ~0.5 LSB
    // bias instead of proper rounding.
    const intSample = Math.round(Math.max(-1, Math.min(1, mono[index])) * 32767);
    view.setInt16(offset, intSample, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}
