/**
 * Analysis Web Worker: runs the alignment math off the UI thread.
 * Receives { videoPcm, studioPcm, sr, videoDuration } (transferred buffers),
 * posts { type: "progress", message } updates and a final
 * { type: "done", analysis } or { type: "error", message }.
 */

import { analyze } from "./analyze.js";

self.onmessage = (e) => {
  const { videoPcm, studioPcm, sr, videoDuration } = e.data;
  try {
    const analysis = analyze(
      videoPcm, studioPcm, sr, videoDuration,
      (message) => self.postMessage({ type: "progress", message }),
    );
    self.postMessage({ type: "done", analysis });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err?.stack || err) });
  }
};
