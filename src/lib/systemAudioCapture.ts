// Captures PC 시스템 오디오 (speaker output) for MeetingFormModal's "PC 소리 녹음" - what plays
// through the speakers (the other side of a call, a shared video, etc.), not the microphone.
// Routes through electron/main.ts's setDisplayMediaRequestHandler, which auto-grants a loopback
// audio stream with no OS picker dialog. A plain getUserMedia({audio:true}) call would capture the
// mic instead and can't reach this at all - system audio loopback is only exposed through the
// screen/display-capture API family.

export interface SystemAudioRecording {
  stream: MediaStream;
  recorder: MediaRecorder;
  // Live time-domain data for a real-time waveform display while recording (see
  // components/LiveWaveform.tsx) - reading it doesn't consume/affect the recording itself, unlike
  // the MediaRecorder chunks.
  analyser: AnalyserNode;
  // Stop recording and get back everything captured since start() - the recorder's final
  // "stop" event fires asynchronously, so this is a promise rather than a plain return value.
  stop: () => Promise<Blob>;
}

const RECORDER_MIME_TYPE = "audio/webm;codecs=opus";

export function isSystemAudioCaptureSupported(): boolean {
  return Boolean(navigator.mediaDevices?.getDisplayMedia) && Boolean(window.MediaRecorder);
}

export async function startSystemAudioRecording(
  onChunk?: (chunk: Blob) => void
): Promise<SystemAudioRecording> {
  const displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });

  // The video track only exists because getDisplayMedia requires requesting it alongside audio -
  // stop it immediately so the OS doesn't keep treating this as an active screen share.
  displayStream.getVideoTracks().forEach((track) => track.stop());

  const audioStream = new MediaStream(displayStream.getAudioTracks());

  if (audioStream.getAudioTracks().length === 0) {
    audioStream.getTracks().forEach((track) => track.stop());
    throw new Error("PC 소리(스피커 출력)를 가져오지 못했습니다.");
  }

  const recorder = new MediaRecorder(audioStream, { mimeType: RECORDER_MIME_TYPE });
  const chunks: Blob[] = [];

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
      onChunk?.(event.data);
    }
  };

  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  // A timeslice keeps chunks flowing into ondataavailable while recording is still in progress -
  // both for the live-captions preview (see MeetingFormModal) and so nothing is lost if the app
  // crashes mid-recording, instead of only getting data once at the very end.
  recorder.start(1000);

  // Analyser branch is entirely separate from the recorder - reading it never touches the chunks
  // that end up in the saved file. Never connected to audioContext.destination, so nothing plays
  // back audibly (the original system audio is already playing on its own; this would double it).
  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  audioContext.createMediaStreamSource(audioStream).connect(analyser);

  const stop = async (): Promise<Blob> => {
    if (recorder.state !== "inactive") {
      recorder.stop();
      await stopped;
    }
    audioStream.getTracks().forEach((track) => track.stop());
    displayStream.getTracks().forEach((track) => track.stop());
    void audioContext.close();
    return new Blob(chunks, { type: RECORDER_MIME_TYPE });
  };

  return { stream: audioStream, recorder, analyser, stop };
}
