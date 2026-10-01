const WIN = 0.01; // 10 ms analysis windows

export interface TrimResult {
  buffer: AudioBuffer;
  removedSec: number;
}

/**
 * Cuts silence and tap/click noises from the start and end of a recording.
 * Speech = energy above the threshold sustained for at least 120 ms, so short
 * clicks (like tapping Stop) are ignored even when they're loud.
 */
export function trimSilence(buf: AudioBuffer, padBefore = 0.15, padAfter = 0.3): TrimResult {
  const sr = buf.sampleRate;
  const win = Math.round(sr * WIN);
  const n = Math.floor(buf.length / win);
  if (n < 10) return { buffer: buf, removedSec: 0 };

  const data = [...Array(buf.numberOfChannels)].map((_, c) => buf.getChannelData(c));
  const rms = new Float32Array(n);
  for (let w = 0; w < n; w++) {
    let sum = 0;
    for (const d of data) for (let i = w * win; i < (w + 1) * win; i++) sum += d[i] * d[i];
    rms[w] = Math.sqrt(sum / (win * data.length));
  }

  // threshold: well above the room's noise floor, and no lower than 26 dB below the loudest moment
  const sorted = [...rms].sort((a, b) => a - b);
  const floor = sorted[Math.floor(n * 0.1)];
  const loud = sorted[Math.floor(n * 0.98)];
  const thresh = Math.max(floor * 3, loud * 0.05, 0.003);

  const minRun = Math.round(0.12 / WIN);
  const findEdge = (from: number, step: 1 | -1): number => {
    let run = 0;
    for (let w = from; w >= 0 && w < n; w += step) {
      run = rms[w] > thresh ? run + 1 : 0;
      if (run >= minRun) return w - step * (minRun - 1);
    }
    return -1;
  };
  const first = findEdge(0, 1);
  const last = findEdge(n - 1, -1);
  if (first < 0 || last < first) return { buffer: buf, removedSec: 0 }; // nothing confidently speech: keep as-is

  const start = Math.max(0, first * win - Math.round(padBefore * sr));
  const end = Math.min(buf.length, (last + 1) * win + Math.round(padAfter * sr));
  const len = end - start;
  const out = new AudioBuffer({ length: len, sampleRate: sr, numberOfChannels: buf.numberOfChannels });
  const fadeIn = Math.round(0.01 * sr), fadeOut = Math.round(0.05 * sr);
  data.forEach((d, c) => {
    const o = d.slice(start, end);
    for (let i = 0; i < fadeIn && i < len; i++) o[i] *= i / fadeIn;
    for (let i = 0; i < fadeOut && i < len; i++) o[len - 1 - i] *= i / fadeOut;
    out.copyToChannel(o, c);
  });
  return { buffer: out, removedSec: (buf.length - len) / sr };
}

/** 16-bit WAV, used for previewing trimmed clips in the set list. */
export function toWav(buf: AudioBuffer): Blob {
  const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
  const view = new DataView(new ArrayBuffer(44 + len * ch * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); view.setUint32(4, 36 + len * ch * 2, true); str(8, "WAVE");
  str(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, ch, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * ch * 2, true); view.setUint16(32, ch * 2, true);
  view.setUint16(34, 16, true); str(36, "data"); view.setUint32(40, len * ch * 2, true);
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++)
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  return new Blob([view], { type: "audio/wav" });
}
