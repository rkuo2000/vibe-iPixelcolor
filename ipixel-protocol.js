/*
 * iPixel Color BLE protocol, ported from pypixelcolor (https://github.com/lucagoc/pypixelcolor).
 * Pure functions only (no DOM, no Bluetooth) so the encoder can be tested in Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IPixel = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const WRITE_UUID = '0000fa02-0000-1000-8000-00805f9b34fb';
  const NOTIFY_UUID = '0000fa03-0000-1000-8000-00805f9b34fb';
  // pypixelcolor never names the service; Web Bluetooth must list it to reach fa02/fa03.
  const SERVICE_UUIDS = [
    '000000fa-0000-1000-8000-00805f9b34fb',
    '0000fa00-0000-1000-8000-00805f9b34fb',
    '0000ffd0-0000-1000-8000-00805f9b34fb',
    '0000fff0-0000-1000-8000-00805f9b34fb',
    '0000ffe0-0000-1000-8000-00805f9b34fb',
    '0000ae00-0000-1000-8000-00805f9b34fb'
  ];

  const WINDOW_SIZE = 12 * 1024;
  const DEFAULT_CHUNK = 244;

  // Device type byte -> LED type -> panel size (lib/device_info.py)
  const DEVICE_TYPE_MAP = {
    128: 0, 129: 2, 130: 4, 131: 3, 132: 1, 133: 5, 134: 6, 135: 7, 136: 8, 137: 9,
    138: 10, 139: 11, 140: 12, 141: 13, 142: 14, 143: 15, 144: 16, 145: 17, 146: 18, 147: 19
  };
  const LED_SIZE_MAP = {
    0: [64, 64], 1: [96, 16], 2: [32, 32], 3: [64, 16], 4: [32, 16], 5: [64, 20], 6: [128, 32],
    7: [144, 16], 8: [192, 16], 9: [48, 24], 10: [64, 32], 11: [96, 32], 12: [128, 32], 13: [96, 32],
    14: [160, 32], 15: [192, 32], 16: [256, 32], 17: [320, 32], 18: [384, 32], 19: [448, 32]
  };

  const ANIMATIONS = { STATIC: 0, SCROLL_LEFT: 1, SCROLL_RIGHT: 2, SCROLL_UP: 3, SCROLL_DOWN: 4, BLINK: 5, FADE: 6, SNOWFLAKE: 7 };
  const TIMER = { STOP: 0, START: 1, PAUSE: 2 };
  const DAYS = { mon: 0x02, tue: 0x04, wed: 0x08, thu: 0x10, fri: 0x20, sun: 0x40, sat: 0x80 };

  function u8(list) { return Uint8Array.from(list, v => v & 0xff); }

  function check(value, min, max, name) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new RangeError(`${name} must be an integer between ${min} and ${max} (got ${value})`);
    return n;
  }

  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
  }

  function le16(n) { return [n & 0xff, (n >>> 8) & 0xff]; }
  function le32(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function hex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }

  function parseHex(str) {
    const clean = String(str).replace(/[^0-9a-f]/gi, '');
    if (clean.length % 2) throw new Error('Hex string must have an even number of digits');
    const out = new Uint8Array(clean.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }

  function parseColor(color, name = 'Color') {
    const clean = String(color).replace(/^#/, '');
    if (!/^[0-9a-f]{6}$/i.test(clean)) throw new Error(`${name} must be 6 hex digits, e.g. ffffff`);
    return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
  }

  // ---- Simple commands (src/pypixelcolor/commands/*.py) ----

  const cmd = {
    getDeviceInfo(now = new Date()) {
      return u8([8, 0, 1, 0x80, now.getHours(), now.getMinutes(), now.getSeconds(), 0]);
    },
    setTime(hour, minute, second) {
      return u8([8, 0, 1, 0x80, check(hour, 0, 23, 'Hour'), check(minute, 0, 59, 'Minute'), check(second, 0, 59, 'Second'), 0]);
    },
    clear() { return u8([4, 0, 3, 0x80]); },
    setBrightness(level) { return u8([5, 0, 4, 0x80, check(level, 0, 100, 'Brightness')]); },
    setOrientation(o) { return u8([5, 0, 6, 0x80, check(o, 0, 3, 'Orientation')]); },
    setPower(on) { return u8([5, 0, 7, 1, on ? 1 : 0]); },
    deleteSlot(n) { return u8([7, 0, 2, 1, 1, 0, check(n, 0, 255, 'Slot')]); },
    showSlot(n) { return u8([7, 0, 8, 0x80, 1, 0, check(n, 0, 255, 'Slot')]); },
    setScores(p1, p2) { return u8([8, 0, 0x0a, 0x80, check(p1, 0, 99, 'Score P1'), 0, check(p2, 0, 99, 'Score P2'), 0]); },
    setTimer(action) { return u8([5, 0, 9, 0x80, check(action, 0, 2, 'Timer action')]); },
    setFunMode(enable) { return u8([5, 0, 4, 1, enable ? 1 : 0]); },
    setPixel(x, y, rgb) { return u8([10, 0, 5, 1, 0, rgb[0], rgb[1], rgb[2], check(x, 0, 255, 'X'), check(y, 0, 255, 'Y')]); },
    setClockMode({ style = 1, format24 = true, showDate = true, date = new Date() } = {}) {
      const dow = ((date.getDay() + 6) % 7) + 1; // Python weekday()+1: Monday=1 .. Sunday=7
      return u8([11, 0, 6, 1, check(style, 0, 8, 'Clock style'), format24 ? 1 : 0, showDate ? 1 : 0,
        date.getFullYear() % 100, date.getMonth() + 1, date.getDate(), dow]);
    },
    setRhythmMode(style, levels) {
      check(style, 0, 4, 'Rhythm style');
      if (levels.length !== 11) throw new Error('Rhythm mode needs 11 levels');
      return u8([16, 0, 1, 2, style, ...levels.map((l, i) => check(l, 0, 15, `Level ${i + 1}`))]);
    },
    setRhythmMode2(style, t) { return u8([6, 0, 0, 2, check(t, 0, 7, 'Animation time'), check(style, 0, 1, 'Rhythm 2 style')]); },
    setSchedule({ hour, minute, on, days = null, slot = 0 }) {
      let mask = 0xff;
      if (days && days.length) {
        mask = 1;
        for (const d of days) {
          const bit = DAYS[String(d).toLowerCase()];
          if (!bit) throw new Error(`Unknown day: ${d}`);
          mask |= bit;
        }
      }
      return u8([9, 0, 0x11, 0x80, on ? 1 : 0, check(slot, 0, 255, 'Schedule slot'), mask, check(hour, 0, 23, 'Hour'), check(minute, 0, 59, 'Minute')]);
    }
  };

  function parseDeviceInfo(resp) {
    if (!resp || resp.length < 5) throw new Error(`Device info response too short (${resp ? resp.length : 0} bytes)`);
    const deviceType = resp[4];
    const ledType = DEVICE_TYPE_MAP[deviceType] ?? 0;
    const [width, height] = LED_SIZE_MAP[ledType] || [64, 64];
    return { deviceType, ledType, width, height, passwordFlag: resp.length >= 11 ? resp[10] : 255, raw: hex(resp) };
  }

  // ---- Multi-window data transfers (text, PNG, GIF) ----

  function buildWindows(kind, payload, saveSlot = 0) {
    check(saveSlot, 0, 255, 'Save slot');
    const head = { text: [0x00, 0x01], png: [0x02, 0x00], gif: [0x03, 0x00] }[kind];
    const tail = kind === 'gif' ? 0x02 : 0x00;
    if (!head) throw new Error(`Unknown transfer kind ${kind}`);
    const size = le32(payload.length);
    const crc = le32(crc32(payload));
    const windows = [];
    for (let pos = 0, idx = 0; pos < payload.length; pos += WINDOW_SIZE, idx++) {
      const chunk = payload.subarray(pos, Math.min(pos + WINDOW_SIZE, payload.length));
      const frame = concat([u8([...head, idx === 0 ? 0x00 : 0x02, ...size, ...crc, tail, saveSlot]), chunk]);
      windows.push(concat([u8(le16(frame.length + 2)), frame]));
    }
    return windows;
  }

  // ---- Text encoding (commands/send_text) ----

  const COLOR_TOKEN = /\[#?([0-9a-fA-F]{6})\]|(\[\/(?:color|#)?\])/g;

  /** Split "[#ff0000]Red[/] text" into plain text plus one hex color per UTF-16 code unit. */
  function parseColoredText(raw, defaultColor = 'ffffff') {
    const stack = [String(defaultColor).replace(/^#/, '').toLowerCase()];
    let text = '';
    const colors = [];
    let last = 0;
    const push = chunk => { for (let i = 0; i < chunk.length; i++) colors.push(stack[stack.length - 1]); text += chunk; };
    for (const m of raw.matchAll(COLOR_TOKEN)) {
      push(raw.slice(last, m.index));
      if (m[1]) stack.push(m[1].toLowerCase());
      else if (stack.length > 1) stack.pop();
      last = m.index + m[0].length;
    }
    push(raw.slice(last));
    return { text, colors };
  }

  function stripColorTags(raw) { return raw.replace(COLOR_TOKEN, ''); }

  /** 13-byte properties header: 00 01 01 anim speed rainbow r g b (01 r g b | 00 00 00 00). */
  function textProperties({ animation = 0, speed = 80, rainbow = 0, color = [255, 255, 255], bgColor = null }) {
    return u8([0x00, 0x01, 0x01, check(animation, 0, 7, 'Animation'), check(speed, 0, 100, 'Speed'), check(rainbow, 0, 9, 'Rainbow mode'),
      ...color, ...(bgColor ? [0x01, ...bgColor] : [0, 0, 0, 0])]);
  }

  /**
   * Pack a 1-bit glyph (mask[y * width + x] truthy = lit) row by row.
   * Equivalent to encode_char_img followed by the per-byte bit reversal: x -> byte x>>3, bit x&7.
   */
  function packGlyph(mask, width, height) {
    const bytesPerRow = width <= 8 ? 1 : width <= 16 ? 2 : width <= 24 ? 3 : 4;
    const out = new Uint8Array(bytesPerRow * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < Math.min(width, 32); x++) {
        if (mask[y * width + x]) out[y * bytesPerRow + (x >> 3)] |= 1 << (x & 7);
      }
    }
    return out;
  }

  function charBlock(glyphBytes, width, height, color) {
    const is32 = height >= 32 ? 1 : 0;
    const wide = width > (is32 ? 16 : 8) ? 1 : 0;
    return concat([u8([(is32 << 1) | wide, ...color]), glyphBytes]);
  }

  function emojiBlock(jpeg, height) {
    return concat([u8([height >= 32 ? 0x09 : 0x08, ...le16(jpeg.length), 0x00]), jpeg]);
  }

  /** Strip the JFIF APP0 segment the way pypixelcolor does (SOI + from first DQT). */
  function stripJfif(jpeg) {
    if (jpeg[2] === 0xff && jpeg[3] === 0xe0) {
      for (let i = 2; i < jpeg.length - 1; i++) {
        if (jpeg[i] === 0xff && jpeg[i + 1] === 0xdb) return concat([u8([0xff, 0xd8]), jpeg.subarray(i)]);
      }
    }
    return jpeg;
  }

  /** blocks: encoded char/emoji blocks in send order. */
  function buildTextPayload(blocks, props) {
    if (blocks.length < 1 || blocks.length > 255) throw new RangeError(`Text must have 1-255 characters (got ${blocks.length})`);
    return concat([u8([blocks.length]), textProperties(props), ...blocks]);
  }

  // ---- GIF89a encoder (for resized animations) ----

  function buildPalette(frames, maxColors = 256) {
    const counts = new Map();
    for (const f of frames) {
      const d = f.rgba;
      for (let i = 0; i < d.length; i += 4) {
        const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    if (counts.size <= maxColors) return Array.from(counts.keys(), k => [k >> 16, (k >> 8) & 0xff, k & 0xff]);

    // Median cut over the unique colors, weighted by frequency.
    let boxes = [Array.from(counts, ([k, n]) => [k >> 16, (k >> 8) & 0xff, k & 0xff, n])];
    while (boxes.length < maxColors) {
      let best = -1, bestRange = 0, bestCh = 0;
      boxes.forEach((box, i) => {
        if (box.length < 2) return;
        for (let ch = 0; ch < 3; ch++) {
          let lo = 255, hi = 0;
          for (const c of box) { if (c[ch] < lo) lo = c[ch]; if (c[ch] > hi) hi = c[ch]; }
          if (hi - lo > bestRange) { bestRange = hi - lo; best = i; bestCh = ch; }
        }
      });
      if (best < 0) break;
      const box = boxes[best].sort((a, b) => a[bestCh] - b[bestCh]);
      const total = box.reduce((s, c) => s + c[3], 0);
      let acc = 0, cut = 1;
      for (let i = 0; i < box.length - 1; i++) { acc += box[i][3]; if (acc >= total / 2) { cut = i + 1; break; } }
      boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
    }
    return boxes.map(box => {
      let r = 0, g = 0, b = 0, n = 0;
      for (const c of box) { r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; n += c[3]; }
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    });
  }

  function lzwEncode(indices, minCodeSize) {
    const clearCode = 1 << minCodeSize, eoi = clearCode + 1;
    let codeSize = minCodeSize + 1, next = eoi + 1;
    const dict = new Map();
    const out = [];
    let acc = 0, bits = 0;
    const emit = code => {
      acc |= code << bits;
      bits += codeSize;
      while (bits >= 8) { out.push(acc & 0xff); acc >>>= 8; bits -= 8; }
    };
    emit(clearCode);
    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i];
      const key = (prefix << 8) | k;
      const found = dict.get(key);
      if (found !== undefined) { prefix = found; continue; }
      emit(prefix);
      if (next < 4096) {
        if (next >= (1 << codeSize)) codeSize++;
        dict.set(key, next++);
      } else {
        emit(clearCode);
        dict.clear();
        codeSize = minCodeSize + 1;
        next = eoi + 1;
      }
      prefix = k;
    }
    emit(prefix);
    emit(eoi);
    if (bits > 0) out.push(acc & 0xff);
    return out;
  }

  /** frames: [{ rgba: Uint8ClampedArray(width*height*4), delay: ms }] -> GIF89a bytes with one global palette. */
  function encodeGif(frames, width, height, { loop = 0 } = {}) {
    const palette = buildPalette(frames);
    let tableBits = 1;
    while ((1 << tableBits) < palette.length) tableBits++;
    const tableSize = 1 << tableBits;
    const lookup = new Map();
    const nearest = key => {
      let idx = lookup.get(key);
      if (idx !== undefined) return idx;
      const r = key >> 16, g = (key >> 8) & 0xff, b = key & 0xff;
      let best = Infinity;
      palette.forEach((p, i) => {
        const d = (p[0] - r) ** 2 * 3 + (p[1] - g) ** 2 * 4 + (p[2] - b) ** 2 * 2;
        if (d < best) { best = d; idx = i; }
      });
      lookup.set(key, idx);
      return idx;
    };

    const out = [];
    const ascii = s => { for (const ch of s) out.push(ch.charCodeAt(0)); };
    ascii('GIF89a');
    out.push(...le16(width), ...le16(height), 0x80 | 0x70 | (tableBits - 1), 0, 0);
    for (let i = 0; i < tableSize; i++) out.push(...(palette[i] || [0, 0, 0]));
    if (frames.length > 1) {
      out.push(0x21, 0xff, 0x0b);
      ascii('NETSCAPE2.0');
      out.push(0x03, 0x01, ...le16(loop), 0x00);
    }
    const minCode = Math.max(2, tableBits);
    for (const f of frames) {
      const delay = Math.max(2, Math.round((f.delay || 100) / 10));
      out.push(0x21, 0xf9, 0x04, 2 << 2, ...le16(delay), 0, 0); // disposal 2, matching PIL's default
      out.push(0x2c, 0, 0, 0, 0, ...le16(width), ...le16(height), 0);
      const idx = new Uint8Array(width * height);
      for (let p = 0, i = 0; p < idx.length; p++, i += 4) idx[p] = nearest((f.rgba[i] << 16) | (f.rgba[i + 1] << 8) | f.rgba[i + 2]);
      const data = lzwEncode(idx, minCode);
      out.push(minCode);
      for (let i = 0; i < data.length; i += 255) {
        const block = data.slice(i, i + 255);
        out.push(block.length, ...block);
      }
      out.push(0);
    }
    out.push(0x3b);
    return Uint8Array.from(out);
  }

  return {
    WRITE_UUID, NOTIFY_UUID, SERVICE_UUIDS, WINDOW_SIZE, DEFAULT_CHUNK, DEVICE_TYPE_MAP, LED_SIZE_MAP,
    ANIMATIONS, TIMER, DAYS, cmd, parseDeviceInfo, buildWindows, crc32, hex, parseHex, parseColor, concat,
    parseColoredText, stripColorTags, textProperties, packGlyph, charBlock, emojiBlock, stripJfif, buildTextPayload,
    buildPalette, lzwEncode, encodeGif
  };
});
