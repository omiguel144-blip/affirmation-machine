import { PitchDetector } from "pitchy";

export type Scale = "major" | "pentatonic";
const SCALES: Record<Scale, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  pentatonic: [0, 2, 4, 7, 9],
};

function toMono(buf: AudioBuffer): Float32Array {
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

function snapRatio(freq: number, scale: Scale): number {
  const midi = 69 + 12 * Math.log2(freq / 440);
  const base = Math.floor(midi / 12) * 12;
  let best = midi, dist = Infinity;
  for (const oct of [-12, 0, 12])
    for (const s of SCALES[scale]) {
      const n = base + oct + s;
      if (Math.abs(n - midi) < dist) { dist = Math.abs(n - midi); best = n; }
    }
  return Math.pow(2, (best - midi) / 12);
}

/** Snap pitch to scale using pitchy detection + granular overlap-add pitch shifting. */
export function autotune(buf: AudioBuffer, scale: Scale, strength = 1): AudioBuffer {
  const sr = buf.sampleRate;
  const x = toMono(buf);
  const grain = Math.round(sr * 0.04);
  const hop = grain >> 2;
  const det = PitchDetector.forFloat32Array(grain);
  const frame = new Float32Array(grain);

  // per-hop shift ratio, smoothed
  const ratios: number[] = [];
  let prev = 1;
  for (let p = 0; p + grain <= x.length; p += hop) {
    frame.set(x.subarray(p, p + grain));
    const [f, clarity] = det.findPitch(frame, sr);
    let r = clarity > 0.85 && f > 70 && f < 1000 ? snapRatio(f, scale) : 1;
    r = 1 + (r - 1) * strength;
    prev = prev * 0.6 + r * 0.4;
    ratios.push(prev);
  }

  const y = new Float32Array(x.length);
  const norm = new Float32Array(x.length);
  const win = new Float32Array(grain).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grain - 1)));
  ratios.forEach((r, k) => {
    const start = k * hop;
    const center = start + grain / 2;
    for (let i = 0; i < grain; i++) {
      const src = center + (i - grain / 2) * r;
      const i0 = Math.floor(src);
      if (i0 < 0 || i0 + 1 >= x.length) continue;
      const frac = src - i0;
      y[start + i] += (x[i0] * (1 - frac) + x[i0 + 1] * frac) * win[i];
      norm[start + i] += win[i];
    }
  });
  for (let i = 0; i < y.length; i++) y[i] = norm[i] > 1e-3 ? y[i] / norm[i] : x[i];

  const out = new AudioBuffer({ length: y.length, sampleRate: sr, numberOfChannels: 1 });
  out.copyToChannel(y, 0);
  return out;
}

export function makeImpulse(ctx: BaseAudioContext, seconds = 2.5, decay = 3): AudioBuffer {
  const len = Math.round(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return ir;
}

/** Gentle polish chain: high-pass, warmth, compression, reverb. Returns output node. */
export function voiceChain(ctx: BaseAudioContext, src: AudioNode, reverbMix: number): AudioNode {
  const hp = new BiquadFilterNode(ctx, { type: "highpass", frequency: 80 });
  const warm = new BiquadFilterNode(ctx, { type: "lowshelf", frequency: 250, gain: 3 });
  const deEss = new BiquadFilterNode(ctx, { type: "peaking", frequency: 6500, Q: 1.5, gain: -4 });
  const comp = new DynamicsCompressorNode(ctx, { threshold: -24, ratio: 4, attack: 0.005, release: 0.2, knee: 10 });
  const makeup = new GainNode(ctx, { gain: 1.6 });
  src.connect(hp).connect(warm).connect(deEss).connect(comp).connect(makeup);

  const out = new GainNode(ctx);
  const dry = new GainNode(ctx, { gain: 1 - reverbMix * 0.5 });
  const wet = new GainNode(ctx, { gain: reverbMix });
  const conv = new ConvolverNode(ctx, { buffer: makeImpulse(ctx) });
  makeup.connect(dry).connect(out);
  makeup.connect(conv).connect(wet).connect(out);
  return out;
}
