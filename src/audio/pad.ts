import { makeImpulse } from "./smooth";

export interface PadSettings {
  on: boolean;
  volumeDb: number;
}

const CHORD_SEC = 8;
/** Peaceful progression in the key (semitones from the root), all notes inside the major scale. */
const CHORDS: number[][] = [
  [-12, 0, 4, 7, 14],   // I add9
  [-7, 5, 9, 12, 16],   // IV maj7
  [-3, 9, 12, 16, 19],  // vi 7
  [-7, 5, 7, 12, 14],   // IV sus
  [-12, 0, 7, 11, 16],  // I maj7
  [-8, 4, 7, 11, 14],   // iii 7
  [-7, 5, 9, 12, 16],   // IV maj7
  [-5, 7, 12, 14, 19],  // V sus
];
const CHIME_NOTES = [12, 14, 16, 19, 21, 24, 26, 28]; // pentatonic, an octave or two up

/** One seamless loop: the whole progression. */
export const PAD_LOOP_SEC = CHORDS.length * CHORD_SEC;

/**
 * Slow ambient pad: soft detuned chords that swell in and fade out, a gently breathing
 * filter, and the odd glassy chime, all in a big hall. No beat — made for drifting off.
 */
export function buildPad(ctx: BaseAudioContext, dest: AudioNode, s: PadSettings, rootHz: number, t0: number, t1: number, fades = true) {
  const vol = Math.pow(10, s.volumeDb / 20);
  const master = new GainNode(ctx, { gain: fades ? 0 : vol });
  if (fades) {
    const fade = Math.min(4, (t1 - t0) / 4);
    master.gain.setValueAtTime(0, t0);
    master.gain.linearRampToValueAtTime(vol, t0 + fade);
    master.gain.setValueAtTime(vol, t1 - fade);
    master.gain.linearRampToValueAtTime(0, t1);
  }
  // breathing low-pass: one slow sweep per half loop, so the loop stays seamless
  const lp = new BiquadFilterNode(ctx, { type: "lowpass", frequency: 1300, Q: 0.5 });
  const lfo = new OscillatorNode(ctx, { frequency: 2 / PAD_LOOP_SEC });
  lfo.connect(new GainNode(ctx, { gain: 450 })).connect(lp.frequency);
  lfo.start(t0);
  lfo.stop(t1 + 6);
  const sum = new GainNode(ctx);
  sum.connect(lp).connect(master);
  master.connect(dest);
  master.connect(new ConvolverNode(ctx, { buffer: makeImpulse(ctx, 4.5, 2) }))
    .connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 5000 }))
    .connect(new GainNode(ctx, { gain: 0.6 }))
    .connect(dest);

  const note = (freq: number, start: number, len: number, level: number, pan: number) => {
    const g = new GainNode(ctx, { gain: 0 });
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(level, start + 3);
    g.gain.setValueAtTime(level, start + len);
    g.gain.setTargetAtTime(0, start + len, 1.3);
    const p = new StereoPannerNode(ctx, { pan });
    g.connect(p).connect(sum);
    for (const [type, cents] of [["sine", -7], ["triangle", 7]] as const) {
      const o = new OscillatorNode(ctx, { type, frequency: freq, detune: cents });
      o.connect(g);
      o.start(start);
      o.stop(start + len + 7);
    }
  };
  const chime = (freq: number, start: number, level: number, pan: number) => {
    for (const [ratio, lvl, decay] of [[1, 1, 3.5], [2.76, 0.18, 1.2]]) {
      const o = new OscillatorNode(ctx, { frequency: freq * ratio });
      const g = new GainNode(ctx, { gain: 0 });
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(level * lvl, start + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, start + decay);
      o.connect(g).connect(new StereoPannerNode(ctx, { pan })).connect(master);
      o.start(start);
      o.stop(start + decay + 0.1);
    }
  };

  for (let c = 0, t = t0; t < t1 - 0.5; c++, t = t0 + c * CHORD_SEC) {
    const idx = c % CHORDS.length;
    CHORDS[idx].forEach((semi, i) => {
      const bass = i === 0;
      note(rootHz * Math.pow(2, semi / 12), t, CHORD_SEC - 1.5, bass ? 0.16 : 0.09, bass ? 0 : i % 2 ? -0.45 : 0.45);
    });
    // 1–2 chimes per chord, placed by a seed tied to the chord's position in the loop
    let seed = 1 + idx * 7919;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const count = 1 + Math.round(rand());
    for (let k = 0; k < count; k++) {
      const at = t + 1.5 + rand() * (CHORD_SEC - 3);
      if (at < t1 - 1) chime(rootHz * Math.pow(2, CHIME_NOTES[Math.floor(rand() * CHIME_NOTES.length)] / 12), at, 0.05, rand() * 1.2 - 0.6);
    }
  }
}
