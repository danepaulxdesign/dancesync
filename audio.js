/**
 * Browser-side audio decoding. Replaces the desktop app's ffmpeg PCM pipe:
 * the Web Audio API decodes any container the browser can play (mp4/mov/m4a/
 * mp3/wav/...) natively, no wasm needed for analysis.
 */

export const ANALYSIS_SR = 22050;

/** Decode a File to an AudioBuffer at its native sample rate. */
export async function decodeFile(file) {
  const bytes = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    return await ctx.decodeAudioData(bytes);
  } finally {
    ctx.close();
  }
}

/** Downmix + resample an AudioBuffer to mono Float32Array at ANALYSIS_SR. */
export async function toAnalysisPcm(buffer) {
  const frames = Math.ceil(buffer.duration * ANALYSIS_SR);
  const off = new OfflineAudioContext(1, frames, ANALYSIS_SR);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0).slice();
}
