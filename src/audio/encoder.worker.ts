import { Mp3Encoder } from "@breezystack/lamejs";
import type { SessionPlan } from "./session";

const SR = 44100;
const BLOCK = 1152 * 40;

/** Minimal ID3v2.3 tag so Apple Music shows a proper title, artist and genre. */
function id3(title: string): Uint8Array {
  const frame = (id: string, text: string) => {
    const body = new Uint8Array(3 + text.length * 2);
    body.set([1, 0xff, 0xfe]); // UTF-16 with BOM
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      body[3 + i * 2] = c & 0xff;
      body[4 + i * 2] = c >> 8;
    }
    const out = new Uint8Array(10 + body.length);
    out.set([...id].map((ch) => ch.charCodeAt(0)));
    new DataView(out.buffer).setUint32(4, body.length);
    out.set(body, 10);
    return out;
  };
  const frames = [
    frame("TIT2", title),
    frame("TPE1", "Affirmation Machine"),
    frame("TALB", "My Affirmations"),
    frame("TCON", "Meditation"),
  ];
  const size = frames.reduce((n, f) => n + f.length, 0);
  const head = new Uint8Array(10);
  head.set([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  const tag = new Uint8Array(10 + size);
  tag.set(head);
  let o = 10;
  for (const f of frames) { tag.set(f, o); o += f.length; }
  return tag;
}

self.onmessage = (e: MessageEvent<SessionPlan>) => {
  const p = e.data;
  const total = Math.round(p.durationSec * SR);
  const introN = Math.round(p.introSec * SR);
  const cycleN = p.voiceLoop[0].length;
  const outroN = 10 * SR;
  const cycles = Math.max(1, Math.floor((total - introN - outroN) / cycleN));
  const voiceEnd = introN + cycles * cycleN;
  const fadeIn = 4 * SR, fadeOut = 8 * SR;

  const enc = new Mp3Encoder(2, SR, 128);
  const parts: BlobPart[] = [id3(p.title) as BlobPart];
  const L16 = new Int16Array(BLOCK), R16 = new Int16Array(BLOCK);
  let peak = 0, limited = 0;
  // pink-noise rain state
  let b0 = 0, b1 = 0, b2 = 0, lp = 0;
  const lpA = 1 - Math.exp((-2 * Math.PI * 3000) / SR);
  const wl = p.tone ? (2 * Math.PI * p.tone.left) / SR : 0;
  const wr = p.tone ? (2 * Math.PI * p.tone.right) / SR : 0;
  const tail = p.voiceTail;

  // soft limiter above -1 dBFS, then to 16-bit
  const limit = (v: number) => {
    let a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    if (a > 0.89) { limited++; a = 0.89 + 0.1 * Math.tanh((a - 0.89) / 0.1); }
    return (v < 0 ? -a : a) * 32767;
  };
  const mFirst = p.marimbaFirst, mLoop = p.marimbaLoop;
  const mFirstN = mFirst ? mFirst[0].length : 0, mLoopN = mLoop ? mLoop[0].length : 1;

  for (let start = 0; start < total; start += BLOCK) {
    const n = Math.min(BLOCK, total - start);
    for (let j = 0; j < n; j++) {
      const i = start + j;
      let l = 0, r = 0;
      // affirmations
      if (i >= introN && i < voiceEnd) {
        const k = i - introN;
        if (k < cycleN) { l += p.voiceFirst[0][k]; r += p.voiceFirst[1][k]; }
        else { const m = k % cycleN; l += p.voiceLoop[0][m]; r += p.voiceLoop[1][m]; }
      } else if (i >= voiceEnd && i - voiceEnd < tail[0].length) {
        l += tail[0][i - voiceEnd]; r += tail[1][i - voiceEnd];
      }
      // background bed, with fade in/out
      const env = Math.min(1, i / fadeIn, (total - i) / fadeOut);
      let bg_l = 0, bg_r = 0;
      if (p.tone) {
        bg_l += Math.sin(wl * i) * p.tone.gain;
        bg_r += Math.sin(wr * i) * p.tone.gain;
      }
      if (mFirst && mLoop) {
        if (i < mFirstN) { bg_l += mFirst[0][i]; bg_r += mFirst[1][i]; }
        else { const m = (i - mFirstN) % mLoopN; bg_l += mLoop[0][m]; bg_r += mLoop[1][m]; }
      }
      if (p.rainGain) {
        const w = Math.random() * 2 - 1;
        b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.95 * b2 + w * 0.048;
        lp += lpA * ((b0 + b1 + b2) * 0.5 - lp);
        bg_l += lp * p.rainGain; bg_r += lp * p.rainGain;
      }
      l = l * Math.min(1, (total - i) / fadeOut) + bg_l * env;
      r = r * Math.min(1, (total - i) / fadeOut) + bg_r * env;
      L16[j] = limit(l);
      R16[j] = limit(r);
    }
    const mp3 = enc.encodeBuffer(L16.subarray(0, n), R16.subarray(0, n));
    if (mp3.length) parts.push(new Uint8Array(mp3) as BlobPart);
    self.postMessage({ type: "progress", value: (start + n) / total });
  }
  const last = enc.flush();
  if (last.length) parts.push(new Uint8Array(last) as BlobPart);
  self.postMessage({
    type: "done",
    result: { blob: new Blob(parts, { type: "audio/mpeg" }), peak, limitedSamples: limited, cycles },
  });
};
