import { useEffect } from "react";

interface IntroScreenProps {
  buildLabel: string;
  logoVersion: number;
  onFinished: () => void;
}

const AUTO_DISMISS_MS = 3000;

export function IntroScreen({ buildLabel, logoVersion, onFinished }: IntroScreenProps) {
  useEffect(() => {
    window.addEventListener("keydown", onFinished);
    const timeoutId = window.setTimeout(onFinished, AUTO_DISMISS_MS);

    return () => {
      window.removeEventListener("keydown", onFinished);
      window.clearTimeout(timeoutId);
    };
  }, [onFinished]);

  return (
    <div className="intro-screen" onClick={onFinished} role="presentation">
      <div className="intro-content">
        <img alt="MeetingNote" className="intro-logo" onError={onFinished} src={`/logo.png?v=${logoVersion}`} />
        <p className="intro-caption">
          <strong>MeetingNote</strong>
          <span>{buildLabel}</span>
        </p>
      </div>
    </div>
  );
}
