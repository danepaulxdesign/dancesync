/**
 * Verdict + analysis orchestration — JS port of core/verdict.py and the
 * analyze() half of core/pipeline.py. Pure logic; runs in browser and Node.
 */

import { detectAlignment, refineOffsetWaveform } from "./align.js";

const NEGLIGIBLE_DRIFT = 5e-4;
const MAX_CORRECTABLE = 0.04;
const MAX_RESIDUAL_MS = 150.0;
const MIN_CONFIDENCE = 0.5;

/**
 * Analyze both decoded audio tracks.
 * Returns {
 *   offset0, speedRatio, status: "ok"|"drift_corrected"|"flagged",
 *   confidence, messages: string[]
 * }
 * Nudge convention matches desktop: effectiveOffset = offset0 - nudgeMs/1000
 * (positive nudge plays the studio track later).
 */
export function analyze(videoAudio, studioAudio, sr, videoDuration, onProgress) {
  const a = detectAlignment(videoAudio, studioAudio, sr, onProgress);
  const msgs = [];
  const drift = a.speedRatio - 1.0;

  if (a.nSegments === 0 && a.confidence === 0) {
    return { offset0: 0, speedRatio: 1, status: "flagged", confidence: 0,
             messages: ["Could not analyze audio - a file may be silent or unreadable."] };
  }

  if (a.confidence < MIN_CONFIDENCE) {
    msgs.push(
      `Low alignment confidence: only ${a.nAgree}/${a.nSegments} sections ` +
      "of the video agreed on a sync position. The room audio may be very " +
      "noisy, or this may be a different version of the song. Check the " +
      "preview carefully."
    );
  }

  let status, speed, offset0 = a.offset0;
  if (Math.abs(drift) < NEGLIGIBLE_DRIFT) {
    status = "ok";
    speed = 1.0;
    if (a.nSegments >= 3) msgs.push("No meaningful tempo drift detected.");
  } else if (Math.abs(drift) > MAX_CORRECTABLE) {
    status = "flagged";
    speed = 1.0;
    offset0 = a.offset0 + drift * (videoDuration / 2); // center the error
    msgs.push(
      `Detected a ${(drift * 100).toFixed(1)}% speed difference - too large ` +
      "to correct automatically. The live version may be a different edit " +
      "or remix. Sync will use a constant offset; review manually."
    );
  } else if (a.maxResidualMs > MAX_RESIDUAL_MS) {
    status = "flagged";
    speed = 1.0;
    offset0 = a.offset0 + drift * (videoDuration / 2);
    msgs.push(
      `Tempo drift is not steady (sections deviate up to ` +
      `${Math.round(a.maxResidualMs)} ms). The playback may have been ` +
      "paused or tempo-shifted mid-song. Sync will use a constant offset; " +
      "review manually."
    );
  } else {
    status = "drift_corrected";
    speed = a.speedRatio;
    msgs.push(
      `Live playback ran ${(drift * 100).toFixed(3)}% relative to the ` +
      "studio track. The studio track will be time-stretched (pitch " +
      "preserved on export) to match your footage."
    );
  }

  if (speed === 1.0) {
    if (onProgress) onProgress("Refining offset (waveform GCC-PHAT)...");
    offset0 = refineOffsetWaveform(videoAudio, studioAudio, sr, offset0);
  }

  return { offset0, speedRatio: speed, status,
           confidence: a.confidence, messages: msgs };
}

export function effectiveOffset(analysis, nudgeMs) {
  return analysis.offset0 - nudgeMs / 1000.0;
}
