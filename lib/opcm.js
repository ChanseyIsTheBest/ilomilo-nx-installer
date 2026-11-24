// ilomilo-nx-installer (2026-11-25): banjo-nx-installer's lib/opcm.js (credit it), for ilomilo's all-PCM XACT 3 bank
// Data/sound/Xbox/startup.xwb (game.json "opcm"; lib/media.js's kind 'opcm'). Unchanged but the encoder argument.
// From rr6-nx-installer (credit it; and culdcept-nx-installer's lib/audio.js before it); renut-nx-webinstaller
// (2026-11-21) adds Nuts & Bolts' XACT wave banks (regionsXwb).
// rr6-nx-installer (2026-11-21, the user: "rencoding audio as opus and videos as h.265 copy what culdcept saga does"):
// a game file whose music is 16-bit PCM written as NAME.opcm (rr6-nx's sdk/include/rex/filesystem/opus_pcm.h has the
// format; tools/opus_pcm_pack.py makes the same with ffmpeg's libopus): pack_bgm.bin (20 RIFF WAVE tracks back to back)
// or a DLC music pack (an Xbox 360 package holding one WAV). Every byte outside the samples is kept; the samples are
// resampled to 48 kHz by the windowed-sinc filter the port resamples back with and encoded by the browser's Opus encoder
// (WebCodecs' AudioEncoder), 20 ms packets. As culdcept-nx-installer's lib/audio.js does for XMA (credit culdcept-nx).
const MAGIC = 'RXOPCM01';
const OPUS_RATE = 48000;
const FRAME = 960;
const HALF = 32;
const TAPS = 2 * HALF;
const BETA = 8.0;
const BLOCK = 4096;
const OPUS_LOOKAHEAD = 312;  // libopus's at 48 kHz: the pre-skip when the encoder gives no OpusHead

// ---- the filter (the port's, sdk/src/filesystem/opus_pcm.cpp; the tool's, tools/opus_pcm_pack.py) -------------------

function besselI0(x) {
  let sum = 1, term = 1;
  for (let k = 1; k < 64; k++) {
    term *= (x / (2 * k)) * (x / (2 * k));
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }

// Output n of dst from src sits at input n * M / L; h[phase * TAPS + k] for the inputs floor(n * M / L) - HALF + 1 + k.
export function filterBank(src, dst) {
  const g = gcd(src, dst), L = dst / g, M = src / g;
  const fc = 0.5 * Math.min(src, dst) / src * 0.97;
  const i0b = besselI0(BETA);
  const h = new Float32Array(L * TAPS);
  for (let ph = 0; ph < L; ph++) {
    const frac = ph / L;
    const row = new Float64Array(TAPS);
    let sum = 0;
    for (let k = 0; k < TAPS; k++) {
      const t = k - HALF + 1 - frac;
      const x = 2 * fc * t;
      const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const r = t / HALF;
      const w = Math.abs(r) >= 1 ? 0 : besselI0(BETA * Math.sqrt(1 - r * r)) / i0b;
      row[k] = 2 * fc * sinc * w;
      sum += row[k];
    }
    for (let k = 0; k < TAPS; k++) h[ph * TAPS + k] = row[k] / sum;
  }
  return { L, M, h };
}

// The whole of `x` (interleaved, `ch` channels, `src` Hz) at `dst` Hz, ceil(frames * dst / src) frames.
export function resample(x, ch, src, dst) {
  const n_in = x.length / ch;
  if (src === dst) return x.slice();
  const { L, M, h } = filterBank(src, dst);
  const n_out = Math.ceil(n_in * L / M);
  const out = new Float32Array(n_out * ch);
  for (let n = 0; n < n_out; n++) {
    const q = n * M;
    const i = Math.floor(q / L);
    const base = (q % L) * TAPS;
    const j0 = i - HALF + 1;
    for (let c = 0; c < ch; c++) {
      let acc = 0;
      for (let k = 0; k < TAPS; k++) {
        const j = j0 + k;
        if (j >= 0 && j < n_in) acc += h[base + k] * x[j * ch + c];
      }
      out[n * ch + c] = acc;
    }
  }
  return out;
}

// ---- finding the PCM ---------------------------------------------------------------------------------------------

const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const le16 = (b, o) => b[o] | (b[o + 1] << 8);
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const str = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

// A RIFF WAVE read through read(offset, n): { fmt, off, len } of its data chunk, or null.
function wavData(read, length) {
  const h = read(0, 12);
  if (str(h, 0, 4) !== 'RIFF' || str(h, 8, 4) !== 'WAVE') return null;
  const end = Math.min(length, 8 + le32(h, 4));
  let pos = 12, fmt = null;
  while (pos + 8 <= end) {
    const c = read(pos, 8);
    const id = str(c, 0, 4), cl = le32(c, 4);
    if (id === 'fmt ') {
      const f = read(pos + 8, 16);
      fmt = { tag: le16(f, 0), channels: le16(f, 2), rate: le32(f, 4), bits: le16(f, 14) };
    } else if (id === 'data') {
      return { fmt, off: pos + 8, len: Math.min(cl, length - pos - 8) };
    }
    pos += 8 + cl + (cl & 1);
  }
  return null;
}

const pcmOk = (f) => f && f.tag === 1 && f.bits === 16 && (f.channels === 1 || f.channels === 2);

// Whether 16-bit PCM bytes read smoother big-endian.
function guessBig(b) {
  const n = Math.min(b.length, 1 << 22) & ~3;
  let le = 0, be = 0, lev = 0, beLev = 0;
  for (let i = 4; i < n; i += 28) {
    const a = (b[i] | (b[i + 1] << 8)) << 16 >> 16, p = (b[i - 4] | (b[i - 3] << 8)) << 16 >> 16;
    const a2 = ((b[i] << 8) | b[i + 1]) << 16 >> 16, p2 = ((b[i - 4] << 8) | b[i - 3]) << 16 >> 16;
    le += Math.abs(a - p); lev += Math.abs(a);
    be += Math.abs(a2 - p2); beLev += Math.abs(a2);
  }
  // ilomilo-nx-installer (2026-11-25): the raw steps decide (the base's docs/media-compression.md: read the right way,
  // real audio steps a few hundred to about 2,100; the wrong way about 21,600-22,400). The steps divided by the levels
  // took ilomilo's startup.xwb entry 8 (stereo, 2.98 MB, big-endian like the rest of the bank: steps 503 against
  // 21,826) for little-endian, which would have made its Opus from noise.
  void beLev; void lev;
  return be < le;
}

function regionsRiff(d) {
  const out = [];
  let pos = 0, k = 0;
  while (pos + 12 <= d.length && str(d, pos, 4) === 'RIFF') {
    const size = 8 + le32(d, pos + 4);
    const read = (o, n) => d.subarray(pos + o, pos + o + n);
    const w = wavData(read, d.length - pos);
    if (w && pcmOk(w.fmt)) {
      out.push({ name: `track ${k}`, channels: w.fmt.channels, rate: w.fmt.rate,
                 big: guessBig(d.subarray(pos + w.off, pos + w.off + w.len)), ranges: [[pos + w.off, w.len]] });
    }
    let nxt = pos + size;
    // the next RIFF (each starts at a 2 KB boundary; the bytes between are zero)
    let found = -1;
    for (let p = nxt; p + 4 <= d.length && p < nxt + 65536; p++) {
      if (d[p] === 0x52 && d[p + 1] === 0x49 && d[p + 2] === 0x46 && d[p + 3] === 0x46) { found = p; break; }
    }
    if (found < 0) break;
    pos = found;
    k++;
  }
  return out;
}

function stfsFiles(d) {
  const headerSize = be32(d, 0x340);
  const vd = 0x379;
  const readOnly = d[vd + 2] & 1;
  const bpht = readOnly ? 1 : 2;
  const ftCount = le16(d, vd + 3);
  const ftStart = d[vd + 5] | (d[vd + 6] << 8) | (d[vd + 7] << 16);
  const base = Math.ceil(headerSize / BLOCK) * BLOCK;
  const b2o = (bi) => {
    let b = bi, n = 170;
    for (let i = 0; i < 3; i++) {
      b += Math.floor((bi + n) / n) * bpht;
      if (bi < n) break;
      n *= 170;
    }
    return base + b * BLOCK;
  };
  const files = [];
  for (let t = 0; t < ftCount; t++) {
    const o = b2o(ftStart + t);
    for (let k = 0; k < BLOCK / 0x40; k++) {
      const e = o + k * 0x40;
      if (d[e] === 0) break;
      const fl = d[e + 0x28];
      if (fl & 0x80) continue;
      if (!(fl & 0x40)) throw new Error('a package file whose blocks are not contiguous (not handled)');
      const start = d[e + 0x2F] | (d[e + 0x30] << 8) | (d[e + 0x31] << 16);
      const length = be32(d, e + 0x34);
      const runs = [];
      let left = length, b = start;
      while (left > 0) {
        const n = Math.min(BLOCK, left), off = b2o(b);
        const last = runs[runs.length - 1];
        if (last && last[0] + last[1] === off) last[1] += n; else runs.push([off, n]);
        left -= n;
        b++;
      }
      files.push({ name: str(d, e, fl & 0x3F), runs, length });
    }
  }
  return { files, headerCut: base };
}

function subRuns(runs, start, length) {
  const out = [];
  let pos = 0;
  for (const [off, ln] of runs) {
    const a = Math.max(start, pos), b = Math.min(start + length, pos + ln);
    if (a < b) out.push([off + a - pos, b - a]);
    pos += ln;
  }
  return out;
}

function readRuns(d, runs) {
  return (o, n) => {
    const out = new Uint8Array(n);
    let pos = 0, at = 0;
    for (const [off, ln] of runs) {
      if (o < pos + ln && o + n > pos) {
        const a = Math.max(o, pos) - pos, b = Math.min(o + n, pos + ln) - pos;
        out.set(d.subarray(off + a, off + b), at);
        at += b - a;
      }
      pos += ln;
    }
    return out;
  };
}

// { regions, headerCut } of a file's bytes: headerCut (a package) the bytes the port keeps beside P.opcm.
// renut-nx-webinstaller (2026-11-21, the user: "re-encode all the audio"): Banjo-Kazooie: Nuts & Bolts keeps its music
// in XACT wave banks (XACT 3, version 43, the Xbox 360's: big-endian, signature 'DNBW'), 420 of them back to back in
// Bundle/50/685374, each with a 24-byte entry a sound: flags and duration, the format word, the play region (offset in
// the bank's wave data, length) and the loop region. The format word, read big-endian, keeps the PC's bit order (low bits
// first: tag 2 bits (0 PCM, 1 XMA, 2 ADPCM), channels 3, rate 18, block align 8, bits 1 (1: 16-bit)); checked on the
// disc: the XMA entries' lengths are whole 2048-byte packets, the 16-bit PCM is big-endian (its neighbouring samples
// step by a few hundred read big-endian, ~21,600 little-endian). Its PCM is the music: 15 stereo 44.1 kHz sounds,
// 507 MB. The XMA sounds stay as they are.
function regionsXwb(d) {
  const out = [];
  // the banks lie inside the bundle file (Bundle/50/685374 is a 43 8C B4 7C bundle; its first bank at byte 97,148), not
  // aligned: each 'DNBW' taken when its header holds (XACT 3 versions 42-46, its five regions inside the file)
  for (let at = d.indexOf(0x44); at >= 0 && at + 64 <= d.length; at = d.indexOf(0x44, at + 1)) {
    if (!(d[at + 1] === 0x4e && d[at + 2] === 0x42 && d[at + 3] === 0x57)) continue;
    const base = at;
    const version = be32(d, base + 4);
    if (version < 42 || version > 46) continue;
    const seg = (k) => [be32(d, base + 12 + 8 * k), be32(d, base + 16 + 8 * k)];
    const regions = [0, 1, 4].map(seg);
    if (regions.some(([o, n]) => base + o + n > d.length)) continue;
    const [[bankData], [meta, metaLen], [wave, waveLen]] = regions;
    const count = be32(d, base + bankData + 4);
    const metaSize = be32(d, base + bankData + 72);
    if (metaSize !== 24 || count * 24 > metaLen) continue;
    const name = str(d, base + bankData + 8, 64).replace(/\u0000.*$/s, '');
    for (let i = 0; i < count; i++) {
      const e = base + meta + 24 * i;
      const w = be32(d, e + 4), off = be32(d, e + 8), len = be32(d, e + 12);
      const tag = w & 3, channels = (w >>> 2) & 7, rate = (w >>> 5) & 0x3ffff, bits16 = (w >>> 31) & 1;
      if (tag !== 0 || !bits16 || (channels !== 1 && channels !== 2) || len < 65536 || off + len > waveLen) continue;
      const start = base + wave + off;
      out.push({ name: `${name} ${i}`, channels, rate, big: guessBig(d.subarray(start, start + Math.min(len, 1 << 22))),
                 ranges: [[start, len - (len % (channels * 2))]] });
    }
    at = base + wave + waveLen - 1;
  }
  return out;
}

export function findRegions(d) {
  const magic = str(d, 0, 4);
  if (magic === 'RIFF') return { regions: regionsRiff(d), headerCut: null };
  // renut-nx-webinstaller: XACT wave banks anywhere in the file (Nuts & Bolts' are inside a bundle)
  if (magic !== 'LIVE' && magic !== 'PIRS' && magic !== 'CON ') {
    const banks = regionsXwb(d);
    if (banks.length) return { regions: banks, headerCut: null };
  }
  if (magic === 'LIVE' || magic === 'PIRS' || magic === 'CON ') {
    const { files, headerCut } = stfsFiles(d);
    const regions = [];
    for (const f of files) {
      const read = readRuns(d, f.runs);
      const w = wavData(read, f.length);
      if (!w || !pcmOk(w.fmt)) continue;
      regions.push({ name: f.name, channels: w.fmt.channels, rate: w.fmt.rate,
                     big: guessBig(read(w.off, Math.min(w.len, 1 << 22))), ranges: subRuns(f.runs, w.off, w.len) });
    }
    return { regions, headerCut };
  }
  return { regions: [], headerCut: null };
}

// The region's samples as interleaved floats, and the bytes of whole frames they are.
function pcmOf(d, r) {
  const total = r.ranges.reduce((s, [, n]) => s + n, 0);
  const fb = r.channels * 2;
  const usable = total - (total % fb);
  const out = new Float32Array(usable / 2);
  let k = 0, left = usable;
  for (const [off, n] of r.ranges) {
    const take = Math.min(n, left);
    for (let i = 0; i + 1 < take; i += 2) {
      const lo = r.big ? d[off + i + 1] : d[off + i], hi = r.big ? d[off + i] : d[off + i + 1];
      out[k++] = (((hi << 8) | lo) << 16 >> 16) / 32768;
    }
    left -= take;
    if (left <= 0) break;
  }
  return { pcm: out, usable };
}

// ---- Opus ---------------------------------------------------------------------------------------------------------

export function opusConfig(channels, bitrate) {
  return {
    codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: channels, bitrate, bitrateMode: 'variable',
    opus: { frameDuration: 20000, complexity: 10, application: 'audio', format: 'opus' },
  };
}

export async function canEncodeOpus() {
  if (typeof AudioEncoder === 'undefined') return false;
  try {
    return !!(await AudioEncoder.isConfigSupported(opusConfig(2, 128000))).supported;
  } catch {
    return false;
  }
}

async function encodeOpus(pcm48, channels, bitrate) {
  const packets = [];
  let preSkip = null, failure = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const d = new Uint8Array(chunk.byteLength);
      chunk.copyTo(d);
      packets.push(d);
      const desc = meta?.decoderConfig?.description;
      if (preSkip === null && desc) {
        const h = desc instanceof ArrayBuffer ? new Uint8Array(desc) : new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength);
        if (h.length >= 12 && str(h, 0, 8) === 'OpusHead') preSkip = h[10] | (h[11] << 8);
      }
    },
    error: (e) => { failure = e; },
  });
  encoder.configure(opusConfig(channels, bitrate));
  const frames = pcm48.length / channels;
  const step = FRAME * 50;  // a second at a time
  let time = 0;
  const feed = (part) => {
    const n = part.length / channels;
    const data = new AudioData({ format: 'f32', sampleRate: OPUS_RATE, numberOfFrames: n, numberOfChannels: channels,
                                 timestamp: Math.round(time * 1e6 / OPUS_RATE), data: part });
    encoder.encode(data);
    data.close();
    time += n;
  };
  try {
    for (let f = 0; f < frames && !failure; f += step) {
      feed(pcm48.subarray(f * channels, Math.min(frames, f + step) * channels));
      while (encoder.encodeQueueSize > 8 && !failure) await new Promise((r) => setTimeout(r, 1));
    }
    feed(new Float32Array(2 * FRAME * channels));  // the encoder's tail covers the last samples
    await encoder.flush();
  } catch (e) {
    failure = failure || e;
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (failure) throw new Error(`the Opus encoder failed: ${failure.message || failure}`);
  return { packets, preSkip: preSkip ?? OPUS_LOOKAHEAD };
}

// ---- the .opcm file -----------------------------------------------------------------------------------------------

function build(d, regions, streams) {
  const size = d.length;
  const pcm = [];
  regions.forEach((r, si) => {
    let pos = 0;
    for (const [off, n] of r.ranges) {
      const take = Math.min(n, streams[si].usable - pos);
      if (take > 0) pcm.push([off, take, si, pos]);
      pos += n;
    }
  });
  pcm.sort((a, b) => a[0] - b[0]);
  const segs = [];
  const stored = [];
  let storedLen = 0, at = 0;
  const addStored = (a, b) => {
    const last = segs[segs.length - 1];
    if (last && last.kind === 0 && last.src + last.len === storedLen) last.len += b - a;
    else segs.push({ off: a, len: b - a, kind: 0, stream: 0, src: storedLen });
    stored.push(d.subarray(a, b));
    storedLen += b - a;
  };
  for (const [off, n, si, src] of pcm) {
    if (off > at) addStored(at, off);
    const last = segs[segs.length - 1];
    if (last && last.kind === 1 && last.stream === si && last.src + last.len === src) last.len += n;
    else segs.push({ off, len: n, kind: 1, stream: si, src });
    at = off + n;
  }
  if (at < size) addStored(at, size);
  const segOff = 64, strOff = segOff + 32 * segs.length, storedOff = strOff + 48 * regions.length;
  let pos = storedOff + storedLen;
  const tails = [];
  const rows = regions.map((r, si) => {
    const { packets, preSkip, frames } = streams[si];
    const sizes = new Uint8Array(2 * packets.length);
    packets.forEach((p, k) => { sizes[2 * k] = p.length & 0xFF; sizes[2 * k + 1] = p.length >> 8; });
    const sizesOff = pos;
    pos += sizes.length;
    const pkOff = pos;
    for (const p of packets) pos += p.length;
    tails.push(sizes, ...packets);
    return { r, preSkip, frames, n: packets.length, sizesOff, pkOff };
  });
  const head = new Uint8Array(storedOff);
  const v = new DataView(head.buffer);
  for (let i = 0; i < 8; i++) head[i] = MAGIC.charCodeAt(i);
  const u64 = (o, x) => { v.setUint32(o, x % 0x100000000, true); v.setUint32(o + 4, Math.floor(x / 0x100000000), true); };
  v.setUint32(8, 1, true);
  v.setUint32(12, regions.length, true);
  u64(16, size);
  v.setUint32(24, segs.length, true);
  u64(32, segOff);
  u64(40, strOff);
  u64(48, storedOff);
  u64(56, storedLen);
  segs.forEach((s, i) => {
    const o = segOff + 32 * i;
    u64(o, s.off);
    u64(o + 8, s.len);
    v.setUint32(o + 16, s.kind, true);
    v.setUint32(o + 20, s.stream, true);
    u64(o + 24, s.src);
  });
  rows.forEach((s, i) => {
    const o = strOff + 48 * i;
    v.setUint16(o, s.r.channels, true);
    v.setUint16(o + 2, 16, true);
    v.setUint32(o + 4, s.r.rate, true);
    v.setUint32(o + 8, s.r.big ? 1 : 0, true);
    v.setUint32(o + 12, s.preSkip, true);
    u64(o + 16, s.frames);
    v.setUint32(o + 24, s.n, true);
    v.setUint32(o + 28, FRAME, true);
    u64(o + 32, s.sizesOff);
    u64(o + 40, s.pkOff);
  });
  return new Blob([head, ...stored, ...tails]);
}

// A file's bytes (Uint8Array) as { opcm: Blob, header: Uint8Array | null (a package cut to its header) }, or
// { opcm: null, why } when it has no 16-bit PCM WAV. `bitrate`: a stereo stream's (mono gets half).
// ilomilo-nx-installer (2026-11-25): `encode(pcm48, channels, bitrate)` -> { packets, preSkip } can replace the browser's
// encoder (the Node tests pass ffmpeg's libopus, as lib/audio.js's encodeOpus does for the .xmop files).
export async function makeOpcm(d, bitrate = 128000, progress = () => {}, encode = encodeOpus) {
  const { regions, headerCut } = findRegions(d);
  if (!regions.length) return { opcm: null, why: 'no 16-bit PCM WAV in it' };
  const streams = [];
  for (let k = 0; k < regions.length; k++) {
    const r = regions[k];
    const { pcm, usable } = pcmOf(d, r);
    const y = resample(pcm, r.channels, r.rate, OPUS_RATE);
    const { packets, preSkip } = await encode(y, r.channels, r.channels === 2 ? bitrate : bitrate / 2);
    if (packets.length * FRAME < preSkip + y.length / r.channels)
      throw new Error(`${r.name}: the Opus packets do not cover its samples`);
    streams.push({ packets, preSkip, frames: pcm.length / r.channels, usable });
    progress(k + 1, regions.length);
  }
  return { opcm: build(d, regions, streams), header: headerCut ? d.slice(0, headerCut) : null, streams: regions.length };
}

// For test/opcm_node.mjs: the writer, given packets made elsewhere.
export const __test_build = build;
