import { useTimeline } from "@opentui/react";
import { useEffect, useRef, useState } from "react";

const WAVE_MS = 260;
const motionless = () => process.env.DEVVER_REDUCED_MOTION !== undefined;

export function useLineageWave(selectedId: string | undefined) {
  const [progress, setProgress] = useState(1);
  const lead = useRef({ at: 1 });
  const wave = useTimeline({ autoplay: false, duration: WAVE_MS });
  useEffect(() => {
    if (motionless()) {
      setProgress(1);
      return () => {
        wave.pause();
      };
    }
    lead.current.at = 0;
    setProgress(0);
    wave.add(
      lead.current,
      {
        at: 1,
        duration: WAVE_MS,
        ease: "outQuad",
        once: true,
        onUpdate: () => {
          setProgress(lead.current.at);
        },
        onComplete: () => {
          setProgress(1);
        },
      },
      0
    );
    wave.restart();
    return () => {
      wave.pause();
    };
  }, [selectedId, wave]);
  return progress;
}
