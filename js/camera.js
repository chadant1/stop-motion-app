// Camera: device selection, resolution, and manual controls (focus, exposure, white balance, ISO, zoom, torch).
export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.devices = [];
    this.deviceId = null;
    this.facing = 'environment';
    this.resolution = 1080;
    this.remote = false; // when true, video is fed by a remote peer
  }

  get ready() { return !!(this.video.videoWidth && (this.stream || this.remote)); }

  async listDevices() {
    try { this.devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput'); } catch (e) { this.devices = []; }
    return this.devices;
  }

  async start(opts = {}) {
    this.stop();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser has no camera access. Open the app over https (or install it) to use the camera.');
    if (opts.deviceId !== undefined) this.deviceId = opts.deviceId;
    if (opts.resolution) this.resolution = opts.resolution;
    const longSide = { 480: 640, 720: 1280, 1080: 1920, 1440: 2560, 2160: 3840 }[this.resolution] || 1920;
    const shortSide = Math.round(longSide * 9 / 16);
    const video = { width: { ideal: longSide }, height: { ideal: shortSide } };
    if (this.deviceId) video.deviceId = { exact: this.deviceId }; else video.facingMode = { ideal: this.facing };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      if (e.name === 'OverconstrainedError') this.stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      else throw e;
    }
    this.remote = false;
    this.track = this.stream.getVideoTracks()[0];
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => { });
    await new Promise(r => { if (this.video.videoWidth) r(); else this.video.onloadedmetadata = () => r(); setTimeout(r, 3000); });
    const s = this.track.getSettings ? this.track.getSettings() : {};
    if (s.deviceId) this.deviceId = s.deviceId;
    if (s.facingMode) this.facing = s.facingMode;
    await this.listDevices();
    return this;
  }

  useRemoteStream(stream) {
    this.stop();
    this.remote = true;
    this.stream = stream;
    this.track = stream.getVideoTracks()[0] || null;
    this.video.srcObject = stream;
    this.video.play().catch(() => { });
  }

  stop() {
    if (this.stream && !this.remote) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null; this.track = null;
    this.video.srcObject = null;
  }

  async switchCamera() {
    await this.listDevices();
    if (this.devices.length > 1 && this.deviceId) {
      const i = this.devices.findIndex(d => d.deviceId === this.deviceId);
      const next = this.devices[(i + 1) % this.devices.length];
      return this.start({ deviceId: next.deviceId });
    }
    this.facing = this.facing === 'environment' ? 'user' : 'environment';
    this.deviceId = null;
    return this.start({ deviceId: null });
  }

  capabilities() {
    if (!this.track || !this.track.getCapabilities) return {};
    try { return this.track.getCapabilities() || {}; } catch (e) { return {}; }
  }
  settings() { try { return this.track?.getSettings?.() || {}; } catch (e) { return {}; } }

  async apply(constraints) {
    if (!this.track) return false;
    try { await this.track.applyConstraints({ advanced: [constraints] }); return true; }
    catch (e) { try { await this.track.applyConstraints(constraints); return true; } catch (e2) { console.warn('constraint failed', constraints, e2); return false; } }
  }

  // Lock focus, exposure and white balance at their current values (stops flicker between frames).
  async lockAll(lock) {
    const c = this.capabilities(), out = {};
    const mode = lock ? 'manual' : 'continuous';
    if (c.focusMode?.includes(mode)) out.focusMode = mode;
    if (c.exposureMode?.includes(mode)) out.exposureMode = mode;
    if (c.whiteBalanceMode?.includes(mode)) out.whiteBalanceMode = mode;
    if (!Object.keys(out).length) return false;
    return this.apply(out);
  }

  // Grab the current live picture, cropped to the movie's aspect ratio.
  grab(targetW, targetH, mirror = false) {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw) return null;
    const ar = targetW / targetH;
    let sw = vw, sh = vw / ar;
    if (sh > vh) { sh = vh; sw = vh * ar; }
    const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
    // keep native resolution if it's smaller than the target, never upscale
    const scale = Math.min(1, targetW / sw);
    const c = document.createElement('canvas');
    c.width = Math.round(sw * scale) & ~1; c.height = Math.round(sh * scale) & ~1;
    const x = c.getContext('2d');
    if (mirror) { x.translate(c.width, 0); x.scale(-1, 1); }
    x.drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c;
  }
}
