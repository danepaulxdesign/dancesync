/**
 * Onset-strength envelope (mel spectral flux) — JS port of core/dsp.py.
 *
 * STFT -> mel power spectrogram -> dB -> per-band first difference ->
 * half-wave rectify -> mean over bands. Pure math; runs in browser and Node.
 */

import FFT from "../vendor/fft.mjs";

export const N_FFT = 2048;
export const N_MELS = 128;
export const HOP = 512;

const hzToMel = (f) => 2595.0 * Math.log10(1.0 + f / 700.0);
const melToHz = (m) => 700.0 * (Math.pow(10.0, m / 2595.0) - 1.0);

/** Triangular mel filterbank as a flat Float32Array (nMels x nBins). */
export function melFilterbank(sr, nFft = N_FFT, nMels = N_MELS) {
  const nBins = nFft / 2 + 1;
  const fmax = sr / 2.0;
  const melPts = new Float64Array(nMels + 2);
  const melLo = hzToMel(0.0), melHi = hzToMel(fmax);
  for (let i = 0; i < nMels + 2; i++) {
    melPts[i] = melToHz(melLo + ((melHi - melLo) * i) / (nMels + 1));
  }
  const fb = new Float32Array(nMels * nBins);
  for (let m = 0; m < nMels; m++) {
    const fLo = melPts[m], fC = melPts[m + 1], fHi = melPts[m + 2];
    // Slaney-style normalization: equal energy per band
    const norm = 2.0 / Math.max(fHi - fLo, 1e-9);
    for (let b = 0; b < nBins; b++) {
      const freq = (b * sr) / nFft;
      const rise = (freq - fLo) / Math.max(fC - fLo, 1e-9);
      const fall = (fHi - freq) / Math.max(fHi - fC, 1e-9);
      const v = Math.min(rise, fall);
      fb[m * nBins + b] = v > 0 ? v * norm : 0;
    }
  }
  return fb;
}

/**
 * Spectral-flux onset envelope, one value per `hop` samples.
 * y: Float32Array mono audio at sample rate sr.
 */
export function onsetStrength(y, sr, hop = HOP) {
  const nFft = N_FFT;
  const nBins = nFft / 2 + 1;
  const pad = nFft / 2;

  // zero-pad for centered frames (matches np.pad mode="constant")
  const yp = new Float32Array(y.length + 2 * pad);
  yp.set(y, pad);

  const nFrames = 1 + Math.max(0, Math.floor((yp.length - nFft) / hop));

  // periodic Hann window
  const win = new Float32Array(nFft);
  for (let i = 0; i < nFft; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nFft);
  }

  const fft = new FFT(nFft);
  const input = new Float64Array(nFft);
  const out = fft.createComplexArray();
  const fb = melFilterbank(sr, nFft);

  // log-mel spectrogram, frame-major (nFrames x N_MELS)
  const logMel = new Float32Array(nFrames * N_MELS);
  const power = new Float64Array(nBins);
  let globalMax = -Infinity;

  for (let f = 0; f < nFrames; f++) {
    const start = f * hop;
    for (let i = 0; i < nFft; i++) input[i] = yp[start + i] * win[i];
    fft.realTransform(out, input);
    fft.completeSpectrum(out);
    for (let b = 0; b < nBins; b++) {
      const re = out[2 * b], im = out[2 * b + 1];
      power[b] = re * re + im * im;
    }
    for (let m = 0; m < N_MELS; m++) {
      let acc = 0;
      const row = m * nBins;
      for (let b = 0; b < nBins; b++) acc += power[b] * fb[row + b];
      const db = 10.0 * Math.log10(Math.max(acc, 1e-10));
      logMel[f * N_MELS + m] = db;
      if (db > globalMax) globalMax = db;
    }
  }

  // clamp dynamic range (top_db = 80) relative to global max
  const floor = globalMax - 80.0;
  for (let i = 0; i < logMel.length; i++) {
    if (logMel[i] < floor) logMel[i] = floor;
  }

  // rectified first difference, mean over bands; prepend 0
  const env = new Float32Array(nFrames);
  for (let f = 1; f < nFrames; f++) {
    let acc = 0;
    for (let m = 0; m < N_MELS; m++) {
      const d = logMel[f * N_MELS + m] - logMel[(f - 1) * N_MELS + m];
      if (d > 0) acc += d;
    }
    env[f] = acc / N_MELS;
  }
  return env;
}
