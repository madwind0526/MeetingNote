import spawn from "cross-spawn";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// "분석 시작" used to run full DiarizationPipeline clustering (below) on the whole recording -
// replaced by per-segment clip embeddings (see runEmbedClips/buildEmbedWorkerScript) so a
// diarization mistake that blends two different speakers into one cluster can no longer poison a
// voice profile (confirmed happening in live testing: two speakers in a synthetic clip matched
// the same stored profile after a repeat analysis run). Kept as a flag rather than deleting the
// clustering code below - flip back to true to restore the old whole-recording diarization pass.
export const AUTO_DIARIZE_ON_TRANSCRIBE = false;

// Shared by sttLocalWhisperCli.mjs and sttLocalWhisperX.mjs - stdout arrives in arbitrary-sized
// chunks that can split a log line in half, so a per-segment regex needs whole lines, not raw
// chunks. Buffers everything after the last newline and only hands complete lines to onLine.
export function createLineSplitter(onLine) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      onLine(line);
    }
  };
}

// Shared by sttLocalWhisperCli.mjs and sttLocalWhisperX.mjs - both need the exact same
// PYTHONIOENCODING/PYTHONUTF8 env (avoids the Korean-locale Windows cp949 UnicodeEncodeError
// crash documented in knowledge/trouble-shooting.md and the global memory-bank). PYTHONUNBUFFERED
// is what actually makes onStdoutChunk live: Python block-buffers stdout by default whenever it's
// not a TTY (i.e. always, once piped from a spawned child), so without this every print() sits in
// an internal buffer and only flushes in one big burst near process exit - which is why live
// segment/progress parsing looked like it only ever fired at the very end.
export function runPythonCommand(command, args, { timeoutMs, cwd, onStdoutChunk, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("음성 분석을 중지했습니다.", "AbortError"));
      return;
    }

    const child = spawn(command, args, {
      timeout: timeoutMs,
      cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" }
    });
    let stdout = "";
    let stderr = "";
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      // SIGTERM is enough for the whisper/whisperx CLI processes this runs (plain Python, no
      // ignored-signal shenanigans) - no need to escalate to SIGKILL.
      child.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onStdoutChunk?.(text);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (aborted) {
        reject(new DOMException("음성 분석을 중지했습니다.", "AbortError"));
        return;
      }
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

// whisperx.diarize.DiarizationPipeline.__call__(audio, ..., return_embeddings=True) returns
// (diarize_df, {speaker_label: embedding_vector}); assign_word_speakers accepts that same dict as
// speaker_embeddings. Both the Whisper-CLI path (which never had WhisperX's own --diarize flag)
// and the WhisperX path (which used to rely on that flag - a black box that never exposed
// embeddings) now go through this one script, so voice-profile matching (B3) works identically on
// both. INFO/warning logs from pyannote/whisperx during loading go to stdout, so results are
// written to their own files rather than trusted to stdout.
function buildDiarizeScript({ audioPath, whisperJsonPath, mergedJsonPath, embeddingsJsonPath, hfToken, minSpeakers, maxSpeakers, ffmpegBin, device }) {
  const ffmpegPath = JSON.stringify(ffmpegBin || "");

  return [
    "import os",
    `ffmpeg_bin = ${ffmpegPath}`,
    "if ffmpeg_bin:",
    "    os.environ['PATH'] = ffmpeg_bin + os.pathsep + os.environ.get('PATH', '')",
    "    if hasattr(os, 'add_dll_directory'):",
    "        os.add_dll_directory(ffmpeg_bin)",
    "import json",
    "from whisperx.diarize import DiarizationPipeline, assign_word_speakers",
    "",
    `with open(${JSON.stringify(whisperJsonPath)}, "r", encoding="utf-8") as f:`,
    "    whisper_result = json.load(f)",
    "",
    `pipeline = DiarizationPipeline(token=${JSON.stringify(hfToken)}, device=${JSON.stringify(device || "cuda")})`,
    `diarize_df, embeddings = pipeline(${JSON.stringify(audioPath)}` +
      (minSpeakers ? `, min_speakers=${minSpeakers}` : "") +
      (maxSpeakers ? `, max_speakers=${maxSpeakers}` : "") +
      ", return_embeddings=True)",
    "merged = assign_word_speakers(diarize_df, whisper_result, speaker_embeddings=embeddings)",
    `with open(${JSON.stringify(mergedJsonPath)}, "w", encoding="utf-8") as f:`,
    "    json.dump(merged, f, ensure_ascii=False)",
    "",
    "embeddings_serializable = {}",
    "for speaker, vector in (embeddings or {}).items():",
    "    if vector is None:",
    "        continue",
    "    try:",
    "        embeddings_serializable[speaker] = [float(x) for x in vector.tolist()]",
    "    except AttributeError:",
    "        embeddings_serializable[speaker] = [float(x) for x in vector]",
    `with open(${JSON.stringify(embeddingsJsonPath)}, "w", encoding="utf-8") as f:`,
    "    json.dump(embeddings_serializable, f)"
  ].join("\n");
}

// Best-effort: any failure here (no GPU memory, model download hiccup, missing token, etc.) falls
// back to the plain (non-diarized) transcript rather than failing the whole analysis - matches
// this project's existing "diarization never hard-fails transcription" behavior.
export async function runDiarizeWithEmbeddings({ pythonPath, workDir, audioPath, whisperResult, hfToken, speakerCount, ffmpegBin, device, timeoutMs, signal }) {
  const whisperJsonPath = path.join(workDir, "whisper-for-diarize.json");
  const mergedJsonPath = path.join(workDir, "whisper-diarized.json");
  const embeddingsJsonPath = path.join(workDir, "speaker-embeddings.json");
  const scriptPath = path.join(workDir, "run_diarize.py");

  try {
    await writeFile(whisperJsonPath, JSON.stringify(whisperResult), "utf8");
    await writeFile(
      scriptPath,
      buildDiarizeScript({
        audioPath,
        whisperJsonPath,
        mergedJsonPath,
        embeddingsJsonPath,
        hfToken,
        minSpeakers: speakerCount > 0 ? 1 : undefined,
        maxSpeakers: speakerCount > 0 ? speakerCount : undefined,
        ffmpegBin,
        device
      }),
      "utf8"
    );

    const result = await runPythonCommand(pythonPath, [scriptPath], { timeoutMs, cwd: workDir, signal });

    if (result.code !== 0) {
      return { whisperResult, embeddings: {} };
    }

    const mergedRaw = await readFile(mergedJsonPath, "utf8");
    let embeddings = {};
    try {
      embeddings = JSON.parse(await readFile(embeddingsJsonPath, "utf8"));
    } catch {
      embeddings = {};
    }

    return { whisperResult: JSON.parse(mergedRaw), embeddings };
  } catch {
    return { whisperResult, embeddings: {} };
  }
}

// Loads pyannote's raw embedding model once (not the full DiarizationPipeline - no clustering, so
// there's nothing for it to blend two speakers into) and computes one embedding per already-cropped
// clip file. Each clip is expected to already be a short, single-utterance WAV - callers are
// responsible for slicing it out of the source recording (see AudioAnalysisModal.tsx's
// sliceAudioBufferToWav) before writing it to clipPaths. A clip too short for a stable embedding,
// or any per-clip failure, comes back as null rather than failing the whole batch.
//
// Runs inside the persistent worker below (see runEmbedClips) rather than a fresh process per
// call - live timing showed `import torch`/pyannote + model load alone cost ~6-7s, ~80% of a
// typical call, and every manual per-segment speaker tag pays this same cost independently. The
// worker pays it once, loops reading one JSON request per stdin line, and replies with one JSON
// line per line - a request `{id, clips: {clipId: path}}` gets back `{id, embeddings: {...}}}`.
function buildEmbedWorkerScript({ hfToken, device, ffmpegBin }) {
  const ffmpegPath = JSON.stringify(ffmpegBin || "");

  return [
    "import os",
    `ffmpeg_bin = ${ffmpegPath}`,
    "if ffmpeg_bin:",
    "    os.environ['PATH'] = ffmpeg_bin + os.pathsep + os.environ.get('PATH', '')",
    "    if hasattr(os, 'add_dll_directory'):",
    "        os.add_dll_directory(ffmpeg_bin)",
    "import sys",
    "import json",
    "import wave",
    "import numpy as np",
    "import torch",
    "from pyannote.audio import Model, Inference",
    "",
    `model = Model.from_pretrained("pyannote/embedding", token=${JSON.stringify(hfToken)})`,
    `inference = Inference(model, window="whole", device=torch.device(${JSON.stringify(device || "cuda")}))`,
    "",
    // Clips are always 16-bit PCM mono WAV (see sliceAudioBufferToWav/encodeWav in src/lib/audio.ts) -
    // read them with the stdlib wave module instead of torchaudio/torchcodec, which need an audio
    // backend (sox/soundfile/torchcodec native libs) that isn't installed in this venv.
    "def load_wav(clip_path):",
    "    with wave.open(clip_path, 'rb') as wav_file:",
    "        sample_rate = wav_file.getframerate()",
    "        frames = wav_file.readframes(wav_file.getnframes())",
    "    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0",
    "    waveform = torch.from_numpy(samples).unsqueeze(0)",
    "    return waveform, sample_rate",
    "",
    // Marks the model as loaded so ensureEmbedWorker's ready-promise can resolve - printed to
    // stdout, which is otherwise reserved for exactly one JSON line per response (library
    // warnings/info all go to stderr, confirmed by direct testing, so this stays clean).
    "print(json.dumps({\"ready\": True}), flush=True)",
    "",
    "for line in sys.stdin:",
    "    line = line.strip()",
    "    if not line:",
    "        continue",
    "    try:",
    "        request = json.loads(line)",
    "    except Exception:",
    "        continue",
    "    request_id = request.get(\"id\")",
    "    clip_paths = request.get(\"clips\", {})",
    "    results = {}",
    "    for clip_id, clip_path in clip_paths.items():",
    "        try:",
    "            waveform, sample_rate = load_wav(clip_path)",
    "            vector = inference({\"waveform\": waveform, \"sample_rate\": sample_rate})",
    "            try:",
    "                results[clip_id] = [float(x) for x in vector.tolist()]",
    "            except AttributeError:",
    "                results[clip_id] = [float(x) for x in vector]",
    "        except Exception:",
    "            results[clip_id] = None",
    "    print(json.dumps({\"id\": request_id, \"embeddings\": results}), flush=True)"
  ].join("\n");
}

// Module-level singleton: one embedding worker per running server process, lazily spawned on
// first use and kept resident for the process's lifetime (not detached, so it dies naturally with
// the dev server/Electron backend - no separate cleanup needed). Re-spawned if the requested
// params (device, token, ...) change, or if it crashes/hangs.
let embedWorker = null;
let nextEmbedRequestId = 1;

function paramsMatch(a, b) {
  return a.pythonPath === b.pythonPath && a.hfToken === b.hfToken && a.device === b.device && a.ffmpegBin === b.ffmpegBin;
}

function killEmbedWorker(reason) {
  if (!embedWorker) {
    return;
  }
  const dying = embedWorker;
  embedWorker = null;
  try {
    dying.child.kill();
  } catch {
    // already dead
  }
  for (const { reject, timer } of dying.pending.values()) {
    clearTimeout(timer);
    reject(new Error(reason));
  }
  dying.pending.clear();
}

async function ensureEmbedWorker({ pythonPath, hfToken, device, ffmpegBin }) {
  const params = { pythonPath, hfToken, device, ffmpegBin };

  if (embedWorker && !paramsMatch(embedWorker.params, params)) {
    killEmbedWorker("Embedding worker params changed.");
  }
  if (embedWorker) {
    await embedWorker.ready;
    return embedWorker;
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "meetingnote-embed-worker-"));
  const scriptPath = path.join(workDir, "embed_worker.py");
  await writeFile(scriptPath, buildEmbedWorkerScript(params), "utf8");

  const child = spawn(pythonPath, [scriptPath], {
    cwd: workDir,
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" }
  });

  const pending = new Map();
  let readyResolve;
  let readyReject;
  let readyFired = false;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const entry = { child, ready, params, pending };
  embedWorker = entry;

  let stdoutBuffer = "";
  child.stdout?.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (message.ready && !readyFired) {
        readyFired = true;
        readyResolve();
        continue;
      }
      const requestEntry = pending.get(message.id);
      if (requestEntry) {
        clearTimeout(requestEntry.timer);
        pending.delete(message.id);
        requestEntry.resolve(message.embeddings || {});
      }
    }
  });

  child.on("error", (error) => {
    if (!readyFired) {
      readyFired = true;
      readyReject(error);
    }
    if (embedWorker === entry) {
      killEmbedWorker("Embedding worker failed to start.");
    }
  });
  child.on("exit", () => {
    if (!readyFired) {
      readyFired = true;
      readyReject(new Error("Embedding worker exited before becoming ready."));
    }
    if (embedWorker === entry) {
      killEmbedWorker("Embedding worker exited.");
    }
  });

  await ready;
  return entry;
}

// Best-effort per clip (mirrors runDiarizeWithEmbeddings): a worker start/crash fails the whole
// batch (returns {} - caller treats every clip as unmatched), but an individual clip's embedding
// failure is already isolated to null by the worker script above.
export async function runEmbedClips({ pythonPath, workDir, clips, hfToken, device, ffmpegBin, timeoutMs, signal }) {
  try {
    if (signal?.aborted) {
      return { embeddings: {} };
    }

    const clipPaths = {};
    for (const clip of clips) {
      const clipPath = path.join(workDir, `clip-${clip.id}.wav`);
      await writeFile(clipPath, clip.buffer);
      clipPaths[clip.id] = clipPath;
    }

    const entry = await ensureEmbedWorker({ pythonPath, hfToken, device, ffmpegBin });
    const requestId = nextEmbedRequestId++;

    const embeddings = await new Promise((resolve, reject) => {
      const onAbort = () => {
        entry.pending.delete(requestId);
        reject(new DOMException("음성 분석을 중지했습니다.", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        entry.pending.delete(requestId);
        signal?.removeEventListener("abort", onAbort);
        // A response taking this long suggests the worker itself is stuck (not just a slow clip -
        // per-clip inference is sub-second, see the timing breakdown in progress.md) - force a
        // respawn so the next call isn't stuck behind the same hang.
        killEmbedWorker("Embedding worker request timed out.");
        reject(new Error("Embedding worker request timed out."));
      }, timeoutMs ?? 60000);

      entry.pending.set(requestId, {
        resolve: (value) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject,
        timer
      });

      entry.child.stdin?.write(`${JSON.stringify({ id: requestId, clips: clipPaths })}\n`);
    });

    return { embeddings };
  } catch {
    return { embeddings: {} };
  }
}
