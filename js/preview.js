/**
 * Real-time synced preview.
 *
 * The <video> element plays the footage (its own live audio audible only in
 * balance mode, at the live weight); the studio track plays through Web
 * Audio, scheduled so that at video time t the studio buffer is at
 *
 *     s(t) = effectiveOffset + r * t
 *
 * playbackRate = r keeps the preview locked during tempo drift. (Note: rate
 * changes shift pitch slightly in preview -- ~1% is barely audible; the
 * EXPORT uses ffmpeg's pitch-preserving atempo instead.)
 *
 * Nudge and balance are live: balance only touches gain nodes (instant);
 * nudge restarts the studio source at the corrected position (tiny
 * click, debounced). A watchdog resyncs if the video and audio clocks
 * drift apart by more than 40 ms, e.g. after the video stalls to buffer.
 */

export class PreviewEngine {
  constructor(videoEl) {
    this.video = videoEl;
    this.ctx = null;
    this.gain = null;
    this.source = null;        // current AudioBufferSourceNode
    this.studioBuffer = null;  // native-rate AudioBuffer
    this.analysis = null;
    this.nudgeMs = 0;
    this.mode = "replace";     // "replace" | "balance"
    this.livePct = 50;
    this._startCtxTime = 0;    // ctx.currentTime when source started
    this._startPos = 0;        // studio position at that moment
    this._watchdog = null;
    this._nudgeTimer = null;

    this.video.addEventListener("play", () => this._startAudio());
    this.video.addEventListener("pause", () => this._stopAudio());
    this.video.addEventListener("seeked", () => {
      if (!this.video.paused) this._startAudio();
    });
    this.video.addEventListener("ended", () => this._stopAudio());
  }

  configure(studioBuffer, analysis) {
    this.studioBuffer = studioBuffer;
    this.analysis = analysis;
    this._applyVolumes();
  }

  setMode(mode, livePct) {
    this.mode = mode;
    this.livePct = livePct;
    this._applyVolumes();
  }

  setNudge(nudgeMs) {
    this.nudgeMs = nudgeMs;
    if (!this.video.paused) {
      clearTimeout(this._nudgeTimer);
      this._nudgeTimer = setTimeout(() => this._startAudio(), 150);
    }
  }

  effectiveOffset() {
    return this.analysis.offset0 - this.nudgeMs / 1000;
  }

  _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
  }

  _applyVolumes() {
    const wLive = this.mode === "balance" ? this.livePct / 100 : 0;
    const wStudio = this.mode === "balance" ? 1 - wLive : 1;
    this.video.muted = this.mode === "replace";
    this.video.volume = Math.max(0, Math.min(1, wLive));
    if (this.gain) this.gain.gain.value = wStudio;
  }

  _startAudio() {
    if (!this.analysis || !this.studioBuffer) return;
    this._ensureCtx();
    this._applyVolumes();
    this._stopSource();

    const r = this.analysis.speedRatio;
    const s = this.effectiveOffset() + r * this.video.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.studioBuffer;
    src.playbackRate.value = r;
    src.connect(this.gain);

    const now = this.ctx.currentTime;
    if (s >= 0) {
      if (s < this.studioBuffer.duration) src.start(now, s);
      this._startCtxTime = now;
      this._startPos = s;
    } else {
      // video begins before the song: start the buffer in the future
      const delay = -s / r;
      src.start(now + delay, 0);
      this._startCtxTime = now;
      this._startPos = s; // virtual (negative) position advances at rate r
    }
    this.source = src;

    clearInterval(this._watchdog);
    this._watchdog = setInterval(() => this._checkSync(), 750);
  }

  _checkSync() {
    if (!this.source || this.video.paused) return;
    const r = this.analysis.speedRatio;
    const actual = this._startPos + (this.ctx.currentTime - this._startCtxTime) * r;
    const expected = this.effectiveOffset() + r * this.video.currentTime;
    if (Math.abs(actual - expected) > 0.04) this._startAudio();
  }

  _stopSource() {
    if (this.source) {
      try { this.source.stop(); } catch (_) { /* already stopped */ }
      this.source.disconnect();
      this.source = null;
    }
  }

  _stopAudio() {
    clearInterval(this._watchdog);
    this._watchdog = null;
    this._stopSource();
  }
}
