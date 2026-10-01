export type Scale = "major" | "pentatonic";

export function makeImpulse(ctx: BaseAudioContext, seconds = 2.5, decay = 3): AudioBuffer {
  const len = Math.round(ctx.sampleRate * seconds);
  const ir = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return ir;
}

/**
 * Voice polish chain, tuned to sound soft and intimate rather than bright.
 * `softness` (0–1) controls how much of the harsh 3 kHz "phone mic" edge, sibilance
 * and top-end air is taken away.
 */
export function voiceChain(ctx: BaseAudioContext, src: AudioNode, reverbMix: number, softness = 0.6): AudioNode {
  const sf = (type: BiquadFilterType, frequency: number, gain = 0, Q = 0.8) => new BiquadFilterNode(ctx, { type, frequency, gain, Q });
  const chain: AudioNode[] = [
    sf("highpass", 90),
    sf("lowshelf", 220, 2.5),                       // warmth
    sf("peaking", 3000, -(2 + 5 * softness), 0.9),  // the harsh "edge"
    sf("peaking", 7000, -(3 + 5 * softness), 2),    // sibilance
    sf("highshelf", 9000, -(2 + 6 * softness)),     // air / hiss
    sf("lowpass", 16000 - 8000 * softness),
    // gentle, slow compression: evens out without squashing
    new DynamicsCompressorNode(ctx, { threshold: -22, ratio: 2.5, attack: 0.02, release: 0.3, knee: 12 }),
    new GainNode(ctx, { gain: 1.3 }),
  ];
  let node: AudioNode = src;
  for (const n of chain) node = node.connect(n);

  const out = new GainNode(ctx);
  const dry = new GainNode(ctx, { gain: 1 - reverbMix * 0.4 });
  const wet = new GainNode(ctx, { gain: reverbMix * 1.2 });
  // dark, slightly pre-delayed hall so the echo blooms behind the voice instead of hissing
  const pre = new DelayNode(ctx, { delayTime: 0.03 });
  const conv = new ConvolverNode(ctx, { buffer: makeImpulse(ctx, 3.2, 2.5) });
  node.connect(dry).connect(out);
  node.connect(pre).connect(conv).connect(sf("lowpass", 4500)).connect(sf("highpass", 200)).connect(wet).connect(out);
  return out;
}
