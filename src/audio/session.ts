import { voiceChain } from "./smooth";
import { buildMarimba, marimbaLoopSeconds } from "./marimba";
import { keyRoot, type ToneSettings } from "./tones";

export const SR = 44100;

export type Stereo = [Float32Array, Float32Array];

/** Everything the encoder worker needs to stitch together a long session. */
export interface SessionPlan {
  /** First pass of the affirmation cycle (clean start, no reverb tail from before). */
  voiceFirst: Stereo;
  /** Steady-state cycle: seamless when repeated (includes the previous cycle's tail). */
  voiceLoop: Stereo;
  /** Reverb tail to play after the final cycle. */
  voiceTail: Stereo;
  marimbaFirst: Stereo | null;
  marimbaLoop: Stereo | null;
  tone: { left: number; right: number; gain: number } | null;
  rainGain: number;
  durationSec: number;
  introSec: number;
  title: string;
}

const slice = (b: AudioBuffer, from: number, to: number): Stereo => [
  b.getChannelData(0).slice(from, to),
  b.getChannelData(1).slice(from, to),
];

function peakNormalize(clip: AudioBuffer, target = 0.7): AudioBuffer {
  let peak = 0;
  for (let c = 0; c < clip.numberOfChannels; c++)
    for (const v of clip.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  if (!peak) return clip;
  const out = new AudioBuffer({ length: clip.length, sampleRate: clip.sampleRate, numberOfChannels: clip.numberOfChannels });
  for (let c = 0; c < clip.numberOfChannels; c++) {
    const d = clip.getChannelData(c), o = out.getChannelData(c);
    for (let i = 0; i < d.length; i++) o[i] = (d[i] * target) / peak;
  }
  return out;
}

/** Renders two passes of the affirmation set through the voice chain and splits it into seamless pieces. */
async function renderVoice(clips: AudioBuffer[], gap: number, reverb: number, softness: number) {
  const cycle = clips.reduce((t, c) => t + gap + c.duration, 0);
  const C = Math.round(cycle * SR);
  const tail = Math.round(3 * SR);
  const ctx = new OfflineAudioContext(2, 2 * C + tail, SR);
  const bus = new GainNode(ctx);
  voiceChain(ctx, bus, reverb, softness).connect(ctx.destination);
  for (let pass = 0; pass < 2; pass++) {
    let t = pass * (C / SR);
    for (const clip of clips) {
      t += gap;
      const src = new AudioBufferSourceNode(ctx, { buffer: peakNormalize(clip) });
      src.connect(bus);
      src.start(t);
      t += clip.duration;
    }
  }
  const buf = await ctx.startRendering();
  // normalize the voice to about -5 dBFS so it sits inside the music rather than on top
  let peak = 0;
  for (let c = 0; c < 2; c++) for (const v of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  const g = peak ? 0.56 / peak : 1;
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= g; }
  return { first: slice(buf, 0, C), loop: slice(buf, C, 2 * C), tail: slice(buf, 2 * C, 2 * C + tail), cycleSec: cycle };
}

async function renderMarimba(tone: ToneSettings) {
  const L = Math.round(marimbaLoopSeconds(tone.marimba.bpm) * SR);
  const ctx = new OfflineAudioContext(2, 2 * L, SR);
  buildMarimba(ctx, ctx.destination, tone.marimba, keyRoot(tone), 0, (2 * L) / SR, false);
  const buf = await ctx.startRendering();
  return { first: slice(buf, 0, L), loop: slice(buf, L, 2 * L) };
}

export async function planSession(opts: {
  clips: AudioBuffer[];
  gap: number;
  reverb: number;
  softness: number;
  tone: ToneSettings;
  minutes: number;
  title: string;
}): Promise<SessionPlan> {
  const voice = await renderVoice(opts.clips, opts.gap, opts.reverb, opts.softness);
  const mar = opts.tone.marimba.on ? await renderMarimba(opts.tone) : null;
  const t = opts.tone;
  const gain = Math.pow(10, t.volumeDb / 20);
  const tone =
    t.kind === "none" ? null
    : t.kind === "binaural" ? { left: t.carrier, right: t.carrier + t.beat, gain }
    : { left: Number(t.kind), right: Number(t.kind), gain };
  const introSec = 6;
  return {
    voiceFirst: voice.first,
    voiceLoop: voice.loop,
    voiceTail: voice.tail,
    marimbaFirst: mar?.first ?? null,
    marimbaLoop: mar?.loop ?? null,
    tone,
    rainGain: t.rain ? gain * 0.6 : 0,
    // always fit at least one full cycle plus intro and a 10 s outro
    durationSec: Math.max(opts.minutes * 60, introSec + voice.cycleSec + 10),
    introSec,
    title: opts.title,
  };
}

export interface EncodeResult {
  blob: Blob;
  peak: number;
  limitedSamples: number;
  cycles: number;
}

export function encodeSession(plan: SessionPlan, onProgress: (p: number) => void): Promise<EncodeResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./encoder.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e) => {
      if (e.data.type === "progress") onProgress(e.data.value);
      else if (e.data.type === "done") { w.terminate(); resolve(e.data.result); }
    };
    w.onerror = (e) => { w.terminate(); reject(e); };
    w.postMessage(plan);
  });
}
