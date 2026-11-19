// Remote camera: use a second phone as the camera (or as a wireless shutter) over WebRTC.
// No server is needed: the two devices swap short connection codes (copy/paste or share).
const ICE = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

async function pack(desc) {
  const json = JSON.stringify({ t: desc.type, s: desc.sdp });
  if (self.CompressionStream) {
    const buf = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
    return 'FL1' + btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return 'FL0' + btoa(unescape(encodeURIComponent(json)));
}
async function unpack(code) {
  code = code.trim().replace(/\s+/g, '');
  const kind = code.slice(0, 3), body = code.slice(3);
  let json;
  if (kind === 'FL1') {
    const b64 = body.replace(/-/g, '+').replace(/_/g, '/');
    const bin = Uint8Array.from(atob(b64 + '==='.slice((b64.length + 3) % 4)), c => c.charCodeAt(0));
    json = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  } else if (kind === 'FL0') json = decodeURIComponent(escape(atob(body)));
  else throw new Error('That code is not a Frameloom connection code.');
  const o = JSON.parse(json);
  return { type: o.t, sdp: o.s };
}
function gathered(pc) {
  return new Promise(res => {
    if (pc.iceGatheringState === 'complete') return res();
    const done = () => { if (pc.iceGatheringState === 'complete') res(); };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(res, 2500);
  });
}

// Runs on the phone that acts as the CAMERA. It sends video and receives shutter commands.
export class RemoteCameraSide {
  constructor({ onCommand, onState }) { this.onCommand = onCommand; this.onState = onState; }
  async createOffer(stream) {
    this.pc = new RTCPeerConnection({ iceServers: ICE });
    stream.getTracks().forEach(t => this.pc.addTrack(t, stream));
    this.dc = this.pc.createDataChannel('ctl');
    this.dc.onmessage = e => this.onCommand?.(JSON.parse(e.data));
    this.pc.onconnectionstatechange = () => this.onState?.(this.pc.connectionState);
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await gathered(this.pc);
    return pack(this.pc.localDescription);
  }
  async acceptAnswer(code) { await this.pc.setRemoteDescription(await unpack(code)); }
  send(msg) { if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(msg)); }
  close() { try { this.pc?.close(); } catch (e) { } }
}

// Runs on the STUDIO phone. It receives the video and can trigger capture.
export class RemoteStudioSide {
  constructor({ onStream, onState, onCommand }) { this.onStream = onStream; this.onState = onState; this.onCommand = onCommand; }
  async answer(offerCode) {
    this.pc = new RTCPeerConnection({ iceServers: ICE });
    this.pc.ontrack = e => this.onStream?.(e.streams[0] || new MediaStream([e.track]));
    this.pc.ondatachannel = e => { this.dc = e.channel; this.dc.onmessage = m => this.onCommand?.(JSON.parse(m.data)); };
    this.pc.onconnectionstatechange = () => this.onState?.(this.pc.connectionState);
    await this.pc.setRemoteDescription(await unpack(offerCode));
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await gathered(this.pc);
    return pack(this.pc.localDescription);
  }
  send(msg) { if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(msg)); }
  close() { try { this.pc?.close(); } catch (e) { } }
}
