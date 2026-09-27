/**
 * audio.js
 *
 * Web Audio plumbing for the live session: microphone capture to base64 PCM16
 * mono 24 kHz, and playback of the agent's reply audio.
 *
 * NOT IN SPEC PART G -- required infrastructure. Spec C.7/B.2 assume PCM audio
 * in and out; Part G's tree simply did not name this module. See
 * docs/ARCHITECTURE.md for the full list of deviations.
 *
 * The AssemblyAI audio contract is PCM16 mono 24 kHz in both directions, so a
 * single AudioContext pinned to 24 kHz serves capture and playback and needs no
 * resampling on either side.
 */

const SAMPLE_RATE = 24000;
const CHUNK_SAMPLES = 1200; // ~50 ms per chunk, the size the docs recommend

const WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      // Copy: the underlying buffer is reused between render quanta.
      this.port.postMessage(input[0].slice(0));
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCaptureProcessor);
`;

function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = "";
  const BLOCK = 0x8000;
  for (let i = 0; i < bytes.length; i += BLOCK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + BLOCK));
  }
  return btoa(binary);
}

function base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // Copy into an aligned buffer: the byte offset may not be even.
  const aligned = new Uint8Array(bytes.length);
  aligned.set(bytes);
  return new Int16Array(aligned.buffer);
}

export function createAudioEngine() {
  /** @type {AudioContext|null} */
  let ctx = null;
  let micStream = null;
  let sourceNode = null;
  let workletNode = null;
  let silentGain = null;
  let workletUrl = null;
  let capturing = false;

  const activeSources = new Set();
  let nextPlaybackTime = 0;

  function ensureContext() {
    if (!ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      ctx = new Ctor({ sampleRate: SAMPLE_RATE });
    }
    return ctx;
  }

  async function resumeContext() {
    const context = ensureContext();
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch {
        /* the next user gesture will retry */
      }
    }
    return context;
  }

  /**
   * Requests the mic and starts streaming 50 ms PCM16 chunks to onChunk.
   * Throws an Error with code MIC_PERMISSION_DENIED if the user blocks the mic,
   * which the live screen turns into a full-screen error state.
   */
  async function startCapture(onChunk) {
    if (capturing) return;
    const context = await resumeContext();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const err = new Error("This browser cannot capture microphone audio.");
      err.code = "MIC_PERMISSION_DENIED";
      throw err;
    }

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // Essential: without echo cancellation the agent hears its own voice
          // through the speakers and interrupts itself on every reply.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (cause) {
      const err = new Error("Microphone access was blocked.");
      err.code = "MIC_PERMISSION_DENIED";
      err.cause = cause;
      throw err;
    }

    if (!context.audioWorklet) {
      const err = new Error("This browser does not support the AudioWorklet API needed for capture.");
      err.code = "MIC_PERMISSION_DENIED";
      throw err;
    }

    workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    try {
      await context.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
      workletUrl = null;
    }

    sourceNode = context.createMediaStreamSource(micStream);
    workletNode = new AudioWorkletNode(context, "pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });

    // A zero-gain path to the destination keeps the worklet pulled by the graph
    // without routing the mic back to the speakers.
    silentGain = context.createGain();
    silentGain.gain.value = 0;
    sourceNode.connect(workletNode);
    workletNode.connect(silentGain);
    silentGain.connect(context.destination);

    const pending = [];
    let pendingSamples = 0;

    workletNode.port.onmessage = (event) => {
      const floats = event.data;
      if (!floats || !floats.length) return;
      pending.push(floats);
      pendingSamples += floats.length;

      while (pendingSamples >= CHUNK_SAMPLES) {
        const chunk = new Int16Array(CHUNK_SAMPLES);
        let filled = 0;
        while (filled < CHUNK_SAMPLES) {
          const head = pending[0];
          const take = Math.min(head.length, CHUNK_SAMPLES - filled);
          for (let i = 0; i < take; i++) {
            const sample = Math.max(-1, Math.min(1, head[i]));
            chunk[filled + i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
          }
          filled += take;
          pendingSamples -= take;
          if (take === head.length) pending.shift();
          else pending[0] = head.subarray(take);
        }
        onChunk(int16ToBase64(chunk));
      }
    };

    capturing = true;
  }

  /** Schedules one PCM16 chunk to play back-to-back with whatever is queued. */
  async function playChunk(base64) {
    if (!base64) return;
    const context = await resumeContext();

    const pcm = base64ToInt16(base64);
    if (!pcm.length) return;

    const buffer = context.createBuffer(1, pcm.length, SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const now = context.currentTime;
    const startAt = Math.max(now, nextPlaybackTime);
    source.start(startAt);
    nextPlaybackTime = startAt + buffer.duration;

    activeSources.add(source);
    source.onended = () => activeSources.delete(source);
  }

  /** Drops queued agent audio. Called on barge-in so stale speech stops. */
  function flush() {
    for (const source of activeSources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    activeSources.clear();
    nextPlaybackTime = 0;
  }

  function stop() {
    capturing = false;
    flush();
    if (workletNode) {
      workletNode.port.onmessage = null;
      try {
        workletNode.disconnect();
      } catch {
        /* ignore */
      }
      workletNode = null;
    }
    if (silentGain) {
      try {
        silentGain.disconnect();
      } catch {
        /* ignore */
      }
      silentGain = null;
    }
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch {
        /* ignore */
      }
      sourceNode = null;
    }
    if (micStream) {
      for (const track of micStream.getTracks()) track.stop();
      micStream = null;
    }
    if (ctx) {
      try {
        ctx.close();
      } catch {
        /* ignore */
      }
      ctx = null;
    }
  }

  return { startCapture, playChunk, flush, stop, SAMPLE_RATE };
}

export { SAMPLE_RATE };
