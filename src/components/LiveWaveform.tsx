import { useEffect, useRef } from "react";

interface LiveWaveformProps {
  analyser: AnalyserNode | null;
  height: number;
}

const BAR_COLOR = "#2f9e8f";
const BAR_WIDTH = 2;
const BAR_GAP = 2;

// animation frame instead of going through React state, since sampling the analyser at ~60fps
// would otherwise re-render the whole (fairly large) meeting form that many times per second.
export function LiveWaveform({ analyser, height }: LiveWaveformProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const barsRef = useRef<number[]>([]);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const frameRef = useRef<number>(0);

  useEffect(() => {
    barsRef.current = [];

    if (!analyser) {
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (canvas && context) {
        context.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }

    let cancelled = false;

    const tick = () => {
      if (cancelled) {
        return;
      }

      const canvas = canvasRef.current;
      const container = containerRef.current;

      if (canvas && container) {
        const width = Math.max(1, container.clientWidth);
        if (canvas.width !== width) {
          canvas.width = width;
        }
        if (canvas.height !== height) {
          canvas.height = height;
        }

        if (!dataRef.current || dataRef.current.length !== analyser.fftSize) {
          dataRef.current = new Uint8Array(new ArrayBuffer(analyser.fftSize));
        }
        analyser.getByteTimeDomainData(dataRef.current);

        let peak = 0;
        for (let index = 0; index < dataRef.current.length; index += 1) {
          const deviation = Math.abs(dataRef.current[index] - 128) / 128;
          if (deviation > peak) {
            peak = deviation;
          }
        }

        const bars = barsRef.current;
        bars.push(peak);
        const maxBars = Math.max(1, Math.floor(canvas.width / (BAR_WIDTH + BAR_GAP)));
        while (bars.length > maxBars) {
          bars.shift();
        }

        const context = canvas.getContext("2d");
        if (context) {
          context.clearRect(0, 0, canvas.width, canvas.height);
          const midY = canvas.height / 2;

          bars.forEach((value, index) => {
            const x = canvas.width - (bars.length - index) * (BAR_WIDTH + BAR_GAP);
            const barHeight = Math.max(2, value * canvas.height);
            context.fillStyle = BAR_COLOR;
            context.fillRect(x, midY - barHeight / 2, BAR_WIDTH, barHeight);
          });
        }
      }

      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frameRef.current);
    };
  }, [analyser, height]);

  return (
    <div className="live-waveform" ref={containerRef} style={{ height }}>
      <canvas ref={canvasRef} />
    </div>
  );
}
