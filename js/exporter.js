/**
 * Export via ffmpeg.wasm — same filter graphs as desktop core/render.py.
 * Video stream is copied (no re-encode), only audio is rebuilt, so even the
 * single-threaded wasm build finishes in roughly real-time or better.
 */

import { FFmpeg } from "../vendor/ffmpeg/index.js";

let ffmpeg = null;

async function getFFmpeg(onProgress) {
  if (ffmpeg) return ffmpeg;
  const f = new FFmpeg();
  if (onProgress) onProgress("Loading ffmpeg.wasm (first time only)...");
  const base = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/";
  await f.load({
    coreURL: base + "ffmpeg-core.js",
    wasmURL: base + "ffmpeg-core.wasm",
  });
  ffmpeg = f;
  return ffmpeg;
}

function studioFilter(r, outDur, delaySec) {
  const parts = [];
  if (Math.abs(r - 1.0) > 1e-6) parts.push(`atempo=${r.toFixed(6)}`);
  if (delaySec > 0) parts.push(`adelay=${Math.round(delaySec * 1000)}:all=1`);
  parts.push(`atrim=0:${outDur.toFixed(3)}`);
  parts.push("apad");
  return parts.join(",");
}

function audioGraph(r, outDur, delaySec, mode, livePct) {
  const studio = studioFilter(r, outDur, delaySec);
  if (mode === "replace") return `[1:a]${studio}[aud]`;
  const wLive = Math.max(0, Math.min(100, livePct)) / 100;
  const wStudio = 1 - wLive;
  // Complementary weights: convex combination, cannot clip; no limiter
  // (a limiter's lookahead would delay the mix and break sync).
  return (
    `[1:a]${studio},volume=${wStudio.toFixed(4)}[sa];` +
    `[0:a]atrim=0:${outDur.toFixed(3)},apad,volume=${wLive.toFixed(4)}[la];` +
    `[la][sa]amix=inputs=2:duration=first:normalize=0[aud]`
  );
}

/**
 * Render the final video. Returns a Blob (video/mp4).
 * opts: { videoFile, studioFile, videoDuration, offsetEff, speedRatio,
 *         mode, livePct, onProgress(msg), onRatio(0..1) }
 */
export async function exportFinal(opts) {
  const { videoFile, studioFile, videoDuration, offsetEff, speedRatio,
          mode = "replace", livePct = 50, onProgress, onRatio } = opts;

  const f = await getFFmpeg(onProgress);
  const progressHandler = ({ progress }) => {
    if (onRatio && progress >= 0 && progress <= 1) onRatio(progress);
  };
  f.on("progress", progressHandler);

  const r = speedRatio;
  let seek = 0, delay = 0;
  if (offsetEff >= 0) seek = offsetEff;
  else delay = -offsetEff / r;

  const graph = audioGraph(r, videoDuration, delay, mode, livePct);

  try {
    if (onProgress) onProgress("Copying files into the converter...");
    await f.writeFile("in_video", new Uint8Array(await videoFile.arrayBuffer()));
    await f.writeFile("in_studio", new Uint8Array(await studioFile.arrayBuffer()));

    if (onProgress) onProgress("Rendering (video stream copied, audio rebuilt)...");
    const args = [
      "-i", "in_video",
      "-ss", seek.toFixed(4), "-i", "in_studio",
      "-filter_complex", graph,
      "-map", "0:v:0", "-map", "[aud]",
      "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
      "-t", videoDuration.toFixed(3),
      "-movflags", "+faststart",
      "out.mp4",
    ];
    const code = await f.exec(args);
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}`);

    const data = await f.readFile("out.mp4");
    return new Blob([data.buffer], { type: "video/mp4" });
  } finally {
    f.off("progress", progressHandler);
    for (const name of ["in_video", "in_studio", "out.mp4"]) {
      try { await f.deleteFile(name); } catch (_) { /* may not exist */ }
    }
  }
}
