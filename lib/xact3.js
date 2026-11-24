// ilomilo-nx-installer (2026-11-25, the user: "re-encode their audio and video to opus and h265 and L4Z/ZXC stuff as a
// part of the progress"): ilomilo's XACT 3 wave banks (Data/sound/Xbox/*.xwb, version 46, header version 44), read for
// lib/xmop.js as game.json's audio container "xact". After vivapinata-nx-installer's lib/xact.js (XACT 2, versions
// 38-41, credit it; banjo-nx's tools/xwb_opcm_pack.py read XACT 3 for its PCM): XACT 3's header has a header-version
// word after the version, so the five regions start at byte 12 instead of 8. Everything else is as there:
//   0   'DNBW', u32 version, u32 header version (XACT 3: versions 42-46)
//   12  five regions, (u32 offset, u32 length) each: bank data, entry metadata, seek tables, entry names, wave data
//   bank data: u32 flags (1 streaming; 0x10000 entry names; 0x20000 compact entries; 0x80000 seek tables), u32 entry
//              count, char name[64], u32 entry metadata size (24), u32 entry name size, u32 alignment, ...
//   entry metadata, 24 bytes each: u32 flags and duration, u32 format, u32 play offset (in the wave data) and length,
//              u32 loop start and length (in samples)
// The format word, read big-endian, keeps the PC's bit order, lowest first: tag 2 bits (0 PCM, 1 XMA, 2 ADPCM, 3 WMA),
// channels 3, sample rate 18, block align 8, bits 1 (the base's docs/media-compression.md section 6: versions 38-46).
// ilomilo's banks (surveyed 2026-11-25): 9 banks, 536 entries; XMA mono and stereo at 42,522-44,570 Hz (each sound its
// own measured rate), PCM 16-bit at 44,100 Hz (and one stereo 22,050 Hz); startup.xwb is all PCM (alignment 4).
//
// The XMA sounds only: PCM, ADPCM and WMA entries stay in the bank as they are (packed losslessly with the rest of the
// file). A play region that is not whole 2048-byte packets is left out (xmaSounds checks it).

const TAGS = ['PCM', 'XMA', 'ADPCM', 'WMA'];
const PACKET_BYTES = 2048;

const be32 = (d, o) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;

// Whether `d` (a file's first bytes) is an XACT wave bank.
export const isWaveBank = (d) => d.length >= 4 && d[0] === 0x44 && d[1] === 0x4e && d[2] === 0x42 && d[3] === 0x57;

// The bank's header and its entries: { version, headerVersion, flags, name, regions, entries: [{ index, tag, format,
// channels, rate, blockAlign, bits, playOffset, playLength, dataOffset (in the file), loopStart, loopLength }] }, or
// throws for anything but an XACT 3 bank with full entries.
export function readWaveBank3(d) {
  if (!isWaveBank(d)) throw new Error('not an XACT wave bank');
  const version = be32(d, 4);
  if (version < 42 || version > 46) throw new Error(`XACT wave bank version ${version} (XACT 3, 42-46, are read here)`);
  const headerVersion = be32(d, 8);
  const regions = [];
  for (let i = 0; i < 5; ++i) regions.push({ offset: be32(d, 12 + 8 * i), length: be32(d, 16 + 8 * i) });
  const bank = regions[0].offset;
  if (bank + 84 > d.length) throw new Error('the bank data runs past the file');
  const flags = be32(d, bank), count = be32(d, bank + 4);
  let name = '';
  for (let i = 0; i < 64 && d[bank + 8 + i]; ++i) name += String.fromCharCode(d[bank + 8 + i]);
  const metaSize = be32(d, bank + 72);
  if (flags & 0x20000) throw new Error('compact entries are not read');
  if (metaSize < 24) throw new Error(`entry metadata of ${metaSize} bytes`);
  const meta = regions[1].offset, wave = regions[4];
  if (meta + count * metaSize > d.length) throw new Error('the entry metadata runs past the file');
  const entries = [];
  for (let i = 0; i < count; ++i) {
    const e = meta + i * metaSize;
    const format = be32(d, e + 4);
    const playOffset = be32(d, e + 8), playLength = be32(d, e + 12);
    entries.push({
      index: i, tag: TAGS[format & 3], format,
      channels: (format >>> 2) & 7,
      rate: (format >>> 5) & 0x3ffff,
      blockAlign: (format >>> 23) & 0xff,
      bits: format >>> 31,
      playOffset, playLength,
      dataOffset: wave.offset + playOffset,
      loopStart: be32(d, e + 16), loopLength: be32(d, e + 20),
    });
  }
  return { version, headerVersion, flags, name, regions, entries, streaming: !!(flags & 1) };
}

// lib/xmop.js's sound list (game.json audio "container": "xact"): one { n, offset, size, info } per XMA entry, mono or
// stereo, whose play region lies in the file; [] for a file that is not an XACT 3 bank.
export function xactXmaSounds(d) {
  let bank;
  try {
    bank = readWaveBank3(d);
  } catch {
    return [];
  }
  const out = [];
  for (const e of bank.entries) {
    if (e.tag !== 'XMA' || e.channels < 1 || e.channels > 2 || !e.playLength) continue;
    const size = e.playLength - (e.playLength % PACKET_BYTES);
    if (!size || e.dataOffset + size > d.length) continue;
    out.push({ n: e.index, offset: e.dataOffset, size,
               info: { format: 'XMA', kind: 'XACT3', streams: 1, channels: e.channels, rate: e.rate,
                       dataOffset: e.dataOffset, dataSize: size } });
  }
  return out;
}
