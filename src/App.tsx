import { useEffect, useRef, useState } from "react";
import { startRecording, decode, type Recorder } from "./audio/record";
import { autotune, type Scale } from "./audio/smooth";
import { renderMix, toWav } from "./audio/mix";
import { buildTone, type ToneKind, type ToneSettings } from "./audio/tones";
import type { MarimbaPattern } from "./audio/marimba";
import { verify, type VerifyReport } from "./audio/verify";
import { listSaved, saveItem, deleteItem, type Saved } from "./storage";

type Phase = "idle" | "recording" | "processing" | "ready";
type Mode = "gentle" | "autotune";

const TONES: { kind: ToneKind; label: string }[] = [
  { kind: "432", label: "432 Hz" },
  { kind: "528", label: "528 Hz" },
  { kind: "639", label: "639 Hz" },
  { kind: "888", label: "888 Hz · abundance" },
  { kind: "binaural", label: "Binaural" },
  { kind: "none", label: "None" },
];

export default function App() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [raw, setRaw] = useState<AudioBuffer | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<Mode>("gentle");
  const [scale, setScale] = useState<Scale>("major");
  const [reverb, setReverb] = useState(0.35);
  const [repeats, setRepeats] = useState(3);
  const [tone, setTone] = useState<ToneSettings>({ kind: "888", volumeDb: -22, carrier: 200, beat: 10, rain: false,
    marimba: { on: true, pattern: "flow", bpm: 72, volumeDb: -18 } });
  const [name, setName] = useState("");
  const [library, setLibrary] = useState<Saved[]>([]);
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const rec = useRef<Recorder | null>(null);
  const preview = useRef<AudioContext | null>(null);

  useEffect(() => { listSaved().then(setLibrary); }, []);

  async function toggleRecord() {
    setError("");
    if (phase === "recording") {
      const b = await rec.current!.stop();
      setRaw(await decode(b));
      setPhase("ready");
      return;
    }
    try {
      rec.current = await startRecording();
      setUrl(null); setBlob(null);
      setPhase("recording");
    } catch {
      setError("Microphone access is needed to record.");
    }
  }

  async function process() {
    if (!raw) return;
    setPhase("processing");
    await new Promise((r) => setTimeout(r, 30));
    const voice = mode === "autotune" ? autotune(raw, scale) : raw;
    const mixed = await renderMix(voice, { tone, reverb, repeats, gap: 1.5 });
    setReport(await verify(tone, mixed));
    const w = toWav(mixed);
    if (url) URL.revokeObjectURL(url);
    setBlob(w);
    setUrl(URL.createObjectURL(w));
    setPhase("ready");
  }

  const setMarimba = (m: Partial<ToneSettings["marimba"]>) => setTone({ ...tone, marimba: { ...tone.marimba, ...m } });

  function togglePreview() {
    if (preview.current) { preview.current.close(); preview.current = null; setPreviewing(false); return; }
    const ctx = new AudioContext();
    buildTone(ctx, ctx.destination, tone, ctx.currentTime, ctx.currentTime + 300);
    preview.current = ctx;
    setPreviewing(true);
  }
  useEffect(() => { if (preview.current) { preview.current.close(); preview.current = null; setPreviewing(false); } }, [tone]);

  async function save() {
    if (!blob) return;
    await saveItem({ id: crypto.randomUUID(), name: name.trim() || "Untitled affirmation", created: Date.now(), blob });
    setName("");
    setLibrary(await listSaved());
  }

  const fileName = (n: string) => `${n.replace(/[^\w ]+/g, "").trim() || "affirmation"}.wav`;

  return (
    <main>
      <h1>Affirmation Machine</h1>
      <p className="sub">Speak it. Smooth it. Steep it in sound.</p>

      <button className={`orb ${phase}`} onClick={toggleRecord} disabled={phase === "processing"}>
        {phase === "recording" ? "Stop" : raw ? "Re-record" : "Record"}
      </button>
      {error && <p className="error">{error}</p>}

      <section className="panel">
        <label>Voice</label>
        <div className="seg">
          {(["gentle", "autotune"] as Mode[]).map((m) => (
            <button key={m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>
              {m === "gentle" ? "Gentle polish" : "Autotune"}
            </button>
          ))}
        </div>
        {mode === "autotune" && (
          <div className="seg small">
            {(["major", "pentatonic"] as Scale[]).map((s) => (
              <button key={s} className={scale === s ? "on" : ""} onClick={() => setScale(s)}>{s}</button>
            ))}
          </div>
        )}
        <label>Reverb <span>{Math.round(reverb * 100)}%</span></label>
        <input type="range" min={0} max={0.8} step={0.05} value={reverb} onChange={(e) => setReverb(+e.target.value)} />

        <label>Background frequency</label>
        <div className="seg wrap">
          {TONES.map((t) => (
            <button key={t.kind} className={tone.kind === t.kind ? "on" : ""} onClick={() => setTone({ ...tone, kind: t.kind })}>{t.label}</button>
          ))}
        </div>
        {tone.kind === "binaural" && (
          <>
            <label>Beat <span>{tone.beat} Hz {tone.beat < 8 ? "(theta)" : "(alpha)"}</span></label>
            <input type="range" min={4} max={12} step={0.5} value={tone.beat} onChange={(e) => setTone({ ...tone, beat: +e.target.value })} />
            <p className="hint">Use headphones for binaural beats.</p>
          </>
        )}
        <label>Tone volume <span>{tone.volumeDb} dB</span></label>
        <input type="range" min={-40} max={-6} step={1} value={tone.volumeDb} onChange={(e) => setTone({ ...tone, volumeDb: +e.target.value })} />
        <label className="check">
          <input type="checkbox" checked={tone.rain} onChange={(e) => setTone({ ...tone, rain: e.target.checked })} /> Soft rain underneath
        </label>
        <label className="check">
          <input type="checkbox" checked={tone.marimba.on} onChange={(e) => setMarimba({ on: e.target.checked })} /> Marimba groove
        </label>
        {tone.marimba.on && (
          <>
            <div className="seg small">
              {(["flow", "ripple", "heartbeat"] as MarimbaPattern[]).map((p) => (
                <button key={p} className={tone.marimba.pattern === p ? "on" : ""} onClick={() => setMarimba({ pattern: p })}>{p}</button>
              ))}
            </div>
            <label>Tempo <span>{tone.marimba.bpm} BPM</span></label>
            <input type="range" min={50} max={110} step={1} value={tone.marimba.bpm} onChange={(e) => setMarimba({ bpm: +e.target.value })} />
            <label>Marimba volume <span>{tone.marimba.volumeDb} dB</span></label>
            <input type="range" min={-36} max={-6} step={1} value={tone.marimba.volumeDb} onChange={(e) => setMarimba({ volumeDb: +e.target.value })} />
            <p className="hint">Tuned to your chosen frequency, so it harmonizes with the tone.</p>
          </>
        )}
        <button className="ghost" onClick={togglePreview}>{previewing ? "Stop preview" : "Preview background"}</button>

        <label>Repeats <span>×{repeats}</span></label>
        <input type="range" min={1} max={12} step={1} value={repeats} onChange={(e) => setRepeats(+e.target.value)} />
      </section>

      <button className="primary" onClick={process} disabled={!raw || phase === "processing" || phase === "recording"}>
        {phase === "processing" ? "Creating…" : "Create affirmation"}
      </button>

      {url && (
        <section className="panel result">
          <audio src={url} controls />
          <div className="row">
            <input placeholder="Name it…" value={name} onChange={(e) => setName(e.target.value)} />
            <button onClick={save}>Save</button>
            <a className="btn" href={url} download={fileName(name)}>Download</a>
          </div>
          {report && <Verification r={report} />}
        </section>
      )}

      {library.length > 0 && (
        <section className="panel">
          <label>Your library</label>
          {library.map((item) => <LibraryItem key={item.id} item={item} onDelete={async () => { await deleteItem(item.id); setLibrary(await listSaved()); }} fileName={fileName(item.name)} />)}
        </section>
      )}
    </main>
  );
}

function LibraryItem({ item, onDelete, fileName }: { item: Saved; onDelete: () => void; fileName: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => { const u = URL.createObjectURL(item.blob); setSrc(u); return () => URL.revokeObjectURL(u); }, [item.blob]);
  return (
    <div className="item">
      <div className="row"><strong>{item.name}</strong><small>{new Date(item.created).toLocaleDateString()}</small></div>
      <audio src={src} controls loop />
      <div className="row"><a className="btn" href={src} download={fileName}>Download</a><button className="ghost" onClick={onDelete}>Delete</button></div>
    </div>
  );
}

function Verification({ r }: { r: VerifyReport }) {
  const clean = r.tones.every((t) => Math.abs(t.measured - t.expected) < 0.5 && t.harmonicsDb.every((h) => h < -40)) && r.clippedSamples === 0;
  return (
    <details className="verify">
      <summary>{clean ? "✓ Frequency verified · no distortion" : "⚠ Check frequency report"}</summary>
      {r.tones.map((t) => (
        <div key={t.channel} className="row">
          <span>{t.channel}</span>
          <span>{t.measured.toFixed(2)} Hz <small>(target {t.expected} Hz)</small></span>
        </div>
      ))}
      {r.tones.map((t) => (
        <div key={t.channel + "h"} className="row">
          <span>Harmonics 2×/3×/4×</span>
          <small>{t.harmonicsDb.map((h) => (h < -99 ? "<−99" : h.toFixed(0))).join(" / ")} dB</small>
        </div>
      ))}
      <div className="row"><span>Clipping</span><span>{r.clippedSamples === 0 ? "None" : `${r.clippedSamples} samples`}</span></div>
      <div className="row"><span>Peak level</span><span>{r.peakDb.toFixed(1)} dBFS</span></div>
      <p className="hint">Measured from the rendered audio with a Goertzel scan. Harmonics below −40 dB mean a pure sine. This confirms the tone is really there and clean. It can't confirm any manifestation effect: treat the sound as a cue to pause and focus.</p>
    </details>
  );
}
