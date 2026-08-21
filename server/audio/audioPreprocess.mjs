import { isolateVocalsWithDemucs } from "./vocalIsolation.mjs";

// Minimal WAV reader/writer for the server side. Mirrors src/lib/audio.ts's browser-only decode
// (Web Audio API) + encodeWav pair, but has to be self-contained here since Node has no
// AudioContext. Reads whatever WAV shows up at this point in the pipeline - either the client's
// own re-encoded upload (always 16-bit PCM mono, fixed 44-byte header) or Demucs's vocals.wav
// (torchaudio output - typically 16/24/32-bit, sometimes stereo, extra chunks before "data") - so
// this walks RIFF chunks properly instead of assuming a fixed header layout.
function parseWav(buffer) {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("WAV 파일 형식이 아닙니다.");
  }

  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;

    if (chunkId === "fmt ") {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        numChannels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14)
      };
    } else if (chunkId === "data") {
      dataOffset = chunkStart;
      dataSize = Math.min(chunkSize, buffer.length - chunkStart);
    }

    // Chunks are word-aligned - an odd-sized chunk has one byte of padding after it.
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt || dataOffset < 0) {
    throw new Error("WAV 파일에서 오디오 데이터를 찾지 못했습니다.");
  }

  const { numChannels, sampleRate, bitsPerSample, audioFormat } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.floor(dataSize / (bytesPerSample * numChannels));
  const mono = new Float32Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;

    for (let channel = 0; channel < numChannels; channel += 1) {
      const sampleOffset = dataOffset + (frame * numChannels + channel) * bytesPerSample;
      let value;

      if (audioFormat === 3 && bitsPerSample === 32) {
        value = buffer.readFloatLE(sampleOffset);
      } else if (bitsPerSample === 16) {
        value = buffer.readInt16LE(sampleOffset) / 32768;
      } else if (bitsPerSample === 24) {
        let intValue = buffer[sampleOffset] | (buffer[sampleOffset + 1] << 8) | (buffer[sampleOffset + 2] << 16);
        if (intValue & 0x800000) {
          intValue -= 0x1000000;
        }
        value = intValue / 8388608;
      } else if (bitsPerSample === 32) {
        value = buffer.readInt32LE(sampleOffset) / 2147483648;
      } else if (bitsPerSample === 8) {
        value = (buffer[sampleOffset] - 128) / 128;
      } else {
        throw new Error(`지원하지 않는 WAV 비트 심도입니다. (${bitsPerSample}bit)`);
      }

      sum += value;
    }

    mono[frame] = sum / numChannels;
  }

  return { samples: mono, sampleRate };
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * bytesPerSample, 28);
  buffer.writeUInt16LE(bytesPerSample, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + index * bytesPerSample);
  }

  return buffer;
}

function peakAmplitude(samples) {
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const amplitude = Math.abs(samples[index]);
    if (amplitude > peak) {
      peak = amplitude;
    }
  }
  return peak;
}

// Same math as src/lib/audio.ts's processMonoPcm - kept identical on purpose so "정규화"/"DeNoise"
// behave the same regardless of whether they end up running client-side or here.
function applyNormalize(samples) {
  const peak = peakAmplitude(samples);
  if (peak === 0) {
    return samples;
  }
  const scale = 0.98 / peak;
  const scaled = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    scaled[index] = samples[index] * scale;
  }
  return scaled;
}

function applyNoiseGate(samples) {
  const peak = peakAmplitude(samples);
  const gateThreshold = peak * 0.02;
  const result = Float32Array.from(samples);
  for (let index = 0; index < result.length; index += 1) {
    if (Math.abs(result[index]) < gateThreshold) {
      result[index] = 0;
    }
  }
  return result;
}

// Runs the full server-side preprocessing chain in the fixed order Demucs -> 정규화 -> DeNoise:
// vocal isolation must see the original mixed-down recording to separate cleanly, and normalizing
// before the noise gate means the gate's fixed 2%-of-peak threshold is judged against a
// consistent, already-leveled signal instead of whatever gain the raw/Demucs-separated track
// happened to come in at.
export async function preprocessAudio(rawBuffer, fileName, preprocessing, signal) {
  let buffer = rawBuffer;
  let changed = false;

  if (preprocessing.vocalIsolation) {
    buffer = await isolateVocalsWithDemucs(buffer, fileName, signal);
    changed = true;
  }

  if (preprocessing.normalize || preprocessing.noiseRemoval) {
    const { samples, sampleRate } = parseWav(buffer);
    let processed = samples;

    if (preprocessing.normalize) {
      processed = applyNormalize(processed);
    }
    if (preprocessing.noiseRemoval) {
      processed = applyNoiseGate(processed);
    }

    buffer = encodeWav(processed, sampleRate);
    changed = true;
  }

  return { buffer, changed };
}
