import { useEffect, useRef } from "react";

import { FLAG_KINDS } from "../lib/traceMarkers.js";

/**
 * The FDR strip: three pens plotting real measurements from the microphone
 * stream, exactly as the backend's tell detectors see the audio.
 *
 *   LEVEL  (silver) — RMS amplitude of the current 50 ms chunk
 *   PACE   (amber)  — speech onsets per 5 s window, normalized
 *   PAUSE  (teal)   — silence gap since the last voiced chunk, normalized
 *
 * The strip is measurement, not decoration: every pixel comes from the same
 * PCM chunks that are streamed to the backend. Backend tell events drop
 * orange flag ticks onto the rail at the current position — the same
 * parameter-exceedance marks the report will cite later.
 *
 * Props: { bindApi: (api) => void } — the parent receives
 *   { pushAudio(base64), addFlag(label, tellType) }.
 *
 * When a backend tell arrives, addFlag() places an orange marker ON the
 * corresponding pen line at the moment that detection refers to (estimated
 * from the client traces via lib/traceMarkers.js), so the client-measured
 * pens and the backend verdict read as one instrument. The marker is display
 * only; the client never runs its own tell detection.
 */

const WINDOW_SAMPLES = 300; // ~15 s of 50 ms chunks on screen
const PACE_WINDOW = 100; // samples in the 5 s pace window
const PAUSE_SPAN = 100; // samples (5 s) at which the pause pen saturates
const VOICED_RMS = 0.02; // above this a chunk counts as speech

/** Decode a base64 PCM16 chunk to RMS amplitude. */
function chunkRms(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const v = pcm[i] / 0x8000;
    sum += v * v;
  }
  return Math.sqrt(sum / pcm.length);
}

const TRACES = [
  { key: "level", color: "#a8a79f", height: 0.4, mid: true },
  { key: "pace", color: "#d9a441", height: 0.32, mid: false },
  { key: "pause", color: "#5e9e9c", height: 0.24, mid: false },
];

export default function TraceStrip({ bindApi }) {
  const canvasRef = useRef(null);
  const dataRef = useRef({ level: [], pace: [], pause: [], onsets: [], flags: [] });
  const speakingRef = useRef(false);
  const lastVoiceAtRef = useRef(-1);
  const dirtyRef = useRef(false);
  const rafRef = useRef(0);

  useEffect(() => {
    const data = dataRef.current;

    const api = {
      /** Feed one 50 ms mic chunk (same payload that goes to the backend). */
      pushAudio(base64) {
        const index = data.level.length;
        const rms = chunkRms(base64);
        const voiced = rms > VOICED_RMS;

        data.level.push(rms);
        if (voiced) {
          lastVoiceAtRef.current = index;
          if (!speakingRef.current) data.onsets.push(index);
        }
        speakingRef.current = voiced;

        const cutoff = index - PACE_WINDOW;
        data.onsets = data.onsets.filter((x) => x >= cutoff);
        data.pace.push(Math.min(1, data.onsets.length / 6));

        const silentFor = lastVoiceAtRef.current < 0 ? index : index - lastVoiceAtRef.current;
        data.pause.push(voiced ? 0 : Math.min(1, silentFor / PAUSE_SPAN));

        dirtyRef.current = true;
      },

      /**
       * Backend tell event: drop an orange exceedance flag at the playhead,
       * plus a marker on the referred trace at the moment it refers to.
       * `tellType` keys into FLAG_KINDS; unknown kinds fall back to the
       * detection-arrival playhead on the level lane.
       */
      addFlag(label, tellType) {
        const arrival = data.level.length - 1;
        const spec = FLAG_KINDS[tellType] || null;
        let markerIndex = arrival;
        let trace = "level";
        if (spec) {
          trace = spec.trace;
          const found = spec.find(data, arrival, data.onsets);
          if (found >= 0) markerIndex = found;
        }
        data.flags.push({
          index: arrival,
          markerIndex,
          trace,
          label: label || "EXCEEDANCE",
          at: performance.now(),
        });
        dirtyRef.current = true;
      },
    };

    if (typeof bindApi === "function") bindApi(api);
    return () => bindApi?.(null);
    // bindApi must be stable (useCallback) in the parent.
  }, [bindApi]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext("2d");

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const data = dataRef.current;
      const total = data.level.length;
      const start = Math.max(0, total - WINDOW_SAMPLES);
      const visible = total - start;
      if (visible > 1) {
        // etched grid
        ctx.strokeStyle = "rgba(168,167,159,0.08)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x <= width; x += 28) {
          ctx.moveTo(x + 0.5, 0);
          ctx.lineTo(x + 0.5, height);
        }
        ctx.stroke();

        // traces, oldest left
        for (const trace of TRACES) {
          const series = data[trace.key];
          const mid = trace.mid ? height * 0.55 : height - 8 - trace.height * height * 0.5;
          ctx.beginPath();
          for (let i = start; i < total; i += 1) {
            const x = ((i - start) / (WINDOW_SAMPLES - 1)) * width;
            const v = series[i] || 0;
            const y = mid - v * trace.height * height;
            if (i === start) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = trace.color;
          ctx.lineWidth = 1.5;
          ctx.shadowColor = trace.color;
          ctx.shadowBlur = 3; // ink bleed
          ctx.stroke();
          ctx.shadowBlur = 0;
        }

        // orange exceedance marks: an arrival tick on the rail, plus a
        // permanent marker sitting on the referred pen line at the moment
        // the detection refers to, with a short pulse dash on arrival.
        const now = performance.now();
        for (const flag of data.flags) {
          ctx.strokeStyle = "#ff4f00";
          ctx.lineWidth = 2;
          if (flag.index >= start) {
            const x = ((flag.index - start) / (WINDOW_SAMPLES - 1)) * width;
            ctx.beginPath();
            ctx.moveTo(x, 4);
            ctx.lineTo(x, height - 4);
            ctx.stroke();
          }
          if (flag.markerIndex >= start) {
            const trace = TRACES.find((t) => t.key === flag.trace) || TRACES[0];
            const series = data[trace.key];
            const mid = trace.mid ? height * 0.55 : height - 8 - trace.height * height * 0.5;
            const x = ((flag.markerIndex - start) / (WINDOW_SAMPLES - 1)) * width;
            const y = mid - (series[flag.markerIndex] || 0) * trace.height * height;
            ctx.fillStyle = "#ff4f00";
            ctx.beginPath();
            ctx.arc(x, y, 3.2, 0, Math.PI * 2);
            ctx.fill();
            const age = now - flag.at;
            if (age < 1400) {
              ctx.strokeStyle = `rgba(255, 79, 0, ${(1 - age / 1400).toFixed(3)})`;
              ctx.lineWidth = 3;
              ctx.beginPath();
              ctx.moveTo(x, y - 13);
              ctx.lineTo(x, y + 13);
              ctx.stroke();
            }
          }
        }
      }

      if (dirtyRef.current) {
        dirtyRef.current = false;
        rafRef.current = requestAnimationFrame(draw);
      } else {
        rafRef.current = requestAnimationFrame(draw);
      }
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fdr__canvas"
      aria-label="Live flight-recorder strip: voice level, speech pace, and pause traces"
      role="img"
    />
  );
}
