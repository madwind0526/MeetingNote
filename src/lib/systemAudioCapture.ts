// through the speakers (the other side of a call, a shared video, etc.), not the microphone.
// Routes through electron/main.ts's setDisplayMediaRequestHandler, which auto-grants a loopback
// audio stream with no OS picker dialog. A plain getUserMedia({audio:true}) call would capture the
// mic instead and can't reach this at all - system audio loopback is only exposed through the
// screen/display-capture API family.

export interface SystemAudioCapture {
  stream: MediaStream;
  // Live time-domain data for a real-time waveform display while recording (see
  // components/LiveWaveform.tsx) - reading it doesn't consume/affect the recording itself, and
  // works as soon as the capture stream exists, independent of whether startRecording was called
  // yet - AudioAnalysisModal shows this immediately on mount so the popup isn't silent/blank while
  analyser: AnalyserNode;
  // Starts the first recording segment. Idempotent - a second call is a no-op, so the caller
  // doesn't need to track whether it already started recording itself.
  startRecording: () => void;
  // Ends the current recording segment and immediately starts a fresh one on the same stream, so
  // chunked analysis (useChunkedAudioAnalysis) can process each segment as its own independently
  // decodable file while recording continues with no coverage gap. A single MediaRecorder's later
  // chunks are headerless WebM continuation clusters that can't be decoded standalone - rotating to
  // a brand-new recorder per segment is what makes each one a valid, independently decodable file.
  // Starts recording itself if it hasn't started yet, as a safety net.
  rotateSegment: () => Promise<Blob>;
  // Stops recording entirely; resolves with the still-open final (possibly partial) segment, or an
  // empty blob if startRecording was never called (the user closed the popup before starting).
  stopAll: () => Promise<Blob>;
}

const RECORDER_MIME_TYPE = "audio/webm;codecs=opus";

export function isSystemAudioCaptureSupported(): boolean {
  return Boolean(navigator.mediaDevices?.getDisplayMedia) && Boolean(window.MediaRecorder);
}

function startRecorder(stream: MediaStream, onInterrupted?: (message: string) => void): { recorder: MediaRecorder; stopped: Promise<Blob> } {
  const recorder = new MediaRecorder(stream, { mimeType: RECORDER_MIME_TYPE });
  const chunks: Blob[] = [];

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  const stopped = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: RECORDER_MIME_TYPE }));
  });

  // Surfaces a real reason instead of recording just silently going nowhere - without this handler
  // a recorder error leaves the rotate timer calling rotateSegment/stopAll against a recorder that
  // will never fire another 'dataavailable' or 'stop', which looks from the UI like recording
  // simply stopped on its own with no explanation.
  recorder.onerror = (event) => {
    const error = (event as unknown as { error?: DOMException }).error;
    onInterrupted?.(`녹음 중 오류가 발생했습니다: ${error?.message || error?.name || "알 수 없는 오류"}`);
  };

  recorder.start();
  return { recorder, stopped };
}

export async function startSystemAudioCapture(onInterrupted?: (message: string) => void): Promise<SystemAudioCapture> {
  const displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });

  // The video track only exists because getDisplayMedia requires requesting it alongside audio -
  // stop it immediately so the OS doesn't keep treating this as an active screen share.
  displayStream.getVideoTracks().forEach((track) => track.stop());

  const audioStream = new MediaStream(displayStream.getAudioTracks());

  if (audioStream.getAudioTracks().length === 0) {
    audioStream.getTracks().forEach((track) => track.stop());
    throw new Error("PC 소리(스피커 출력)를 가져오지 못했습니다.");
  }

  // Fires if Windows/the OS ends the loopback capture on its own (e.g. the captured display source
  // becomes invalid) - same motivation as recorder.onerror above, so a capture that stops working
  // mid-recording shows a reason instead of just silently going quiet.
  audioStream.getAudioTracks()[0].addEventListener("ended", () => {
    onInterrupted?.("PC 소리 캡처가 예기치 않게 중단되었습니다. 녹음을 중지하고 다시 시도해 주세요.");
  });

  // Recording (the MediaRecorder actually capturing data) is deferred until startRecording is
  // popup opens, so opening the popup alone doesn't silently start recording.
  let current: { recorder: MediaRecorder; stopped: Promise<Blob> } | null = null;

  const startRecording = () => {
    if (current) {
      return;
    }
    current = startRecorder(audioStream, onInterrupted);
  };

  // Analyser branch is entirely separate from the recorder - reading it never touches the chunks
  // that end up in the saved file. Never connected to audioContext.destination, so nothing plays
  // back audibly (the original system audio is already playing on its own; this would double it).
  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  audioContext.createMediaStreamSource(audioStream).connect(analyser);

  const rotateSegment = async (): Promise<Blob> => {
    if (!current) {
      startRecording();
    }
    const ending = current!;
    // Start the replacement recorder in the same tick as stopping the old one, before awaiting
    // anything, so there's no window where neither recorder is capturing.
    current = startRecorder(audioStream, onInterrupted);
    ending.recorder.stop();
    return ending.stopped;
  };

  // Idempotent: AudioAnalysisModal can end up calling this twice (once explicitly when the user
  // MediaRecorder.stop() throws InvalidStateError on an already-inactive recorder, so a second
  // call has to return the same result instead of re-running the stop sequence.
  let stopPromise: Promise<Blob> | null = null;
  const stopAll = (): Promise<Blob> => {
    if (!stopPromise) {
      stopPromise = (async () => {
        let finalBlob = new Blob([], { type: RECORDER_MIME_TYPE });
        if (current) {
          const ending = current;
          if (ending.recorder.state !== "inactive") {
            ending.recorder.stop();
          }
          finalBlob = await ending.stopped;
        }
        audioStream.getTracks().forEach((track) => track.stop());
        displayStream.getTracks().forEach((track) => track.stop());
        void audioContext.close();
        return finalBlob;
      })();
    }
    return stopPromise;
  };

  return { stream: audioStream, analyser, startRecording, rotateSegment, stopAll };
}
