/**
 * UI wiring. Mirrors the desktop workflow:
 * 1 files -> 2 analyze -> 3 mode -> 4 live preview -> 5 export.
 */

import { decodeFile, toAnalysisPcm, ANALYSIS_SR } from "./audio.js";
import { PreviewEngine } from "./preview.js";
import { exportFinal } from "./exporter.js";

const $ = (id) => document.getElementById(id);

const state = {
  videoFile: null,
  studioFile: null,
  studioBuffer: null,   // native-rate AudioBuffer for preview
  analysis: null,
  nudgeMs: 0,
  mode: "replace",
  livePct: 50,
};

const videoEl = $("preview-video");
const engine = new PreviewEngine(videoEl);

function setStatus(msg, kind = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + kind;
}

function fmtOffset(analysis) {
  const drift = (analysis.speedRatio - 1) * 100;
  return [
    `Sync offset: song starts ${analysis.offset0 >= 0 ? "+" : ""}` +
      `${analysis.offset0.toFixed(2)} s relative to video start`,
    `Tempo drift: ${drift >= 0 ? "+" : ""}${drift.toFixed(3)}% ` +
      `(${analysis.status === "drift_corrected" ? "corrected" : "none applied"})`,
    `Confidence: ${Math.round(analysis.confidence * 100)}% of video sections agree`,
  ].join("\n");
}

// ---------- step 1: files ----------
$("video-input").addEventListener("change", (e) => {
  state.videoFile = e.target.files[0] || null;
  $("video-name").textContent = state.videoFile ? state.videoFile.name : "none";
  if (state.videoFile) {
    videoEl.src = URL.createObjectURL(state.videoFile);
    if (state.videoFile.size > 800 * 1024 * 1024) {
      setStatus("Heads up: files this large can exceed browser memory " +
                "during export. Preview will still work.", "warn");
    }
  }
  maybeEnableAnalyze();
});

$("studio-input").addEventListener("change", (e) => {
  state.studioFile = e.target.files[0] || null;
  $("studio-name").textContent = state.studioFile ? state.studioFile.name : "none";
  maybeEnableAnalyze();
});

function maybeEnableAnalyze() {
  $("analyze-btn").disabled = !(state.videoFile && state.studioFile);
}

// ---------- step 2: analyze ----------
$("analyze-btn").addEventListener("click", async () => {
  setBusy(true);
  $("result").textContent = "";
  try {
    setStatus("Decoding audio from video...");
    const videoBuf = await decodeFile(state.videoFile);
    setStatus("Decoding studio track...");
    state.studioBuffer = await decodeFile(state.studioFile);

    setStatus("Preparing analysis audio...");
    const [videoPcm, studioPcm] = await Promise.all([
      toAnalysisPcm(videoBuf),
      toAnalysisPcm(state.studioBuffer),
    ]);

    const analysis = await runWorker(videoPcm, studioPcm, videoBuf.duration);
    state.analysis = analysis;
    engine.configure(state.studioBuffer, analysis);
    engine.setMode(state.mode, state.livePct);

    $("result").textContent = fmtOffset(analysis);
    const kind = analysis.status === "flagged" ? "warn" : "ok";
    setStatus(analysis.messages.join(" "), kind);
    $("export-btn").disabled = false;
    $("preview-hint").textContent =
      "Press play - the studio track follows the video in real time. " +
      "Adjust sliders while it plays.";
  } catch (err) {
    setStatus("Analysis failed: " + (err?.message || err), "error");
    console.error(err);
  } finally {
    setBusy(false);
  }
});

function runWorker(videoPcm, studioPcm, videoDuration) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./worker.js", import.meta.url),
                              { type: "module" });
    worker.onmessage = (e) => {
      if (e.data.type === "progress") setStatus(e.data.message);
      else if (e.data.type === "done") { worker.terminate(); resolve(e.data.analysis); }
      else { worker.terminate(); reject(new Error(e.data.message)); }
    };
    worker.onerror = (e) => { worker.terminate(); reject(e); };
    worker.postMessage(
      { videoPcm, studioPcm, sr: ANALYSIS_SR, videoDuration },
      [videoPcm.buffer, studioPcm.buffer],
    );
  });
}

// ---------- step 3: mode + balance ----------
document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    state.mode = radio.value;
    const balance = state.mode === "balance";
    $("balance-slider").disabled = !balance;
    $("balance-row").classList.toggle("disabled", !balance);
    engine.setMode(state.mode, state.livePct);
  });
});

$("balance-slider").addEventListener("input", (e) => {
  state.livePct = Number(e.target.value);
  $("balance-label").textContent =
    `Mix: ${state.livePct}% live / ${100 - state.livePct}% studio`;
  engine.setMode(state.mode, state.livePct);
});

// ---------- step 4: nudge ----------
$("nudge-slider").addEventListener("input", (e) => {
  const snapped = Math.round(Number(e.target.value) / 10) * 10;
  e.target.value = snapped;
  state.nudgeMs = snapped;
  $("nudge-label").textContent =
    `Nudge: ${snapped >= 0 ? "+" : ""}${snapped} ms`;
  engine.setNudge(snapped);
});

// ---------- step 5: export ----------
$("export-btn").addEventListener("click", async () => {
  setBusy(true);
  const bar = $("export-bar");
  bar.style.display = "block";
  bar.value = 0;
  try {
    const blob = await exportFinal({
      videoFile: state.videoFile,
      studioFile: state.studioFile,
      videoDuration: videoEl.duration,
      offsetEff: state.analysis.offset0 - state.nudgeMs / 1000,
      speedRatio: state.analysis.speedRatio,
      mode: state.mode,
      livePct: state.livePct,
      onProgress: (m) => setStatus(m),
      onRatio: (p) => { bar.value = p; },
    });
    const name = state.videoFile.name.replace(/\.[^.]+$/, "") + "_synced.mp4";
    const url = URL.createObjectURL(blob);
    const a = $("download-link");
    a.href = url;
    a.download = name;
    a.textContent = `Download ${name} (${(blob.size / 1e6).toFixed(1)} MB)`;
    a.style.display = "inline-block";
    setStatus("Export complete.", "ok");
  } catch (err) {
    setStatus("Export failed: " + (err?.message || err), "error");
    console.error(err);
  } finally {
    bar.style.display = "none";
    setBusy(false);
  }
});

function setBusy(busy) {
  for (const id of ["analyze-btn", "export-btn", "video-input", "studio-input"]) {
    $(id).disabled = busy;
  }
  if (!busy) {
    maybeEnableAnalyze();
    $("export-btn").disabled = !state.analysis;
  }
}
