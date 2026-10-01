import { PitchDetector } from "pitchy";
import type { Scale } from "./smooth";

const SCALES: Record<Scale, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  pentatonic: [0, 2, 4, 7, 9],
};

export type TuneStyle = "singer" | "hard";

interface StyleParams {
  glide: number;      // seconds to slide between notes
  keep: number;       // how much natural pitch movement survives (0 = perfectly flat)
  vibrato: number;    // vibrato depth in semitones
  double: boolean;    // soft double-tracked copy for width
}

const STYLES: Record<TuneStyle, StyleParams> = {
  singer: { glide: 0.09, keep: 0.2, vibrato: 0.22, double: true },
  hard: { glide: 0.012, keep: 0, vibrato: 0, double: false },
};

const HOP = 256;     // analysis hop (~5.8 ms at 44.1 kHz)
const WIN = 2048;    // analysis window

/** All scale notes (in semitones above root) across a wide range, ascending. */
function scaleNotes(scale: Scale): number[] {
  const out: number[] = [];
  for (let oct = -36; oct <= 36; oct += 12) for (const s of SCALES[scale]) out.push(oct + s);
  return out;
}

function nearestIndex(notes: number[], semis: number): number {
  let best = 0;
  for (let i = 1; i < notes.length; i++) if (Math.abs(notes[i] - semis) < Math.abs(notes[best] - semis)) best = i;
  return best;
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s[s.length >> 1];
}

/** Pitch track in semitones above `rootHz` per hop (NaN = unvoiced), cleaned up. */
export function trackPitch(x: Float32Array, sr: number, rootHz: number): number[] {
  const det = PitchDetector.forFloat32Array(WIN);
  const frame = new Float32Array(WIN);
  const n = Math.ceil(x.length / HOP);
  const raw: number[] = [];
  for (let k = 0; k < n; k++) {
    const start = k * HOP - WIN / 2;
    frame.fill(0);
    const a = Math.max(0, start), b = Math.min(x.length, start + WIN);
    if (b > a) frame.set(x.subarray(a, b), a - start);
    const [f, clarity] = det.findPitch(frame, sr);
    raw.push(clarity > 0.8 && f > 70 && f < 800 ? 12 * Math.log2(f / rootHz) : NaN);
  }
  // 5-point median over voiced neighbours removes octave blips
  const med = raw.map((v, k) => {
    if (isNaN(v)) return NaN;
    const nb = raw.slice(Math.max(0, k - 2), k + 3).filter((u) => !isNaN(u));
    return median(nb);
  });
  // drop voiced runs shorter than ~40 ms (clicks, breaths)
  const minRun = Math.round((0.04 * sr) / HOP);
  for (let k = 0; k < med.length; ) {
    if (isNaN(med[k])) { k++; continue; }
    let e = k;
    while (e < med.length && !isNaN(med[e])) e++;
    if (e - k < minRun) for (let j = k; j < e; j++) med[j] = NaN;
    k = e;
  }
  return med;
}

/**
 * Turns a natural pitch track into a sung melody: each syllable-ish segment is held on
 * one scale note, notes glide into each other, and longer notes get a gentle vibrato.
 * Returns target semitones for the lead and for a harmony a diatonic third above.
 */
function melody(track: number[], scale: Scale, p: StyleParams, sr: number) {
  const notes = scaleNotes(scale);
  const dt = HOP / sr;
  const lead = new Array<number>(track.length).fill(NaN);
  const harm = new Array<number>(track.length).fill(NaN);
  const glideA = p.glide > 0 ? 1 - Math.exp(-dt / (p.glide / 3)) : 1;

  for (let k = 0; k < track.length; ) {
    if (isNaN(track[k])) { k++; continue; }
    let e = k;
    while (e < track.length && !isNaN(track[e])) e++;
    // split the voiced run into note segments wherever the pitch moves away from the running median
    const segs: [number, number][] = [];
    let s0 = k, drift = 0;
    for (let j = k; j < e; j++) {
      const m = median(track.slice(s0, j + 1));
      drift = Math.abs(track[j] - m) > 1.2 ? drift + 1 : 0;
      if (drift >= 4 && j - s0 > 6) { segs.push([s0, j - 3]); s0 = j - 3; drift = 0; }
    }
    segs.push([s0, e]);

    let cur = NaN, curH = NaN;
    for (const [a, b] of segs) {
      const m = median(track.slice(a, b));
      const idx = nearestIndex(notes, m);
      const note = notes[idx], noteH = notes[Math.min(notes.length - 1, idx + 2)];
      for (let j = a; j < b; j++) {
        cur = isNaN(cur) ? note : cur + (note - cur) * glideA;
        curH = isNaN(curH) ? noteH : curH + (noteH - curH) * glideA;
        const t = (j - a) * dt;
        const vibAmt = p.vibrato * Math.min(1, Math.max(0, (t - 0.15) / 0.2));
        const vib = vibAmt * Math.sin(2 * Math.PI * 5.2 * t);
        const natural = p.keep * (track[j] - m);
        lead[j] = cur + natural + vib;
        harm[j] = curH + natural + vib;
      }
    }
    k = e;
  }
  return { lead, harm };
}

/**
 * TD-PSOLA pitch shifter: two-period grains are cut around each pitch period of the
 * source and laid down at the new period. Grains aren't resampled, so the voice's
 * formants (its character) stay put — no chipmunk effect.
 */
export function psola(x: Float32Array, sr: number, track: number[] & { rootHz: number }, target: number[]): Float32Array {
  const y = new Float32Array(x.length);
  const unvoicedP = Math.round(sr * 0.005);
  const frameOf = (t: number) => Math.min(track.length - 1, Math.max(0, Math.round(t / HOP)));
  const periodAt = (t: number) => {
    const s = track[frameOf(t)];
    return isNaN(s) ? 0 : sr / (track.rootHz * Math.pow(2, s / 12));
  };

  // source pitch marks, nudged onto waveform peaks so grains line up period to period
  const marks: number[] = [];
  for (let t = 0; t < x.length; ) {
    const P = periodAt(t);
    if (!P) { marks.push(Math.round(t)); t = Math.round(t) + unvoicedP; continue; }
    let best = t, bestV = -Infinity;
    const lo = Math.max(0, Math.round(t - P / 4)), hi = Math.min(x.length - 1, Math.round(t + P / 4));
    for (let i = lo; i <= hi; i++) if (x[i] > bestV) { bestV = x[i]; best = i; }
    if (marks.length && best <= marks[marks.length - 1]) best = Math.round(t);
    marks.push(best);
    t = best + P;
  }

  const grain = (center: number, half: number, at: number, gain: number) => {
    for (let i = -half; i < half; i++) {
      const si = center + i, oi = at + i;
      if (si < 0 || si >= x.length || oi < 0 || oi >= y.length) continue;
      const w = 0.5 + 0.5 * Math.cos((Math.PI * i) / half);
      y[oi] += x[si] * w * gain;
    }
  };

  let mi = 0;
  for (let u = marks[0] ?? 0; u < x.length; ) {
    while (mi + 1 < marks.length && Math.abs(marks[mi + 1] - u) <= Math.abs(marks[mi] - u)) mi++;
    const m = marks[mi];
    const k = frameOf(u);
    const P = periodAt(m);
    if (!P || isNaN(target[k]) || isNaN(track[k])) {
      grain(m, unvoicedP, Math.round(u), 1);
      u += unvoicedP;
      continue;
    }
    const ratio = Math.min(2, Math.max(0.5, Math.pow(2, (target[k] - track[k]) / 12)));
    const half = Math.round(P);
    grain(m, half, Math.round(u), 1 / ratio); // denser grains when raising pitch, so scale down
    u += P / ratio;
  }
  return y;
}

function toMono(buf: AudioBuffer): Float32Array {
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) out[i] += d[i] / buf.numberOfChannels;
  }
  return out;
}

/** Retunes a spoken clip into a sung line in the key of `rootHz`. Returns a stereo buffer. */
export function sing(buf: AudioBuffer, scale: Scale, rootHz: number, style: TuneStyle, harmony: boolean): AudioBuffer {
  const sr = buf.sampleRate;
  const x = toMono(buf);
  const p = STYLES[style];
  const track = Object.assign(trackPitch(x, sr, rootHz), { rootHz });
  const { lead, harm } = melody(track, scale, p, sr);

  const L = psola(x, sr, track, lead);
  const out = new AudioBuffer({ length: x.length, sampleRate: sr, numberOfChannels: 2 });
  const left = new Float32Array(L), right = new Float32Array(L);

  const addDelayed = (src: Float32Array, gain: number, delaySec: number, panL: number, panR: number) => {
    const d = Math.round(delaySec * sr);
    for (let i = d; i < src.length; i++) {
      left[i] += src[i - d] * gain * panL;
      right[i] += src[i - d] * gain * panR;
    }
  };
  if (p.double) {
    // a second "take" a few cents sharp and slightly late: soft, wide, double-tracked
    addDelayed(psola(x, sr, track, lead.map((v) => v + 0.08)), 0.35, 0.018, 0.3, 1);
  }
  if (harmony) {
    addDelayed(psola(x, sr, track, harm), 0.32, 0.01, 1, 0.45);
  }
  out.copyToChannel(left, 0);
  out.copyToChannel(right, 1);
  return out;
}
