// Captures PC 시스템 오디오 (speaker output) for AudioAnalysisModal's recording mode - what plays
// through the speakers (the other side of a call, a shared video, etc.), not the microphone.
// Routes through electron/main.ts's setDisplayMediaRequestHandler, which auto-grants a loopback
// audio stream with no OS picker dialog. A plain getUserMedia({audio:true}) call would capture the
// mic instead and can't reach this at all - system audio loopback is only exposed through the
// screen/display-capture API family.

export interface SystemAudioCapture {
  stream: MediaStream;
  // Live time-domain data for a real-time waveform display while recording (see
  // components/LiveWaveform.tsx) - reading it doesn't consume/affect the recording itself.
  analyser: AnalyserNode;
  // Ends the current recording segment and immediately starts a fresh one on the same stream, so
  // chunked analysis (useChunkedAudioAnalysis) can process each segment as its own independently
  // decodable file while recording continues with no coverage gap. A single MediaRecorder's later
  // chunks are headerless WebM continuation clusters that can't be decoded standalone - rotating to
  // a brand-new recorder per segment is what makes each one a valid, independently decodable file.
  rotateSegment: () => Promise<Blob>;
  // Stops recording entirely; resolves with the still-open final (possibly partial) segment.
  stopAll: () => Promise<Blob>;
}

const RECORDER_MIME_TYPE = "audio/webm;codecs=opus";

export function isSystemAudioCaptureSupported(): boolean {
  return Boolean(navigator.mediaDevices?.getDisplayMedia) && Boolean(window.MediaRecorder);
}

function startRecorder(stream: MediaStream): { recorder: MediaRecorder; stopped: Promise<Blob> } {
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

  recorder.start();
  return { recorder, stopped };
}

export async function startSystemAudioCapture(): Promise<SystemAudioCapture> {
  const displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });

  // The video track only exists because getDisplayMedia requires requesting it alongside audio -
  // stop it immediately so the OS doesn't keep treating this as an active screen share.
  displayStream.getVideoTracks().forEach((track) => track.stop());

  const audioStream = new MediaStream(displayStream.getAudioTracks());

  if (audioStream.getAudioTracks().length === 0) {
    audioStream.getTracks().forEach((track) => track.stop());
    throw new Error("PC 소리(스피커 출력)를 가져오지 못했습니다.");
  }

  let current = startRecorder(audioStream);

  // Analyser branch is entirely separate from the recorder - reading it never touches the chunks
  // that end up in the saved file. Never connected to audioContext.destination, so nothing plays
  // back audibly (the original system audio is already playing on its own; this would double it).
  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  audioContext.createMediaStreamSource(audioStream).connect(analyser);

  const rotateSegment = async (): Promise<Blob> => {
    const ending = current;
    // Start the replacement recorder in the same tick as stopping the old one, before awaiting
    // anything, so there's no window where neither recorder is capturing.
    current = startRecorder(audioStream);
    ending.recorder.stop();
    return ending.stopped;
  };

  // Idempotent: AudioAnalysisModal can end up calling this twice (once explicitly when the user
  // clicks "녹음 중지", again from its mount-effect's cleanup when the modal later unmounts) -
  // MediaRecorder.stop() throws InvalidStateError on an already-inactive recorder, so a second
  // call has to return the same result instead of re-running the stop sequence.
  let stopPromise: Promise<Blob> | null = null;
  const stopAll = (): Promise<Blob> => {
    if (!stopPromise) {
      stopPromise = (async () => {
        const ending = current;
        if (ending.recorder.state !== "inactive") {
          ending.recorder.stop();
        }
        const finalBlob = await ending.stopped;
        audioStream.getTracks().forEach((track) => track.stop());
        displayStream.getTracks().forEach((track) => track.stop());
        void audioContext.close();
        return finalBlob;
      })();
    }
    return stopPromise;
  };

  return { stream: audioStream, analyser, rotateSegment, stopAll };
}
