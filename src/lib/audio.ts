// Browser-only audio pipeline: decode an uploaded file via Web Audio API, produce waveform
// envelope data for canvas rendering, apply simple client-side preprocessing, and re-encode as
// a WAV Blob for upload to the server STT endpoint. No Node APIs are used here.

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

export function computeEnvelope(audioBuffer: AudioBuffer, bucketCount: number): Float32Array {
  const mono = mixDownToMono(audioBuffer);
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

export function processMonoPcm(mono: Float32Array, preprocessing: { noiseRemoval: boolean; normalize: boolean }): Float32Array {
  let result = Float32Array.from(mono);

  if (preprocessing.noiseRemoval) {
    let peak = 0;
    for (let index = 0; index < result.length; index += 1) {
      const amplitude = Math.abs(result[index]);
      if (amplitude > peak) {
        peak = amplitude;
      }
    }

    // Simple noise gate (not real spectral denoising) - zero out samples quieter than 2% of peak.
    const gateThreshold = peak * 0.02;
    for (let index = 0; index < result.length; index += 1) {
      if (Math.abs(result[index]) < gateThreshold) {
        result[index] = 0;
      }
    }
  }

  if (preprocessing.normalize) {
    let peak = 0;
    for (let index = 0; index < result.length; index += 1) {
      const amplitude = Math.abs(result[index]);
      if (amplitude > peak) {
        peak = amplitude;
      }
    }

    if (peak > 0) {
      const scale = 0.98 / peak;
      const scaled = new Float32Array(result.length);
      for (let index = 0; index < result.length; index += 1) {
        scaled[index] = result[index] * scale;
      }
      result = scaled;
    }
  }

  return result;
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
