import { voiceChain } from "./smooth";
import { buildTone, type ToneSettings } from "./tones";

export interface MixSettings {
  tone: ToneSettings;
  reverb: number;
  repeats: number;
  gap: number;
}

export async function renderMix(voice: AudioBuffer, s: MixSettings): Promise<AudioBuffer> {
  const sr = 44100;
  const lead = 1.5, tail = 3;
  const total = lead + s.repeats * (voice.duration + s.gap) + tail;
  const ctx = new OfflineAudioContext(2, Math.ceil(total * sr), sr);

  const bus = new GainNode(ctx);
  const out = voiceChain(ctx, bus, s.reverb);
  out.connect(ctx.destination);
  for (let i = 0; i < s.repeats; i++) {
    const src = new AudioBufferSourceNode(ctx, { buffer: voice });
    src.connect(bus);
    src.start(lead + i * (voice.duration + s.gap));
  }
  buildTone(ctx, ctx.destination, s.tone, 0, total);

  const buf = await ctx.startRendering();
  // normalize to -1 dBFS
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++)
    for (const v of buf.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? 0.89 / peak : 1;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return buf;
}

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
