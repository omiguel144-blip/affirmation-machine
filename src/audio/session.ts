import { makeImpulse, voiceChain } from "./smooth";
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
  /** Background ducking gain at 10 ms steps over [first | loop | tail] as rendered. */
  duck: Float32Array;
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
/** Time from a trimmed clip's start to its first word (matches trimSilence's padBefore). */
const PRE_ROLL = 0.15;
const HOP = 441; // 10 ms ducking-envelope resolution

/**
 * Lays the set out phrase by phrase. With a beat grid (`bar` seconds), each phrase's first
 * word lands on the downbeat of a bar and the pause rounds up to the next bar, so the
 * whole cycle is a whole number of bars and stays locked to the marimba for the full session.
 */
function layout(clips: AudioBuffer[], gap: number, bar: number | null) {
  const starts: number[] = [];
  let t = 0;
  for (const c of clips) {
    starts.push(t);
    const need = c.duration + gap;
    t += bar ? Math.max(1, Math.ceil((need - 1e-6) / bar)) * bar : need;
  }
  return { starts, cycle: t };
}

/** Renders two passes of the affirmation set through the voice chain and splits it into seamless pieces. */
async function renderVoice(clips: AudioBuffer[], gap: number, reverb: number, softness: number, bar: number | null) {
  const { starts, cycle } = layout(clips, gap, bar);
  const C = Math.round(cycle * SR);
  const tail = Math.round(3 * SR);
  const ctx = new OfflineAudioContext(2, 2 * C + tail, SR);
  const bus = new GainNode(ctx);
  voiceChain(ctx, bus, reverb, softness).connect(ctx.destination);
  for (let pass = 0; pass < 2; pass++)
    clips.forEach((clip, i) => {
      const src = new AudioBufferSourceNode(ctx, { buffer: peakNormalize(clip) });
      src.connect(bus);
      src.start(pass * (C / SR) + starts[i]);
    });
  const buf = await ctx.startRendering();
  // normalize the voice to about -6 dBFS so it sits inside the music rather than on top
  let peak = 0;
  for (let c = 0; c < 2; c++) for (const v of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  const g = peak ? 0.5 / peak : 1;
  for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] *= g; }
  return {
    first: slice(buf, 0, C), loop: slice(buf, C, 2 * C), tail: slice(buf, 2 * C, 2 * C + tail),
    duck: duckEnvelope(buf), cycleSec: cycle,
  };
}

/**
 * Background gain per 10 ms: dips about 3.5 dB while the voice is speaking (starting 50 ms
 * early, easing back over ~0.5 s) so voice and music breathe together.
 */
function duckEnvelope(buf: AudioBuffer, depth = 0.33): Float32Array {
  const n = Math.ceil(buf.length / HOP);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const env = new Float32Array(n);
  const att = 1 - Math.exp(-0.01 / 0.06), rel = 1 - Math.exp(-0.01 / 0.5);
  let e = 0;
  for (let k = 0; k < n; k++) {
    let s = 0;
    const end = Math.min(buf.length, (k + 1) * HOP);
    for (let i = k * HOP; i < end; i++) s += (L[i] * L[i] + R[i] * R[i]) / 2;
    const rms = Math.sqrt(s / HOP);
    e += (rms > e ? att : rel) * (rms - e);
    env[k] = e;
  }
  const duck = new Float32Array(n);
  for (let k = 0; k < n; k++) duck[k] = 1 - depth * Math.min(1, env[Math.min(n - 1, k + 5)] / 0.05);
  return duck;
}

async function renderMarimba(tone: ToneSettings) {
  const L = Math.round(marimbaLoopSeconds(tone.marimba.bpm) * SR);
  const ctx = new OfflineAudioContext(2, 2 * L, SR);
  // put the marimba in the same kind of hall as the voice, so they share one space
  const bus = new GainNode(ctx);
  bus.connect(ctx.destination);
  bus.connect(new ConvolverNode(ctx, { buffer: makeImpulse(ctx, 3.2, 2.5) }))
    .connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 4500 }))
    .connect(new GainNode(ctx, { gain: 0.35 }))
    .connect(ctx.destination);
  buildMarimba(ctx, bus, tone.marimba, keyRoot(tone), 0, (2 * L) / SR, false);
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
  const bar = opts.tone.marimba.on ? (4 * 60) / opts.tone.marimba.bpm : null;
  const voice = await renderVoice(opts.clips, opts.gap, opts.reverb, opts.softness, bar);
  const mar = opts.tone.marimba.on ? await renderMarimba(opts.tone) : null;
  const t = opts.tone;
  const gain = Math.pow(10, t.volumeDb / 20);
  const tone =
    t.kind === "none" ? null
    : t.kind === "binaural" ? { left: t.carrier, right: t.carrier + t.beat, gain }
    : { left: Number(t.kind), right: Number(t.kind), gain };
  // intro is whole bars, so the first phrase lands on a downbeat; the voice starts
  // PRE_ROLL early because each trimmed clip has that much lead-in before the first word
  const introSec = bar ? Math.ceil(6 / bar) * bar : 6;
  return {
    voiceFirst: voice.first,
    voiceLoop: voice.loop,
    voiceTail: voice.tail,
    duck: voice.duck,
    marimbaFirst: mar?.first ?? null,
    marimbaLoop: mar?.loop ?? null,
    tone,
    rainGain: t.rain ? gain * 0.6 : 0,
    // always fit at least one full cycle plus intro and a 10 s outro
    durationSec: Math.max(opts.minutes * 60, introSec + voice.cycleSec + 10),
    introSec: introSec - PRE_ROLL,
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
