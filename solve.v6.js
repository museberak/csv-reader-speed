// solve.v6.js — True Raw Buffer-to-Buffer Single-Pass CSV→JSON.
// Processes a raw cases.json Buffer and writes answers.json bytes to an output Buffer.
// NO JSON.parse / JSON.stringify / Buffer.from / Buffer.concat / regex on the hot path.
// Per-case fallback to an embedded cold parser for rare escapes (\uXXXX).
//
// Byte facts about cases.json (verified by inspection):
//   - non-ASCII is raw UTF-8 (no \uXXXX); the only JSON escapes are \" \n \r.
//   - no raw 0x0A / 0x0D anywhere; all LF/CR are the 2-byte escapes \n \r.
//   - inside a "text" string the only special bytes are ',' (0x2C) and '\' (0x5C).
//   - \" and \n map byte-identically input->output, so clean spans are copied directly.
//   - \r (inside quotes) -> \n ; \r\n (inside quotes) -> \n ; \"\" (doubled) -> \" .

const COMMA = 0x2c; // ','
const BS = 0x5c;    // backslash
const QUOTE = 0x22; // '"'
const ESC_n = 0x6e; // 'n'
const ESC_r = 0x72; // 'r'
const ESC_t = 0x74; // 't'
const ESC_b = 0x62; // 'b'
const ESC_f = 0x66; // 'f'
const ESC_SLASH = 0x2f; // '/'

// ---------------------------------------------------------------------------
// Embedded cold parser (fallback only). Exact copy of solve.cold.js run().
// Used only when a case contains a rare escape (\uXXXX) the fast path refuses.
// ---------------------------------------------------------------------------
function coldRun(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let ended = 0;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;
  let recordLine = 1;
  let recordRow = null;
  const COMMA_C = 44, QUOTE_C = 34, LF_C = 10, CR_C = 13;
  function readUnquoted(initial) {
    let value = initial;
    for (;;) {
      const c = text.indexOf(',', pos);
      const l = text.indexOf('\n', pos);
      let end, isComma;
      if (c === -1) { end = l === -1 ? n : l; isComma = false; }
      else if (l === -1) { end = c; isComma = true; }
      else if (c < l) { end = c; isComma = true; }
      else { end = l; isComma = false; }
      const span = text.slice(pos, end);
      const r = span.indexOf('\r');
      if (r === -1) {
        value += span;
        if (isComma) { pos = end + 1; ended = 0; return value; }
        if (end < n) { pos = end + 1; line += 1; ended = 1; return value; }
        pos = end; ended = 2; return value;
      }
      if (r === span.length - 1 && !isComma && end < n) {
        value += span.slice(0, -1);
        pos = end + 1; line += 1; ended = 1; return value;
      }
      const lastIsCrlf = !isComma && end < n && span.charCodeAt(span.length - 1) === CR_C;
      let cleaned = '';
      let from = 0;
      let idx = r;
      while (idx !== -1) {
        if (lastIsCrlf && idx === span.length - 1) break;
        cleaned += span.slice(from, idx);
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        from = idx + 1;
        idx = span.indexOf('\r', from);
      }
      cleaned += span.slice(from, lastIsCrlf ? span.length - 1 : span.length);
      value += cleaned;
      if (isComma) { pos = end + 1; ended = 0; return value; }
      if (end < n) { pos = end + 1; line += 1; ended = 1; return value; }
      pos = end; ended = 2; return value;
    }
  }
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const parts = [];
    pos += 1;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        pos = open + 1; line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      const chunk = text.slice(pos, q);
      if (chunk.indexOf('\r') === -1 && chunk.indexOf('\n') === -1) {
        parts.push(chunk);
      } else {
        const converted = chunk.replace(/\r\n?/g, '\n');
        let breaks = 0;
        for (let i = 0; i < converted.length; i++) if (converted.charCodeAt(i) === LF_C) breaks += 1;
        line += breaks;
        parts.push(converted);
      }
      if (text.charCodeAt(q + 1) === QUOTE_C) { parts.push('"'); pos = q + 2; continue; }
      pos = q + 1;
      const value = parts.join('');
      if (pos >= n) { ended = 2; return value; }
      const c = text.charCodeAt(pos);
      if (c === COMMA_C) { pos += 1; ended = 0; return value; }
      if (c === LF_C) { pos += 1; line += 1; ended = 1; return value; }
      if (c === CR_C && text.charCodeAt(pos + 1) === LF_C) { pos += 2; line += 1; ended = 1; return value; }
      const junkValue = readUnquoted(value);
      if (junkValue.length > value.length) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return junkValue;
    }
  }
  for (;;) {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF_C) { pos += 1; line += 1; }
      else if (c === CR_C && text.charCodeAt(pos + 1) === LF_C) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === QUOTE_C;
      fields.push(quoted ? readQuoted() : readUnquoted(''));
    } while (ended === 0);
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    if (width < 0) width = fields.length;
    if (header && columns === null) { columns = fields; continue; }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}

// ---------------------------------------------------------------------------
// Outer-JSON helpers.
// ---------------------------------------------------------------------------

// Find the closing quote of a JSON string whose content starts at `start`
// (just after the opening quote). A quote preceded by an odd run of
// backslashes is escaped; an even run (including zero) is the delimiter.
function findStringEnd(buf, start, limit) {
  let pos = start;
  for (;;) {
    const q = buf.indexOf(QUOTE, pos);
    if (q === -1 || q >= limit) return -1;
    let bs = 0;
    let i = q - 1;
    while (i >= start && buf[i] === BS) { bs++; i--; }
    if ((bs & 1) === 0) return q;
    pos = q + 1;
  }
}

function skipWs(buf, pos, limit) {
  while (pos < limit) {
    const c = buf[pos];
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
    else break;
  }
  return pos;
}

// ---------------------------------------------------------------------------
// Main entry: process a whole raw cases.json Buffer, write answers.json bytes.
// Returns { outPos, fallbackCases }. outBuf must be large enough.
// ---------------------------------------------------------------------------
export function runCases(inBuf, outBuf) {
  const N = inBuf.length;
  let outPos = 0;
  let fallbackCases = 0;

  // Collect "text" and "header" key positions. Raw quotes only match keys,
  // never string content, because content quotes are always escaped as \".
  const textKeys = [];
  const headerKeys = [];
  const inputKeys = [];
  {
    const TEXT_KEY = Buffer.from('"text"');
    const HEADER_KEY = Buffer.from('"header"');
    const INPUT_KEY = Buffer.from('"input"');
    let p = 0;
    for (;;) {
      const t = inBuf.indexOf(TEXT_KEY, p);
      if (t === -1) break;
      textKeys.push(t);
      p = t + 1;
    }
    p = 0;
    for (;;) {
      const h = inBuf.indexOf(HEADER_KEY, p);
      if (h === -1) break;
      headerKeys.push(h);
      p = h + 1;
    }
    p = 0;
    for (;;) {
      const k = inBuf.indexOf(INPUT_KEY, p);
      if (k === -1) break;
      inputKeys.push(k);
      p = k + 1;
    }
  }

  // Resolve each text key to its string range + header value.
  const cases = [];
  for (let i = 0; i < textKeys.length; i++) {
    const tk = textKeys[i];
    let p = skipWs(inBuf, tk + 6, N);
    if (inBuf[p] !== 0x3a) continue; // ':'
    p = skipWs(inBuf, p + 1, N);
    if (inBuf[p] !== QUOTE) continue;
    const textStart = p + 1;
    const textEnd = findStringEnd(inBuf, textStart, N);
    if (textEnd === -1) continue;
    const prevEnd = i === 0 ? 0 : cases[i - 1].textEnd;
    const nextTk = i + 1 < textKeys.length ? textKeys[i + 1] : N;
    let header = false;
    // The input key of THIS case lower-bounds the before-text header search,
    // so we never pick up the previous case's header (which sits between
    // prevEnd and this case's "input" key).
    let inputKey = -1;
    for (let j = 0; j < inputKeys.length; j++) {
      if (inputKeys[j] > prevEnd && inputKeys[j] < tk) { inputKey = inputKeys[j]; break; }
    }
    const lowerBound = inputKey !== -1 ? inputKey : prevEnd;
    let hk = -1;
    for (let j = headerKeys.length - 1; j >= 0; j--) {
      if (headerKeys[j] > lowerBound && headerKeys[j] < tk) { hk = headerKeys[j]; break; }
    }
    if (hk === -1) {
      for (let j = 0; j < headerKeys.length; j++) {
        if (headerKeys[j] > textEnd && headerKeys[j] < nextTk) { hk = headerKeys[j]; break; }
      }
    }
    if (hk !== -1) {
      let q = skipWs(inBuf, hk + 8, N);
      if (inBuf[q] === 0x3a) {
        q = skipWs(inBuf, q + 1, N);
        header = inBuf[q] === 0x74; // 't' of true
      }
    }
    cases.push({ textStart, textEnd, header });
  }

  outBuf[outPos++] = 0x5b; // '['
  for (let ci = 0; ci < cases.length; ci++) {
    const { textStart, textEnd, header } = cases[ci];
    if (ci > 0) outBuf[outPos++] = COMMA;
    const caseStartOutPos = outPos;
    const res = emitCase(inBuf, textStart, textEnd, header, outBuf, outPos);
    if (res.fallback) {
      outPos = caseStartOutPos;
      fallbackCases++;
      const text = JSON.parse('"' + inBuf.subarray(textStart, textEnd).toString('utf8') + '"');
      const ans = coldRun({ text, header });
      outPos += outBuf.write(JSON.stringify(ans), outPos, 'utf8');
    } else {
      outPos = res.outPos;
    }
  }
  outBuf[outPos++] = 0x5d; // ']'
  return { outPos, fallbackCases };
}

// ---------------------------------------------------------------------------
// Fast path: parse one case's CSV (raw bytes [textStart, textEnd)) and emit
// {"columns":...,"rows":...,"errors":...} directly to outBuf.
// Returns { outPos } or { fallback: true }.
// ---------------------------------------------------------------------------
function emitCase(inBuf, textStart, textEnd, header, outBuf, outPos0) {
  let outPos = outPos0;
  let p = textStart;
  if (p + 2 < textEnd && inBuf[p] === 0xef && inBuf[p + 1] === 0xbb && inBuf[p + 2] === 0xbf) p += 3; // BOM

  const errors = [];
  let line = 1;
  let width = -1;
  let rowsWritten = 0;
  let columnsDone = false;

  // Per-record error context (set by parseRecord before parsing fields).
  let recLine = 1;
  let recRow = null;
  // Whether the field currently being parsed started with a quote.
  let curFieldQuoted = false;

  function copySpan(a, b) {
    if (b > a) { inBuf.copy(outBuf, outPos, a, b); outPos += (b - a); }
  }

  // JSON-decode a raw byte range [a,b) that holds pure field content with
  // JSON escapes. Only used for extra (beyond-width) fields, which are rare.
  function jsonDecodeRaw(a, b) {
    if (b <= a) return '';
    const raw = inBuf.subarray(a, b).toString('utf8');
    if (raw.indexOf('\\') === -1) return raw;
    return JSON.parse('"' + raw + '"');
  }

  // ---- field parsers ----
  // field(isExtra): dispatch quoted vs unquoted. Returns ended (0/1/2),
  // 'fallback', or { ended, val } for extra fields.
  function field(isExtra) {
    curFieldQuoted = (p + 1 < textEnd && inBuf[p] === BS && inBuf[p + 1] === QUOTE);
    if (curFieldQuoted) return fieldQuoted(isExtra);
    return fieldUnquoted(isExtra, false);
  }

  // Unquoted field. cont=true means the JSON string is already open in
  // outBuf (junk continuation after a closing quote): no quotes are written.
  function fieldUnquoted(isExtra, cont) {
    if (isExtra) return fieldExtraUnquoted();
    if (!cont) outBuf[outPos++] = QUOTE;
    for (;;) {
      let nc = inBuf.indexOf(COMMA, p);
      if (nc === -1 || nc >= textEnd) nc = -1;
      let nb = inBuf.indexOf(BS, p);
      if (nb === -1 || nb >= textEnd) nb = -1;
      if (nc === -1 && nb === -1) {
        copySpan(p, textEnd);
        p = textEnd;
        if (!cont) outBuf[outPos++] = QUOTE;
        return 2;
      }
      if (nb === -1 || (nc !== -1 && nc < nb)) {
        copySpan(p, nc);
        p = nc + 1;
        if (!cont) outBuf[outPos++] = QUOTE;
        return 0;
      }
      copySpan(p, nb);
      const e = inBuf[nb + 1];
      if (e === ESC_n) {
        p = nb + 2; line += 1;
        if (!cont) outBuf[outPos++] = QUOTE;
        return 1;
      }
      if (e === ESC_r) {
        if (inBuf[nb + 2] === BS && inBuf[nb + 3] === ESC_n) {
          p = nb + 4; line += 1;
          if (!cont) outBuf[outPos++] = QUOTE;
          return 1;
        }
        errors.push({ code: 'stray_cr', line: recLine, row: recRow });
        p = nb + 2;
        continue;
      }
      if (e === QUOTE || e === BS || e === ESC_t || e === ESC_b || e === ESC_f) {
        outBuf[outPos++] = BS; outBuf[outPos++] = e; p = nb + 2; continue;
      }
      if (e === ESC_SLASH) { outBuf[outPos++] = 0x2f; p = nb + 2; continue; }
      return 'fallback'; // \uXXXX or unknown escape
    }
  }

  // Decode an extra (beyond-width) unquoted field to a JS string.
  function fieldExtraUnquoted() {
    let s = '';
    for (;;) {
      let nc = inBuf.indexOf(COMMA, p);
      if (nc === -1 || nc >= textEnd) nc = -1;
      let nb = inBuf.indexOf(BS, p);
      if (nb === -1 || nb >= textEnd) nb = -1;
      if (nc === -1 && nb === -1) {
        s += jsonDecodeRaw(p, textEnd);
        p = textEnd;
        return { ended: 2, val: s };
      }
      if (nb === -1 || (nc !== -1 && nc < nb)) {
        s += jsonDecodeRaw(p, nc);
        p = nc + 1;
        return { ended: 0, val: s };
      }
      s += jsonDecodeRaw(p, nb);
      const e = inBuf[nb + 1];
      if (e === ESC_n) { p = nb + 2; line += 1; return { ended: 1, val: s }; }
      if (e === ESC_r) {
        if (inBuf[nb + 2] === BS && inBuf[nb + 3] === ESC_n) {
          p = nb + 4; line += 1; return { ended: 1, val: s };
        }
        errors.push({ code: 'stray_cr', line: recLine, row: recRow });
        p = nb + 2;
        continue;
      }
      if (e === QUOTE || e === BS || e === ESC_t || e === ESC_b || e === ESC_f || e === ESC_SLASH) {
        s += jsonDecodeRaw(nb, nb + 2);
        p = nb + 2;
        continue;
      }
      return 'fallback';
    }
  }

  // Quoted field. The opening \" is at p.
  function fieldQuoted(isExtra) {
    if (isExtra) return fieldExtraQuoted();
    const open = p;
    const openLine = line;
    const fieldStartOut = outPos;
    outBuf[outPos++] = QUOTE;
    p = open + 2;
    for (;;) {
      let nb = inBuf.indexOf(BS, p);
      if (nb === -1 || nb >= textEnd) {
        // Unterminated: roll back, emit a literal quote, re-parse as unquoted.
        outPos = fieldStartOut;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recLine, row: recRow });
        outBuf[outPos++] = QUOTE;
        outBuf[outPos++] = BS;
        outBuf[outPos++] = QUOTE;
        p = open + 2;
        const r = fieldUnquoted(false, true);
        if (r === 'fallback') return 'fallback';
        outBuf[outPos++] = QUOTE;
        return r;
      }
      copySpan(p, nb);
      const e = inBuf[nb + 1];
      if (e === QUOTE) {
        if (inBuf[nb + 2] === BS && inBuf[nb + 3] === QUOTE) {
          outBuf[outPos++] = BS; outBuf[outPos++] = QUOTE; p = nb + 4; continue;
        }
        p = nb + 2;
        break; // closing quote
      }
      if (e === ESC_n) {
        outBuf[outPos++] = BS; outBuf[outPos++] = ESC_n; p = nb + 2; line += 1; continue;
      }
      if (e === ESC_r) {
        if (inBuf[nb + 2] === BS && inBuf[nb + 3] === ESC_n) { p = nb + 4; }
        else { p = nb + 2; }
        outBuf[outPos++] = BS; outBuf[outPos++] = ESC_n; line += 1; continue;
      }
      if (e === BS || e === ESC_t || e === ESC_b || e === ESC_f) {
        outBuf[outPos++] = BS; outBuf[outPos++] = e; p = nb + 2; continue;
      }
      if (e === ESC_SLASH) { outBuf[outPos++] = 0x2f; p = nb + 2; continue; }
      return 'fallback';
    }
    // Closed. What follows the closing quote?
    if (p >= textEnd) { outBuf[outPos++] = QUOTE; return 2; }
    const c = inBuf[p];
    if (c === COMMA) { outBuf[outPos++] = QUOTE; p += 1; return 0; }
    if (c === BS && inBuf[p + 1] === ESC_n) { outBuf[outPos++] = QUOTE; p += 2; line += 1; return 1; }
    if (c === BS && inBuf[p + 1] === ESC_r && inBuf[p + 2] === BS && inBuf[p + 3] === ESC_n) {
      outBuf[outPos++] = QUOTE; p += 4; line += 1; return 1;
    }
    // Junk after the closing quote: continue the same JSON string.
    const junkStartOut = outPos;
    const r = fieldUnquoted(false, true);
    if (r === 'fallback') return 'fallback';
    if (outPos > junkStartOut) errors.push({ code: 'quote_junk', line: recLine, row: recRow });
    outBuf[outPos++] = QUOTE;
    return r;
  }

  // Decode an extra (beyond-width) quoted field to a JS string.
  function fieldExtraQuoted() {
    const open = p;
    const openLine = line;
    let s = '';
    p = open + 2;
    for (;;) {
      let nb = inBuf.indexOf(BS, p);
      if (nb === -1 || nb >= textEnd) {
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recLine, row: recRow });
        p = open + 2;
        const r = fieldExtraUnquoted();
        if (r === 'fallback') return 'fallback';
        return { ended: r.ended, val: '"' + r.val };
      }
      s += jsonDecodeRaw(p, nb);
      const e = inBuf[nb + 1];
      if (e === QUOTE) {
        if (inBuf[nb + 2] === BS && inBuf[nb + 3] === QUOTE) {
          s += '"'; p = nb + 4; continue;
        }
        p = nb + 2;
        break;
      }
      if (e === ESC_n) { s += '\n'; p = nb + 2; line += 1; continue; }
      if (e === ESC_r) {
        if (inBuf[nb + 2] === BS && inBuf[nb + 3] === ESC_n) { p = nb + 4; }
        else { p = nb + 2; }
        s += '\n'; line += 1; continue;
      }
      if (e === BS || e === ESC_t || e === ESC_b || e === ESC_f || e === ESC_SLASH) {
        s += jsonDecodeRaw(nb, nb + 2); p = nb + 2; continue;
      }
      return 'fallback';
    }
    if (p >= textEnd) return { ended: 2, val: s };
    const c = inBuf[p];
    if (c === COMMA) { p += 1; return { ended: 0, val: s }; }
    if (c === BS && inBuf[p + 1] === ESC_n) { p += 2; line += 1; return { ended: 1, val: s }; }
    if (c === BS && inBuf[p + 1] === ESC_r && inBuf[p + 2] === BS && inBuf[p + 3] === ESC_n) {
      p += 4; line += 1; return { ended: 1, val: s };
    }
    const beforeLen = s.length;
    const r = fieldExtraUnquoted();
    if (r === 'fallback') return 'fallback';
    s += r.val;
    if (s.length > beforeLen) errors.push({ code: 'quote_junk', line: recLine, row: recRow });
    return { ended: r.ended, val: s };
  }

  // ---- one record ----
  // Returns { st: 'record', n } | { st: 'empty' } | { st: 'fallback' }.
  function parseRecord(isColumns) {
    recLine = line;
    recRow = (!header || columnsDone) ? rowsWritten : null;
    const rowOutStart = outPos;
    if (!isColumns && rowsWritten > 0) outBuf[outPos++] = COMMA;
    outBuf[outPos++] = 0x5b; // '['
    let n = 0;
    let widthEndOut = -1;
    let extraVals = null;
    let firstFieldQuoted = false;
    let firstFieldLen = 0;
    let ended = 0;

    for (;;) {
      const isExtra = width >= 0 && n >= width;
      const fStart = outPos;
      if (isExtra) {
        if (extraVals === null) extraVals = [];
        const er = field(true);
        if (er === 'fallback') return { st: 'fallback' };
        extraVals.push(er.val);
        ended = er.ended;
      } else {
        const r = field(false);
        if (r === 'fallback') return { st: 'fallback' };
        ended = r;
        if (n === 0) { firstFieldQuoted = curFieldQuoted; firstFieldLen = outPos - fStart; }
        if (width >= 0 && n + 1 === width) widthEndOut = outPos;
      }
      n++;
      if (ended === 0) {
        if (!isExtra) outBuf[outPos++] = COMMA;
        continue;
      }
      break;
    }

    // Stray-CR-only line: a single empty unquoted field -> no record
    // (its stray_cr errors stay).
    if (n === 1 && firstFieldLen === 2 && !firstFieldQuoted) {
      outPos = rowOutStart;
      return { st: 'empty' };
    }

    if (width < 0) width = n;
    if (!isColumns && n > width) {
      outPos = widthEndOut;
      errors.push({ code: 'long_row', line: recLine, row: recRow, extra: extraVals || [] });
    } else if (!isColumns && n < width) {
      errors.push({ code: 'short_row', line: recLine, row: recRow, fields: n });
      for (let i = n; i < width; i++) {
        outBuf[outPos++] = COMMA;
        outBuf[outPos++] = QUOTE;
        outBuf[outPos++] = QUOTE;
      }
    }
    outBuf[outPos++] = 0x5d; // ']'
    return { st: 'record', n };
  }

  function skipEmptyLines() {
    for (;;) {
      if (p + 1 < textEnd && inBuf[p] === BS && inBuf[p + 1] === ESC_n) { p += 2; line += 1; continue; }
      if (p + 3 < textEnd && inBuf[p] === BS && inBuf[p + 1] === ESC_r && inBuf[p + 2] === BS && inBuf[p + 3] === ESC_n) {
        p += 4; line += 1; continue;
      }
      break;
    }
  }

  // Write '{"columns":'
  outBuf[outPos++] = 0x7b; // '{'
  outBuf[outPos++] = QUOTE;
  outPos += outBuf.write('columns', outPos);
  outBuf[outPos++] = QUOTE;
  outBuf[outPos++] = 0x3a; // ':'

  if (header) {
    for (;;) {
      skipEmptyLines();
      if (p >= textEnd) {
        outBuf[outPos++] = 0x5b; outBuf[outPos++] = 0x5d; // []
        columnsDone = true;
        break;
      }
      const r = parseRecord(true);
      if (r.st === 'fallback') return { fallback: true };
      if (r.st === 'empty') continue;
      columnsDone = true;
      break;
    }
    outBuf[outPos++] = COMMA;
    outBuf[outPos++] = QUOTE;
    outPos += outBuf.write('rows', outPos);
    outBuf[outPos++] = QUOTE;
    outBuf[outPos++] = 0x3a;
    outBuf[outPos++] = 0x5b; // '['
  } else {
    outBuf[outPos++] = 0x6e; outBuf[outPos++] = 0x75; outBuf[outPos++] = 0x6c; outBuf[outPos++] = 0x6c; // null
    outBuf[outPos++] = COMMA;
    outBuf[outPos++] = QUOTE;
    outPos += outBuf.write('rows', outPos);
    outBuf[outPos++] = QUOTE;
    outBuf[outPos++] = 0x3a;
    outBuf[outPos++] = 0x5b; // '['
  }

  for (;;) {
    skipEmptyLines();
    if (p >= textEnd) break;
    const r = parseRecord(false);
    if (r.st === 'fallback') return { fallback: true };
    if (r.st === 'empty') continue;
    rowsWritten++;
  }

  // '],"errors":' + JSON.stringify(errors) + '}'
  outBuf[outPos++] = 0x5d; // ']'
  outBuf[outPos++] = COMMA;
  outBuf[outPos++] = QUOTE;
  outPos += outBuf.write('errors', outPos);
  outBuf[outPos++] = QUOTE;
  outBuf[outPos++] = 0x3a;
  outPos += outBuf.write(JSON.stringify(errors), outPos, 'utf8');
  outBuf[outPos++] = 0x7d; // '}'
  return { outPos };
}
