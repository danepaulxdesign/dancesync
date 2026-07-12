/**
 * Joint offset + drift estimation — JS port of core/align.py.
 *
 * Estimator: for candidate speed ratios r, resample the studio onset
 * envelope so a constant cross-correlation lag corresponds to
 *     studio_time = offset + r * video_time
 * and correlate the FULL video envelope against it. Only the true r aligns
 * every onset simultaneously (immune to beat aliasing and chorus repeats).
 * Segments are then re-measured near the line purely as diagnostics.
 */

import FFT from "../vendor/fft.mjs";
import { onsetStrength, HOP } from "./dsp.js";

export const MAX_SLOPE = 0.06;
const SEGMENTS = 3;
const SEG_MIN_SEC = 6.0;
const SEG_SEARCH_SEC = 1.0;
const SEG_AGREE_SEC = 0.15;

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Full cross-correlation of a against b via FFT.
 *  Returns Float64Array of length a.length + b.length - 1,
 *  where index i corresponds to lag = i - (b.length - 1)  (b shifted by lag).
 */
export function xcorrFull(a, b) {
  const n = a.length + b.length - 1;
  const size = nextPow2(n);
  const fft = new FFT(size);

  const fa = fft.createComplexArray();
  const fb = fft.createComplexArray();
  const ta = new Float64Array(size);
  const tb = new Float64Array(size);
  ta.set(a);
  for (let i = 0; i < b.length; i++) tb[i] = b[b.length - 1 - i]; // reversed
  fft.realTransform(fa, ta);
  fft.completeSpectrum(fa);
  fft.realTransform(fb, tb);
  fft.completeSpectrum(fb);

  const prod = fft.createComplexArray();
  for (let i = 0; i < size; i++) {
    const ar = fa[2 * i], ai = fa[2 * i + 1];
    const br = fb[2 * i], bi = fb[2 * i + 1];
    prod[2 * i] = ar * br - ai * bi;
    prod[2 * i + 1] = ar * bi + ai * br;
  }
  const inv = fft.createComplexArray();
  fft.inverseTransform(inv, prod);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = inv[2 * i];
  return out;
}

function standardize(x) {
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= x.length;
  let sq = 0;
  for (let i = 0; i < x.length; i++) {
    const d = x[i] - mean;
    sq += d * d;
  }
  const std = Math.sqrt(sq / x.length);
  const out = new Float64Array(x.length);
  const s = std > 0 ? 1 / std : 1;
  for (let i = 0; i < x.length; i++) out[i] = (x[i] - mean) * s;
  return out;
}

export function onsetEnvelope(y, sr) {
  return standardize(onsetStrength(y, sr, HOP));
}

/** Resample studio envelope so index j corresponds to studio time r*j/fr. */
function stretchEnv(envS, r) {
  const n = Math.floor(envS.length / r);
  const out = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    const x = j * r;
    const i = Math.floor(x);
    if (i >= envS.length - 1) {
      out[j] = envS[envS.length - 1];
    } else {
      const t = x - i;
      out[j] = envS[i] * (1 - t) + envS[i + 1] * t;
    }
  }
  return standardize(out);
}

function tryRatio(envV, envS, frameRate, r) {
  const es = stretchEnv(envS, r);
  const corr = xcorrFull(envV, es);
  let best = -Infinity, bi = 0;
  for (let i = 0; i < corr.length; i++) {
    if (corr[i] > best) { best = corr[i]; bi = i; }
  }
  const lag = bi - (es.length - 1);
  const off = (-lag * r) / frameRate;
  return { score: best, off };
}

function scanSpeed(envV, envS, frameRate, onProgress) {
  let bestR = 1.0, bestOff = 0.0, bestScore = -Infinity;
  const coarse = [];
  for (let r = 1.0 - MAX_SLOPE; r <= 1.0 + MAX_SLOPE + 1e-9; r += 0.002) {
    coarse.push(Number(r.toFixed(6)));
  }
  coarse.forEach((r, i) => {
    const { score, off } = tryRatio(envV, envS, frameRate, r);
    if (score > bestScore) { bestR = r; bestOff = off; bestScore = score; }
    if (onProgress && i % 10 === 0) {
      onProgress(`Scanning tempo drift... ${Math.round((100 * i) / coarse.length)}%`);
    }
  });
  for (let r = bestR - 0.002; r <= bestR + 0.002 + 1e-9; r += 0.0002) {
    const { score, off } = tryRatio(envV, envS, frameRate, r);
    if (score > bestScore) { bestR = r; bestOff = off; bestScore = score; }
  }
  return { r: bestR, off: bestOff, score: bestScore };
}

/** Valid-mode correlation: b slides fully inside a. */
function xcorrValid(a, b) {
  const full = xcorrFull(a, b);
  // valid lags: b entirely within a -> lag in [0, a.length - b.length]
  const start = b.length - 1;
  const count = a.length - b.length + 1;
  return count > 0 ? full.subarray(start, start + count) : new Float64Array(0);
}

function segmentOffsets(envV, envS, frameRate, off, r) {
  const es = stretchEnv(envS, r);
  const segF = Math.floor(envV.length / SEGMENTS);
  if (segF < Math.floor(SEG_MIN_SEC * frameRate)) return [];
  const pad = Math.floor(SEG_SEARCH_SEC * frameRate);
  const out = [];
  for (let k = 0; k < SEGMENTS; k++) {
    const v0 = k * segF;
    const seg = envV.subarray(v0, v0 + segF);
    const pred = v0 + (off * frameRate) / r;
    const s0 = Math.round(pred) - pad;
    const s1 = s0 + seg.length + 2 * pad;
    if (s0 < 0 || s1 > es.length) continue;
    const corr = xcorrValid(es.subarray(s0, s1), seg);
    if (corr.length < 3) continue;
    let L = 0, best = -Infinity;
    for (let i = 0; i < corr.length; i++) {
      if (corr[i] > best) { best = corr[i]; L = i; }
    }
    let Lf = L;
    if (L > 0 && L < corr.length - 1) {
      const y0 = corr[L - 1], y1 = corr[L], y2 = corr[L + 1];
      const den = y0 - 2 * y1 + y2;
      if (Math.abs(den) > 1e-12) Lf = L + (0.5 * (y0 - y2)) / den;
    }
    const resid = ((s0 + Lf - pred) * r) / frameRate;
    out.push(resid);
  }
  return out;
}

/**
 * Main entry. videoAudio/studioAudio: Float32Array mono at `sr`.
 * Returns { offset0, speedRatio, confidence, nSegments, nAgree, maxResidualMs }.
 */
export function detectAlignment(videoAudio, studioAudio, sr, onProgress) {
  if (onProgress) onProgress("Computing onset envelopes...");
  const envV = onsetEnvelope(videoAudio, sr);
  const envS = onsetEnvelope(studioAudio, sr);
  const frameRate = sr / HOP;

  if (envV.length < 8 || envS.length < 8) {
    return { offset0: 0, speedRatio: 1, confidence: 0,
             nSegments: 0, nAgree: 0, maxResidualMs: 0 };
  }

  const { r, off } = scanSpeed(envV, envS, frameRate, onProgress);

  if (onProgress) onProgress("Verifying alignment across the clip...");
  const resids = segmentOffsets(envV, envS, frameRate, off, r);
  if (resids.length === 0) {
    return { offset0: off, speedRatio: r, confidence: 0.5,
             nSegments: 0, nAgree: 0, maxResidualMs: 0 };
  }
  let agree = 0, maxAbs = 0;
  for (const res of resids) {
    const a = Math.abs(res);
    if (a < SEG_AGREE_SEC) agree++;
    if (a > maxAbs) maxAbs = a;
  }
  return {
    offset0: off,
    speedRatio: r,
    confidence: agree / resids.length,
    nSegments: resids.length,
    nAgree: agree,
    maxResidualMs: maxAbs * 1000,
  };
}

/**
 * Fine pass: GCC-PHAT on raw waveforms around the consensus offset.
 * Only meaningful when no drift stretch will be applied. Searches +/-250 ms.
 */
export function refineOffsetWaveform(videoAudio, studioAudio, sr, coarseOffset,
                                     windowSec = 3.0) {
  const segLen = Math.floor(windowSec * sr);
  const vStart = Math.max(0, Math.floor(videoAudio.length / 2 - segLen / 2));
  const vSeg = videoAudio.subarray(vStart, vStart + segLen);
  const pad = Math.floor(0.25 * sr);
  const sStart = vStart + Math.floor(coarseOffset * sr) - pad;
  const sEnd = sStart + segLen + 2 * pad;
  if (sStart < 0 || sEnd > studioAudio.length || vSeg.length < segLen / 2) {
    return coarseOffset;
  }
  const sSeg = studioAudio.subarray(sStart, sEnd);

  const n = vSeg.length + sSeg.length;
  const size = nextPow2(n);
  const fft = new FFT(size);
  const tv = new Float64Array(size); tv.set(vSeg);
  const ts = new Float64Array(size); ts.set(sSeg);
  const V = fft.createComplexArray();
  const S = fft.createComplexArray();
  fft.realTransform(V, tv); fft.completeSpectrum(V);
  fft.realTransform(S, ts); fft.completeSpectrum(S);
  const R = fft.createComplexArray();
  for (let i = 0; i < size; i++) {
    const ar = V[2 * i], ai = V[2 * i + 1];
    const br = S[2 * i], bi = -S[2 * i + 1]; // conj(S)
    let re = ar * br - ai * bi;
    let im = ar * bi + ai * br;
    const mag = Math.max(Math.hypot(re, im), 1e-12);
    R[2 * i] = re / mag;
    R[2 * i + 1] = im / mag;
  }
  const cc = fft.createComplexArray();
  fft.inverseTransform(cc, R);
  // circular cc: lag L in [-(len(sSeg)-1), len(vSeg)-1]; index = (L + size) % size
  let bestLag = 0, best = -Infinity;
  for (let L = -(sSeg.length - 1); L < vSeg.length; L++) {
    const idx = ((L % size) + size) % size;
    const v = cc[2 * idx];
    if (v > best) { best = v; bestLag = L; }
  }
  const refined = (sStart - vStart - bestLag) / sr;
  if (Math.abs(refined - coarseOffset) > 0.25) return coarseOffset;
  return refined;
}
