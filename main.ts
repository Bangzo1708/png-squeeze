// png-squeeze: squeeze 1280x720 RGBA screenshots into the smallest lossless PNG.
//
// Strategy, per image:
//   1. Decode the stored PNG to RGBA with a general decoder (any colour type,
//      bit depth 8, filters 0-4, any number of IDAT chunks).
//   2. Analyse the pixels: opaque? grey? at most 256 distinct RGBA colours?
//      From that, build every exact colour form the image can take:
//        - palette (type 3) when it holds at most 256 colours, in two entry
//          orders (by count, by luminance), transparent entries first;
//        - grey (type 0), grey+alpha (type 4), RGB (type 2) or RGBA (type 6),
//          with a tRNS key when every non-opaque pixel is one fully
//          transparent value no opaque pixel uses.
//      A fully transparent pixel's colour is always kept exactly.
//   3. For every form, try every filter plan: one fixed filter for all rows
//      (0, 1, 2, 4) and a per-row choice by minimum signed sum, by fewest
//      distinct byte pairs, and by brute force (each row's five trials
//      actually compressed with the 32 KiB before it as dictionary).
//      Screen each plan with zlib level 6 and keep the three smallest.
//   4. Re-filter the winning form with brute force (each row's five trials
//      really compressed at level 6 with the 32 KiB before it as dictionary);
//      keep it when it screens better than the winner.
//   5. Write the best of the finalists with zlib level 9, in a PNG holding
//      the contest reads (IHDR, PLTE, tRNS, IDAT, IEND).
//
// Deterministic by construction: no clock, no randomness, no environment
// value feeds any decision; the work per image is fixed by its pixels.

import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------------------
// CRC-32 (ISO 3309), the checksum PNG chunks carry.
// ---------------------------------------------------------------------------

const CRC_TABLE: Int32Array = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG writing: signature, then chunks, each length + type + data + CRC.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function chunkOf(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8; // bit depth
  data[9] = colourType;
  return data;
}

function pngOf(width: number, height: number, colourType: number, plte: Uint8Array | null, trns: Uint8Array | null, idat: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [PNG_SIGNATURE, chunkOf('IHDR', ihdrOf(width, height, colourType))];
  if (plte !== null) parts.push(chunkOf('PLTE', plte));
  if (trns !== null) parts.push(chunkOf('tRNS', trns));
  parts.push(chunkOf('IDAT', idat));
  parts.push(chunkOf('IEND', new Uint8Array(0)));
  let size = 0;
  for (const p of parts) size += p.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG reading: a general decoder for bit depth 8, colour types 0/2/3/4/6.
// Returns the image as RGBA, rows top to bottom, or throws.
// ---------------------------------------------------------------------------

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paethPredict(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

interface Decoded {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function decodePng(bytes: Uint8Array): Decoded {
  if (bytes.length < 8 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) {
    throw new Error('not a PNG (bad signature)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let header: { width: number; height: number; colourType: number } | null = null;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    if (at + 12 > bytes.length) throw new Error('truncated chunk header');
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) throw new Error('chunk overruns file');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) {
      throw new Error(type + ' chunk fails its CRC');
    }
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      if (header !== null) throw new Error('two IHDR chunks');
      if (len !== 13) throw new Error('IHDR is not 13 bytes');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      const colourType = data[9];
      if (data[8] !== 8) throw new Error('bit depth is not 8');
      if (!(colourType in CHANNELS)) throw new Error('unsupported colour type ' + colourType);
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) {
        throw new Error('unsupported compression, filter or interlace');
      }
      header = { width: dv.getUint32(0), height: dv.getUint32(4), colourType };
    } else if (type === 'PLTE') {
      if (palette !== null) throw new Error('two PLTE chunks');
      if (header === null || header.colourType !== 3) throw new Error('PLTE without colour type 3');
      if (idatParts.length > 0) throw new Error('PLTE after IDAT');
      if (len === 0 || len % 3 !== 0 || len > 768) throw new Error('bad PLTE size');
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null) throw new Error('two tRNS chunks');
      if (idatParts.length > 0) throw new Error('tRNS after IDAT');
      if (header === null) throw new Error('tRNS before IHDR');
      const ct = header.colourType;
      if (ct === 3) {
        if (palette === null) throw new Error('tRNS before PLTE');
        if (len > palette.length / 3) throw new Error('tRNS longer than PLTE');
      } else if (ct === 0 || ct === 2) {
        if (len !== (ct === 0 ? 2 : 6)) throw new Error('bad tRNS size');
        for (let i = 0; i < len; i += 2) if (data[i] !== 0) throw new Error('tRNS sample over 255');
      } else {
        throw new Error('tRNS with colour type ' + ct);
      }
      trns = data;
    } else if (type === 'IDAT') {
      if (header !== null && header.colourType === 3 && palette === null) {
        throw new Error('IDAT before PLTE');
      }
      idatParts.push(data);
    } else if (type === 'IEND') {
      if (len !== 0) throw new Error('IEND is not empty');
      ended = true;
    } else {
      throw new Error('unsupported chunk ' + type);
    }
  }
  if (!ended) throw new Error('no IEND');
  if (header === null) throw new Error('no IHDR');
  if (idatParts.length === 0) throw new Error('no IDAT');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  const joined = idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts);
  const raw = inflateSync(joined, { maxOutputLength: expected + 1 });
  if (raw.length !== expected) throw new Error('IDAT inflates to the wrong size');

  // Unfilter row by row, in place into samples.
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error('row ' + y + ' has filter type ' + ft);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paethPredict(a, b, c);
      }
    }
  }

  // Expand to RGBA.
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    if (palette === null) throw new Error('palette image without PLTE');
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) throw new Error('palette index out of range');
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------------------
// Analysis: opaque? grey? at most 256 colours? one transparent key value?
// ---------------------------------------------------------------------------

interface Colour {
  rgba: number[];
  word: number;
  count: number;
}

interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: Colour[] | null;
}

function analyse(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  const u32 = rgba.byteOffset % 4 === 0
    ? new Uint32Array(rgba.buffer, rgba.byteOffset, n)
    : new Uint32Array(rgba.slice().buffer, 0, n);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else {
        counts.set(c, k + 1);
      }
    }
  }
  let colours: Colour[] | null = null;
  if (!many) {
    colours = [...counts.keys()].map((c) => {
      const b = new Uint8Array(Uint32Array.of(c).buffer);
      return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) as number };
    });
  }
  return { opaque, grey, colours };
}

// The one fully transparent value (grey sample or RGB triple) the image may
// key by tRNS: every non-opaque pixel is that exact value at alpha 0, and no
// opaque pixel holds the same value. Null when there is none.
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// ---------------------------------------------------------------------------
// Colour forms: the exact representations an image can take.
// ---------------------------------------------------------------------------

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) {
      out[s] = rgba[d];
    } else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

// A palette form: entries ordered so transparent ones come first (by alpha),
// then by `order` ('count' = most used first, 'luminance' = darkest first).
// Transparent entries first keeps the tRNS chunk short.
function paletteForm(rgba: Uint8Array, colours: Colour[], order: string): Form {
  const lum = (c: Colour): number => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  const entries = [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map<number, number>(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0
    ? null
    : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = rgba.byteOffset % 4 === 0
    ? new Uint32Array(rgba.buffer, rgba.byteOffset, n)
    : new Uint32Array(rgba.slice().buffer, 0, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]) as number;
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

// The channel form: grey / grey+alpha / RGB / RGBA, with a tRNS key when one
// exists, so the alpha channel is dropped whenever the image allows it.
function channelForm(rgba: Uint8Array, a: Analysis): Form {
  const key = a.opaque ? null : transparentKey(rgba, a.grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (a.grey) {
    ct = a.opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = a.opaque || key !== null ? 2 : 6;
    if (key !== null) {
      trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
    }
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] as number;
  return { colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns };
}

function formsOf(rgba: Uint8Array, a: Analysis): Form[] {
  const forms: Form[] = [channelForm(rgba, a)];
  if (a.colours !== null) {
    forms.push(paletteForm(rgba, a.colours, 'count'));
    forms.push(paletteForm(rgba, a.colours, 'luminance'));
  }
  return forms;
}

// The bytes a form's PLTE and tRNS chunks add to the file.
function chunkOverhead(form: Form): number {
  return (form.plte === null ? 0 : 12 + form.plte.length)
    + (form.trns === null ? 0 : 12 + form.trns.length);
}

// ---------------------------------------------------------------------------
// Filtering: the five PNG row filters and the per-row choice heuristics.
// ---------------------------------------------------------------------------

function filterRowInto(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPredict(a, b, c);
    }
  }
}

// Sum of a filtered row's bytes read as signed (-128..127), absolute.
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// How many distinct pairs of neighbouring bytes a filtered row holds.
function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

const BRUTE_CONTEXT = 32768; // bytes of filtered data a brute trial looks back at

// One fixed filter for every row.
function filterFixed(samples: Uint8Array, width: number, height: number, bpp: number, type: number): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    raw[y * (stride + 1)] = type;
    filterRowInto(type, cur, prev, bpp, raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
  }
  return raw;
}

// Each row its own filter, by `mode`: 'minsum', 'pairs', or 'brute' (each of
// the five trials really compressed at level 6 with the 32 KiB before it as
// dictionary, the smallest kept; the lower filter on a tie).
function filterAdaptive(samples: Uint8Array, width: number, height: number, bpp: number, mode: string): Uint8Array {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    const before = mode === 'brute' ? raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at) : null;
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      trial[t][0] = t;
      filterRowInto(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (mode === 'minsum') {
        cost = signedSum(trial[t].subarray(1));
      } else if (mode === 'pairs') {
        cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      } else {
        // Brute force: weigh the trial by really compressing it, at level 6
        // so the ranking tracks the level-9 final, with the filtered bytes
        // before it as dictionary.
        cost = before === null || before.length === 0
          ? deflateSync(trial[t], { level: 6, memLevel: 9 }).length
          : deflateSync(trial[t], { level: 6, memLevel: 9, dictionary: before }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw[at] = type;
    filterRowInto(type, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Compression: screen every form x filter plan at zlib level 6, refine the
// winner with brute force, write the winner at zlib level 9.
// ---------------------------------------------------------------------------

const SCREEN = { level: 6, memLevel: 8 };
const FINAL = { level: 9, memLevel: 9 };

interface Candidate {
  form: Form;
  raw: Uint8Array;
  screenBytes: number;
}

function compressImage(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const a = analyse(rgba);
  const forms = formsOf(rgba, a);
  const plans: string[] = ['fixed0', 'fixed1', 'fixed2', 'fixed4', 'minsum', 'pairs'];

  // Screen every form x plan at level 6; keep the three best candidates
  // (a level-6 ranking can flip at level 9, so the final weighs all three).
  const finalists: Candidate[] = [];
  const consider = (form: Form, raw: Uint8Array): void => {
    const bytes = deflateSync(raw, SCREEN).length + chunkOverhead(form);
    const cand: Candidate = { form, raw, screenBytes: bytes };
    let at = finalists.length;
    while (at > 0 && finalists[at - 1].screenBytes > bytes) at--;
    finalists.splice(at, 0, cand);
    if (finalists.length > 3) finalists.pop();
  };
  for (const form of forms) {
    for (const plan of plans) {
      let raw: Uint8Array;
      if (plan === 'minsum' || plan === 'pairs') {
        raw = filterAdaptive(form.samples, width, height, form.bpp, plan);
      } else {
        raw = filterFixed(form.samples, width, height, form.bpp, Number(plan.slice(5)));
      }
      consider(form, raw);
    }
  }

  // Refine the winning form with brute-force per-row filtering; keep it
  // when it screens better than the winner.
  if (finalists.length > 0) {
    const winner = finalists[0];
    const bruteRaw = filterAdaptive(winner.form.samples, width, height, winner.form.bpp, 'brute');
    const bruteBytes = deflateSync(bruteRaw, SCREEN).length + chunkOverhead(winner.form);
    if (bruteBytes < winner.screenBytes) {
      consider(winner.form, bruteRaw);
    }
  }

  // Final: level 9 on every finalist; keep the smallest file.
  if (finalists.length === 0) throw new Error('no candidate form');
  let bestZlib = deflateSync(finalists[0].raw, FINAL);
  let bestForm = finalists[0].form;
  let bestTotal = bestZlib.length + chunkOverhead(bestForm);
  for (let i = 1; i < finalists.length; i++) {
    const altZlib = deflateSync(finalists[i].raw, FINAL);
    const altTotal = altZlib.length + chunkOverhead(finalists[i].form);
    if (altTotal < bestTotal) {
      bestZlib = altZlib;
      bestForm = finalists[i].form;
      bestTotal = altTotal;
    }
  }
  return pngOf(width, height, bestForm.colourType, bestForm.plte, bestForm.trns, bestZlib);
}

// ---------------------------------------------------------------------------
// Main: one PNG per instance directory under /input, to /output/<id>/image.png.
// ---------------------------------------------------------------------------

for (const id of readdirSync(INPUT_DIR).sort()) {
  const inPath = join(INPUT_DIR, id, 'image.png');
  let data: Buffer;
  try {
    data = readFileSync(inPath);
  } catch {
    continue;
  }
  const image = decodePng(new Uint8Array(data));
  const out = compressImage(image.rgba, image.width, image.height);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), out);
}
