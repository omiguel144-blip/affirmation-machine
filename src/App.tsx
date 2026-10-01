import { useEffect, useRef, useState } from "react";
import { startRecording, decode, type Recorder } from "./audio/record";
import { autotune, type Scale } from "./audio/smooth";
import { trimSilence, toWav } from "./audio/trim";
import { planSession, encodeSession } from "./audio/session";
import { buildTone, keyRoot, noteName, type ToneKind, type ToneSettings } from "./audio/tones";
import type { MarimbaPattern } from "./audio/marimba";
import { verify, type VerifyReport } from "./audio/verify";
import { listSaved, saveItem, deleteItem, type Saved } from "./storage";

type Phase = "idle" | "recording" | "processing" | "ready";
type Mode = "gentle" | "autotune";
interface Clip { id: string; buffer: AudioBuffer; url: string; trimmed: number }

const LENGTHS = [5, 10, 20, 30, 60];

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
  const [clips, setClips] = useState<Clip[]>([]);
  const [minutes, setMinutes] = useState(60);
  const [gap, setGap] = useState(3);
  const [progress, setProgress] = useState(0);
  const startedAt = useRef(0);
  const [url, setUrl] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<Mode>("gentle");
  const [scale, setScale] = useState<Scale>("major");
  const [reverb, setReverb] = useState(0.35);
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
      const { buffer, removedSec } = trimSilence(await decode(b));
      setClips((c) => [...c, { id: crypto.randomUUID(), buffer, url: URL.createObjectURL(toWav(buffer)), trimmed: removedSec }]);
      setPhase("idle");
      return;
    }
    try {
      rec.current = await startRecording();
      setPhase("recording");
    } catch {
      setError("Microphone access is needed to record.");
    }
  }

  async function process() {
    if (!clips.length) return;
    setPhase("processing");
    setProgress(0);
    setError("");
    startedAt.current = Date.now();
    // keep phones from sleeping mid-build (a locked screen pauses the page)
    const lock = await navigator.wakeLock?.request("screen").catch(() => null);
    try {
      const voices = clips.map((c) => (mode === "autotune" ? autotune(c.buffer, scale, keyRoot(tone)) : c.buffer));
      const plan = await planSession({ clips: voices, gap, reverb, tone, minutes, title: name.trim() || "My Affirmations" });
      const result = await encodeSession(plan, setProgress);
      setReport(await verify(tone, result));
      if (url) URL.revokeObjectURL(url);
      setBlob(result.blob);
      setUrl(URL.createObjectURL(result.blob));
    } catch (e) {
      setError(`Something went wrong building the MP3: ${e instanceof Error ? e.message : e}`);
    }
    lock?.release();
    setPhase("ready");
  }

  function moveClip(i: number, dir: -1 | 1) {
    setClips((c) => {
      const n = [...c];
      [n[i], n[i + dir]] = [n[i + dir], n[i]];
      return n;
    });
  }
  function removeClip(id: string) {
    setClips((c) => c.filter((x) => x.id !== id));
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
    await saveItem({ id: crypto.randomUUID(), name: name.trim() || "My Affirmations", created: Date.now(), blob });
    setLibrary(await listSaved());
  }

  const fileName = (n: string) => `${n.replace(/[^\w ]+/g, "").trim() || "My Affirmations"}.mp3`;

  return (
    <main>
      <h1>Affirmation Machine</h1>
      <p className="sub">Speak it. Smooth it. Steep it in sound.</p>

      <button className={`orb ${phase}`} onClick={toggleRecord} disabled={phase === "processing"}>
        {phase === "recording" ? "Stop" : clips.length ? "Add another" : "Record"}
      </button>
      {error && <p className="error">{error}</p>}

      {clips.length > 0 && (
        <section className="panel">
          <label>Your affirmation set <span>{clips.length} · plays in this order, on repeat</span></label>
          {clips.map((c, i) => (
            <div key={c.id} className="clip">
              <span className="num">{i + 1}</span>
              <div className="clipmain">
                <audio src={c.url} controls />
                <small>{c.buffer.duration.toFixed(1)} s{c.trimmed >= 0.1 && ` · trimmed ${c.trimmed.toFixed(1)} s of silence`}</small>
              </div>
              <button className="icon" disabled={i === 0} onClick={() => moveClip(i, -1)} aria-label="Move up">↑</button>
              <button className="icon" onClick={() => removeClip(c.id)} aria-label="Remove">✕</button>
            </div>
          ))}
        </section>
      )}

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
        {mode === "autotune" && (
          <p className="hint">
            Key of {noteName(keyRoot(tone))} {scale}, tuned to {keyRoot(tone).toFixed(1)} Hz — the same key as your {tone.marimba.on ? "marimba and " : ""}background tone.
          </p>
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

        <label>Session length</label>
        <div className="seg">
          {LENGTHS.map((m) => (
            <button key={m} className={minutes === m ? "on" : ""} onClick={() => setMinutes(m)}>{m === 60 ? "1 hr" : `${m} min`}</button>
          ))}
        </div>
        <label>Pause between affirmations <span>{gap} s</span></label>
        <input type="range" min={1} max={10} step={0.5} value={gap} onChange={(e) => setGap(+e.target.value)} />
        <label>Track title</label>
        <input className="text" placeholder="My Affirmations" value={name} onChange={(e) => setName(e.target.value)} />
      </section>

      <button className="primary" onClick={process} disabled={!clips.length || phase === "processing" || phase === "recording"}>
        {phase === "processing" ? `Building MP3… ${Math.round(progress * 100)}%` : `Create ${minutes === 60 ? "1-hour" : `${minutes}-min`} MP3`}
      </button>
      {phase === "processing" && (
        <>
          <div className="bar"><div style={{ width: `${progress * 100}%` }} /></div>
          <p className="hint">{eta(progress, startedAt.current)} · keep this tab open and your screen on</p>
        </>
      )}

      {url && (
        <section className="panel result">
          <audio src={url} controls />
          <div className="row">
            <small>{blob && `${(blob.size / 1048576).toFixed(0)} MB · MP3 128 kbps`}</small>
            <button onClick={save}>Save to library</button>
            <a className="btn" href={url} download={fileName(name)}>Download MP3</a>
          </div>
          <details className="verify">
            <summary>Add to Apple Music</summary>
            <p><strong>Mac:</strong> open the Music app → File → Import… → pick the MP3. Or drag the file into Music.</p>
            <p><strong>iPhone:</strong> import it on your Mac first, then sync your iPhone in Finder (or turn on Sync Library with Apple Music / iTunes Match so it appears on all your devices).</p>
            <p><strong>Windows:</strong> use the Apple Music app or iTunes → File → Add File to Library.</p>
          </details>
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

function eta(p: number, started: number): string {
  if (p < 0.03) return "Estimating time…";
  const left = ((Date.now() - started) / p) * (1 - p) / 1000;
  return left > 90 ? `About ${Math.ceil(left / 60)} min left` : `About ${Math.max(5, Math.round(left / 5) * 5)} s left`;
}

function LibraryItem({ item, onDelete, fileName }: { item: Saved; onDelete: () => void; fileName: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => { const u = URL.createObjectURL(item.blob); setSrc(u); return () => URL.revokeObjectURL(u); }, [item.blob]);
  return (
    <div className="item">
      <div className="row"><strong>{item.name}</strong><small>{new Date(item.created).toLocaleDateString()}</small></div>
      <audio src={src} controls />
      <div className="row"><a className="btn" href={src} download={fileName}>Download</a><button className="ghost" onClick={onDelete}>Delete</button></div>
    </div>
  );
}

function Verification({ r }: { r: VerifyReport }) {
  const clean = r.tones.every((t) => Math.abs(t.measured - t.expected) < 0.5 && t.harmonicsDb.every((h) => h < -40));
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
      <div className="row"><span>Clipping</span><span>{r.clippedSamples === 0 ? "None" : `None (${r.clippedSamples} peaks softly limited)`}</span></div>
      <div className="row"><span>Peak level</span><span>{r.peakDb.toFixed(1)} dBFS</span></div>
      <p className="hint">Measured from the rendered audio with a Goertzel scan. Harmonics below −40 dB mean a pure sine. This confirms the tone is really there and clean. It can't confirm any manifestation effect: treat the sound as a cue to pause and focus.</p>
    </details>
  );
}
