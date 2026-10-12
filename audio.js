/**
 * UniAmbi audio playback.
 * FOA is AmbiX: ACN channel order W,Y,Z,X with SN3D normalization.
 * WAV samples are read directly so browser speaker-layout conversions cannot
 * reorder or downmix the four spherical-harmonic components.
 */

const CHANNELS = {foa: 4, stereo: 2, mono: 1};
const OUTPUT_HEADROOM = 0.5;

function validateChannels(buffer, kind) {
  if (!(kind in CHANNELS)) throw new Error(`Unknown audio format: ${kind}`);
  if (buffer.numberOfChannels !== CHANNELS[kind]) {
    throw new Error(`${kind.toUpperCase()} requires ${CHANNELS[kind]} channels; this file has ${buffer.numberOfChannels}.`);
  }
  return buffer;
}

function fourCC(view, offset) {
  return String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, 4));
}

/** Decode PCM / IEEE-float RIFF WAV without interpreting speaker masks. */
export function decodeWave(context, bytes) {
  const view = new DataView(bytes);
  if (view.byteLength < 12 || fourCC(view, 0) !== 'RIFF' || fourCC(view, 8) !== 'WAVE') {
    throw new Error('Not a supported RIFF/WAVE file.');
  }
  let format;
  let data;
  const declaredEnd = view.getUint32(4, true) + 8;
  if (declaredEnd > view.byteLength) throw new Error('The WAV file is incomplete.');
  const end = Math.min(declaredEnd, view.byteLength);
  for (let offset = 12; offset + 8 <= end;) {
    const id = fourCC(view, offset);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > end) throw new Error(`Incomplete WAV ${id} chunk.`);
    if (id === 'fmt ') {
      if (length < 16) throw new Error('Invalid WAV format header.');
      let encoding = view.getUint16(start, true);
      const channels = view.getUint16(start + 2, true);
      const sampleRate = view.getUint32(start + 4, true);
      const blockAlign = view.getUint16(start + 12, true);
      const bits = view.getUint16(start + 14, true);
      if (encoding === 0xfffe) {
        if (length < 40 || view.getUint16(start + 16, true) < 22) {
          throw new Error('Invalid extensible WAV format header.');
        }
        // WAVE_FORMAT_EXTENSIBLE subformat GUID; preserve file channel order.
        const suffix = [0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
        if (!suffix.every((value, index) => view.getUint8(start + 28 + index) === value)) {
          throw new Error('Unsupported extensible WAV subformat.');
        }
        encoding = view.getUint32(start + 24, true);
      }
      format = {encoding, channels, sampleRate, blockAlign, bits};
    } else if (id === 'data' && !data) {
      data = {start, length};
    }
    // RIFF chunks are word-aligned, including unknown metadata chunks.
    offset = start + length + (length % 2);
  }
  if (!format || !data) throw new Error('WAV format or sample data is missing.');
  const {encoding, channels, sampleRate, blockAlign, bits} = format;
  if (!channels || channels > 32 || !sampleRate || !data.length) {
    throw new Error('Invalid WAV channel count, sample rate, or duration.');
  }
  if (!(encoding === 1 && [8, 16, 24, 32].includes(bits)) &&
      !(encoding === 3 && [32, 64].includes(bits))) {
    throw new Error(`Unsupported WAV encoding ${encoding}, ${bits}-bit.`);
  }
  const sampleBytes = bits / 8;
  if (blockAlign !== channels * sampleBytes || data.length % blockAlign !== 0) {
    throw new Error('Invalid WAV sample alignment.');
  }
  const frames = data.length / blockAlign;
  const buffer = context.createBuffer(channels, frames, sampleRate);
  for (let channel = 0; channel < channels; channel++) {
    const output = buffer.getChannelData(channel);
    for (let frame = 0; frame < frames; frame++) {
      const at = data.start + frame * blockAlign + channel * sampleBytes;
      let value;
      if (encoding === 3) {
        value = bits === 32 ? view.getFloat32(at, true) : view.getFloat64(at, true);
      } else if (bits === 8) {
        value = (view.getUint8(at) - 128) / 128;
      } else if (bits === 16) {
        value = view.getInt16(at, true) / 32768;
      } else if (bits === 24) {
        let sample = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
        if (sample & 0x800000) sample -= 0x1000000;
        value = sample / 8388608;
      } else {
        value = view.getInt32(at, true) / 2147483648;
      }
      if (!Number.isFinite(value)) throw new Error('The WAV file contains non-finite samples.');
      output[frame] = value;
    }
  }
  return buffer;
}

/**
 * Inverse of a camera's Ry(yaw) * Rx(pitch), column-major.
 * Degrees: positive yaw looks left; positive pitch looks up.
 * Omnitone converts its ACN [-Y,Z,-X] basis internally. Do not flip channels.
 */
export function listenerRotation(yaw, pitch) {
  const y = yaw * Math.PI / 180;
  const p = pitch * Math.PI / 180;
  const cy = Math.cos(y), sy = Math.sin(y);
  const cp = Math.cos(p), sp = Math.sin(p);
  return new Float32Array([
    cy, sp * sy, cp * sy,
    0, cp, -sp,
    -sy, sp * cy, cp * cy,
  ]);
}

export class AudioEngine {
  constructor() {
    this.context = null;
    this.renderer = null;
    this.output = null;
    this._initialization = null;
    this._cache = new Map();
    this._pending = new Map();
    this._source = null;
    this._buffer = null;
    this._kind = null;
    this._offset = 0;
    this._startedAt = 0;
    this._request = 0;
    this._volume = 0.8;
    this._yaw = 0;
    this._pitch = 0;
  }

  async init() {
    if (!this.context) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error('This browser does not support Web Audio.');
      if (!window.Omnitone) throw new Error('The local Omnitone decoder could not be loaded.');
      this.context = new AudioContext();
      this.output = this.context.createGain();
      this.output.gain.value = OUTPUT_HEADROOM * this._volume;
      this.output.connect(this.context.destination);
      this.renderer = window.Omnitone.createFOARenderer(this.context, {
        channelMap: [0, 1, 2, 3],
        renderingMode: 'ambisonic',
      });
      this.renderer.input.channelCount = 4;
      this.renderer.input.channelCountMode = 'explicit';
      this.renderer.input.channelInterpretation = 'discrete';
      this.renderer.output.connect(this.output);
    }
    // Call resume synchronously in the Play click, before a fetch or await.
    const resume = this.context.state !== 'running' ? this.context.resume() : Promise.resolve();
    if (!this._initialization) {
      this._initialization = this.renderer.initialize().then(() => {
        this.setOrientation(this._yaw, this._pitch);
      }).catch(error => {
        this._initialization = null;
        throw error;
      });
    }
    await Promise.all([resume, this._initialization]);
  }

  async load(url, kind) {
    if (!(kind in CHANNELS)) throw new Error(`Unknown audio format: ${kind}`);
    await this.init();
    const key = `${kind}:${url}`;
    if (this._cache.has(key)) {
      const buffer = this._cache.get(key);
      this._cache.delete(key);
      this._cache.set(key, buffer);
      return buffer;
    }
    if (this._pending.has(key)) return this._pending.get(key);
    const request = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Audio could not be loaded (HTTP ${response.status}).`);
      const bytes = await response.arrayBuffer();
      const header = new DataView(bytes);
      const isWave = bytes.byteLength >= 12 && fourCC(header, 0) === 'RIFF' && fourCC(header, 8) === 'WAVE';
      const buffer = validateChannels(isWave
        ? decodeWave(this.context, bytes)
        : await this.context.decodeAudioData(bytes), kind);
      this._cache.set(key, buffer);
      while (this._cache.size > 8) this._cache.delete(this._cache.keys().next().value);
      return buffer;
    })();
    this._pending.set(key, request);
    try {
      return await request;
    } finally {
      this._pending.delete(key);
    }
  }

  async play(buffer, kind, offset = 0, onEnded) {
    validateChannels(buffer, kind);
    const request = ++this._request;
    await this.init();
    if (request !== this._request) return false;
    this._disconnectSource();
    this._buffer = buffer;
    this._kind = kind;
    this._offset = Math.max(0, Math.min(Number(offset) || 0, buffer.duration));
    if (this._offset >= buffer.duration) this._offset = 0;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    // Four components travel intact into the FOA decoder. A mono/stereo track
    // is already a listening signal and goes directly to the common gain.
    source.channelInterpretation = kind === 'foa' ? 'discrete' : 'speakers';
    source.connect(kind === 'foa' ? this.renderer.input : this.output);
    source.onended = () => {
      if (this._source !== source) return;
      source.disconnect();
      this._source = null;
      this._offset = buffer.duration;
      if (onEnded) onEnded();
    };
    this._startedAt = this.context.currentTime;
    this._source = source;
    source.start(0, this._offset);
    return true;
  }

  _disconnectSource() {
    if (!this._source) return;
    this._source.onended = null;
    this._source.stop();
    this._source.disconnect();
    this._source = null;
  }

  pause() {
    ++this._request;
    this._offset = this.position;
    this._disconnectSource();
    return this._offset;
  }

  stop() {
    ++this._request;
    this._disconnectSource();
    this._offset = 0;
    this._buffer = null;
    this._kind = null;
  }

  get position() {
    if (!this._buffer) return 0;
    return Math.min(this._buffer.duration, this._offset + (this._source ? this.context.currentTime - this._startedAt : 0));
  }

  get playing() {
    return Boolean(this._source);
  }

  setOrientation(yaw, pitch = 0) {
    this._yaw = Number.isFinite(Number(yaw)) ? Number(yaw) : 0;
    this._pitch = Math.max(-90, Math.min(90, Number(pitch) || 0));
    if (this.renderer) this.renderer.setRotationMatrix3(listenerRotation(this._yaw, this._pitch));
  }

  setVolume(value) {
    this._volume = Math.max(0, Math.min(1, Number(value) || 0));
    if (this.output) this.output.gain.setTargetAtTime(OUTPUT_HEADROOM * this._volume, this.context.currentTime, 0.015);
  }
}
