import { buildMarimba, marimbaRoot, type MarimbaSettings } from "./marimba";
import { buildPad, type PadSettings } from "./pad";

export type ToneKind = "432" | "528" | "639" | "888" | "binaural" | "none";

export interface ToneSettings {
  kind: ToneKind;
  volumeDb: number;
  carrier: number;
  beat: number;
  rain: boolean;
  marimba: MarimbaSettings;
  pad: PadSettings;
}

/** The musical key root shared by the marimba and autotune, derived from the chosen frequency. */
export function keyRoot(s: ToneSettings): number {
  const base = s.kind === "binaural" ? s.carrier : s.kind === "none" ? 261.63 : Number(s.kind);
  return marimbaRoot(base);
}

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
/** Nearest note name for a frequency, e.g. 222 Hz → "A". */
export function noteName(hz: number): string {
  const midi = Math.round(69 + 12 * Math.log2(hz / 440));
  return NOTE_NAMES[((midi % 12) + 12) % 12];
}

/** Builds the background bed into `dest`, running from t0 to t1. */
export function buildTone(ctx: BaseAudioContext, dest: AudioNode, s: ToneSettings, t0: number, t1: number) {
  const master = new GainNode(ctx, { gain: 0 });
  const vol = Math.pow(10, s.volumeDb / 20);
  const fade = Math.min(2, (t1 - t0) / 4);
  master.gain.setValueAtTime(0, t0);
  master.gain.linearRampToValueAtTime(vol, t0 + fade);
  master.gain.setValueAtTime(vol, t1 - fade);
  master.gain.linearRampToValueAtTime(0, t1);
  master.connect(dest);

  const osc = (freq: number, pan: number) => {
    const o = new OscillatorNode(ctx, { frequency: freq });
    o.connect(new StereoPannerNode(ctx, { pan })).connect(master);
    o.start(t0);
    o.stop(t1);
  };
  if (s.kind === "binaural") {
    osc(s.carrier, -1);
    osc(s.carrier + s.beat, 1);
  } else if (s.kind !== "none") {
    osc(Number(s.kind), 0);
  }

  if (s.rain) {
    const len = ctx.sampleRate * 2;
    const nb = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = nb.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.95 * b2 + w * 0.048;
      d[i] = (b0 + b1 + b2) * 0.5;
    }
    const n = new AudioBufferSourceNode(ctx, { buffer: nb, loop: true });
    n.connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 3000 }))
      .connect(new GainNode(ctx, { gain: 0.6 })).connect(master);
    n.start(t0);
    n.stop(t1);
  }

  if (s.marimba.on) {
    buildMarimba(ctx, dest, s.marimba, keyRoot(s), t0, t1);
  }
  if (s.pad.on) buildPad(ctx, dest, s.pad, keyRoot(s), t0, t1);
}
