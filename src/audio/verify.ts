import { buildTone, type ToneSettings } from "./tones";

export interface ToneCheck {
  channel: string;
  expected: number;
  measured: number;
  harmonicsDb: number[]; // 2nd, 3rd, 4th relative to fundamental
}

export interface VerifyReport {
  tones: ToneCheck[];
  clippedSamples: number;
  peakDb: number;
}

/** Goertzel magnitude of `freq` in `x`, Hann-windowed. */
function mag(x: Float32Array, freq: number, sr: number): number {
  const w = (2 * Math.PI * freq) / sr, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (x.length - 1));
    const s0 = x[i] * win + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2);
}

function measure(x: Float32Array, expected: number, sr: number, channel: string): ToneCheck {
  // coarse scan ±25 Hz at 0.5 Hz, then refine at 0.02 Hz
  let best = expected, bestM = 0;
  const scan = (from: number, to: number, step: number) => {
    for (let f = from; f <= to; f += step) {
      const m = mag(x, f, sr);
      if (m > bestM) { bestM = m; best = f; }
    }
  };
  scan(expected - 25, expected + 25, 0.5);
  scan(best - 0.5, best + 0.5, 0.02);
  const harmonicsDb = [2, 3, 4].map((h) => 20 * Math.log10(Math.max(mag(x, best * h, sr), 1e-9) / bestM));
  return { channel, expected, measured: best, harmonicsDb };
}

/** Renders the background bed alone and measures what's really in it, plus clipping in the final mix. */
export async function verify(tone: ToneSettings, mix: AudioBuffer): Promise<VerifyReport> {
  const tones: ToneCheck[] = [];
  if (tone.kind !== "none") {
    const sr = 44100;
    const ctx = new OfflineAudioContext(2, sr * 4, sr);
    buildTone(ctx, ctx.destination, { ...tone, rain: false, marimba: { ...tone.marimba, on: false }, volumeDb: -6 }, 0, 4);
    const bed = await ctx.startRendering();
    // analyse 2 s from the steady middle section
    const L = bed.getChannelData(0).slice(sr, sr * 3);
    const R = bed.getChannelData(1).slice(sr, sr * 3);
    if (tone.kind === "binaural") {
      tones.push(measure(L, tone.carrier, sr, "Left ear"));
      tones.push(measure(R, tone.carrier + tone.beat, sr, "Right ear"));
    } else {
      tones.push(measure(L, Number(tone.kind), sr, "Both ears"));
    }
  }
  let clipped = 0, peak = 0;
  for (let c = 0; c < mix.numberOfChannels; c++)
    for (const v of mix.getChannelData(c)) {
      const a = Math.abs(v);
      if (a >= 0.999) clipped++;
      if (a > peak) peak = a;
    }
  return { tones, clippedSamples: clipped, peakDb: 20 * Math.log10(peak || 1e-9) };
}
