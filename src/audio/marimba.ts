export type MarimbaPattern = "flow" | "ripple" | "heartbeat";

// Pentatonic semitone offsets from the root; null = rest. 16 eighth-notes per loop.
const PATTERNS: Record<MarimbaPattern, (number | null)[]> = {
  flow:      [0, 7, 12, 7, 4, 9, 16, 9, 2, 9, 14, 9, 4, 7, 12, null],
  ripple:    [12, 9, 7, 4, 2, 0, null, 4, 7, 9, 12, 16, 14, null, 9, null],
  heartbeat: [0, null, 12, null, null, 7, null, null, 0, null, 9, null, null, 4, null, null],
};

/** Tune the root to the chosen frequency, folded down into a warm marimba range (~196–392 Hz). */
export function marimbaRoot(freq: number): number {
  let f = freq;
  while (f > 392) f /= 2;
  while (f < 196) f *= 2;
  return f;
}

/** One struck bar: a marimba's tuned partials (1×, ~4×, ~10×) with fast-decaying overtones and a soft mallet click. */
function strike(ctx: BaseAudioContext, dest: AudioNode, freq: number, t: number, vel: number) {
  const partials: [number, number, number][] = [
    [1, 1, 1.4],      // ratio, level, decay seconds
    [3.93, 0.25, 0.25],
    [9.2, 0.08, 0.08],
  ];
  for (const [ratio, level, decay] of partials) {
    const o = new OscillatorNode(ctx, { frequency: freq * ratio });
    const g = new GainNode(ctx, { gain: 0 });
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level * vel, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + decay + 0.05);
  }
}

export interface MarimbaSettings {
  on: boolean;
  pattern: MarimbaPattern;
  bpm: number;
  volumeDb: number;
}

export function buildMarimba(ctx: BaseAudioContext, dest: AudioNode, m: MarimbaSettings, rootHz: number, t0: number, t1: number) {
  const vol = Math.pow(10, m.volumeDb / 20);
  const fade = Math.min(2, (t1 - t0) / 4);
  const master = new GainNode(ctx, { gain: 0 });
  master.gain.setValueAtTime(0, t0);
  master.gain.linearRampToValueAtTime(vol, t0 + fade);
  master.gain.setValueAtTime(vol, t1 - fade);
  master.gain.linearRampToValueAtTime(0, t1);
  // soft room + warm low-pass so it sits behind the voice
  const lp = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 4000 });
  const delay = new DelayNode(ctx, { delayTime: 60 / m.bpm * 0.75 });
  const fb = new GainNode(ctx, { gain: 0.3 });
  master.connect(lp).connect(dest);
  lp.connect(delay).connect(fb).connect(delay);
  fb.connect(new StereoPannerNode(ctx, { pan: 0.4 })).connect(dest);

  const step = 60 / m.bpm / 2;
  const seq = PATTERNS[m.pattern];
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0, t = t0; t < t1 - 1; i++, t += step) {
    const n = seq[i % seq.length];
    if (n === null) continue;
    const accent = i % 4 === 0 ? 1 : 0.7;
    const humanT = Math.max(t0, t + (rand() - 0.5) * 0.012);
    strike(ctx, master, rootHz * Math.pow(2, n / 12), humanT, accent * (0.8 + rand() * 0.2));
    if (i % 16 === 0) strike(ctx, master, rootHz / 2, humanT, 0.8); // low root on each bar
  }
}
