// solve.v6.2.js — v6.1 restructured for cold-start: flat (module-level) hot
// functions + fast setup + TurboFan priming + inlined unquoted path.
// Semantics identical to v6.1 (same byte-exact output); only the code shape
// changed. Measured (30 ronde interleaved fresh-process, gross median):
// v6.1 622k -> v6.2 final ~356k (-43%); net (minus do-nothing control)
// 478k -> ~200k (-58%). Full variant log: ~/workspace/makefun/tmp/v62-report.md
//
// Design (each piece measured; losers documented in the report):
//  - RESTRUCTURE (biggest single win, -22%): v6.1's hot functions were
//    closures recreated inside emitCase() per case, so JIT warmup/deopt
//    churn was repaid per case (cold parse ~430-447k vs warm floor ~156k).
//    All hot functions are now module-level: one identity, warmed once,
//    shared by all 6 cases. A cheap synthetic prime then trains the exact
//    functions the real parse uses.
//  - PRIME 10x1 (10 records x 1 rep, ~4k): the sweet spot. 0x0 is +13%
//    worse; 10x3/20x2/50x5 are all worse (prime cost exceeds the gain;
//    bigger primes also seem to over-specialize feedback -> more deopts).
//    9 deopt events total after priming (vs 14 unprimed), all "insufficient
//    type feedback" eager deopts, no deopt loop.
//  - FAST SETUP (~16k vs ~45k warm / ~69k cold): one scan for '"text"'
//    + one scan for '","header":'. The '","header":' needle provably cannot
//    match inside a JSON string (its 3rd byte 0x22 would need a preceding
//    0x5C but is preceded by 0x2C), so the first occurrence at/after a
//    textStart is that case's textEnd. Any verification failure -> exact
//    v6.1 slow path (key order / whitespace variants fall back correctly).
//    NOTE: a lastIndexOf shortcut was rejected — it can return a LATER
//    case's boundary if a non-adjacent key sits between text and header.
//  - S1 (-17%): fieldUnquoted no longer calls indexOf(COMMA) per field;
//    the scan loop already visits every byte, so detecting COMMA in-loop
//    is nearly free and saves one native call (~50-80ns) per unquoted field.
//  - S2 (-5%): the unquoted fast path is inlined into parseRecord (saves
//    field()+fieldUnquoted() calls per field; fieldQuoted stays a call).
//  - REJECTED after measurement: SWAR u32 word scan (hasByte test + stores
//    cost more than the byte loop on median-8-byte spans; -9.6% vs S1 is
//    WORSE than plain S1), unroll-4 clean-group check (same compares as
//    the simple loop + group overhead), escape-dispatch extraction S3
//    (+1.3%: a call per escape event eats the compile-time saving).
//  - Alloc 48 MB kept (proven harmless). No BigUint64Array anywhere.
//  - Flag: --max-semi-space-size=128 kept (G1); no-flag is statistically
//    identical, no reason to change.
//
// Byte facts about cases.json (same as v6.1):
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

// Prime tuning (measured; see bench log). Synthetic mini-cases run through
// the real parse path before the real input, training the module-level hot
// functions. Small prime transfers fully because the functions are shared.
const PRIME_NREC = 10;
const PRIME_REPS = 1;

const NEEDLE_TEXT = Buffer.from('"text"');
const NEEDLE_HDREND = Buffer.from('","header":');

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
// Outer-JSON helpers (slow setup path).
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
// Module-level hot state (shared by all cases; set by emitCase per case).
// ---------------------------------------------------------------------------
let G_in = null;      // input Buffer
let G_out = null;     // output Buffer
let G_p = 0;          // input cursor within [textStart, textEnd)
let G_op = 0;         // output cursor
let G_te = 0;         // textEnd
let G_line = 1;
let G_width = -1;
let G_err = null;     // errors array for this case
let G_rline = 1;      // current record's line
let G_rrow = null;    // current record's row
let G_cq = false;     // current field started with a quote
let G_rows = 0;       // rows written in this case
let G_colDone = false;
let G_hdr = false;

// JSON-decode a raw byte range [a,b) that holds pure field content with
// JSON escapes. Only used for extra (beyond-width) fields, which are rare.
function jsonDecodeRaw(a, b) {
  if (b <= a) return '';
  const raw = G_in.subarray(a, b).toString('utf8');
  if (raw.indexOf('\\') === -1) return raw;
  return JSON.parse('"' + raw + '"');
}

// ---- field parsers ----
// field(isExtra): dispatch quoted vs unquoted. Returns ended (0/1/2),
// 'fallback', or { ended, val } for extra fields.
function field(isExtra) {
  G_cq = (G_p + 1 < G_te && G_in[G_p] === BS && G_in[G_p + 1] === QUOTE);
  if (G_cq) return fieldQuoted(isExtra);
  return fieldUnquoted(isExtra, false);
}

// Unquoted field. cont=true means the JSON string is already open in
// outBuf (junk continuation after a closing quote): no quotes are written.
function fieldUnquoted(isExtra, cont) {
  if (isExtra) return fieldExtraUnquoted();
  if (!cont) G_out[G_op++] = QUOTE;
  for (;;) {
    // S1: no indexOf(COMMA) — the scan loop already visits every byte, so
    // detecting COMMA in-loop costs ~nothing and saves one native call
    // (~50-80ns) per unquoted field.
    let i = G_p;
    let stop = -1; // 0=comma, 1=backslash, 2=end
    while (i < G_te) {
      const c = G_in[i];
      if (c === COMMA) { stop = 0; break; }
      if (c === BS) { stop = 1; break; }
      G_out[G_op++] = c;
      i++;
    }
    if (stop === -1) {
      G_p = G_te;
      if (!cont) G_out[G_op++] = QUOTE;
      return 2;
    }
    if (stop === 0) {
      G_p = i + 1;
      if (!cont) G_out[G_op++] = QUOTE;
      return 0;
    }
    const nb = i;
    G_p = nb;
    const e = G_in[nb + 1];
    if (e === ESC_n) {
      G_p = nb + 2; G_line += 1;
      if (!cont) G_out[G_op++] = QUOTE;
      return 1;
    }
    if (e === ESC_r) {
      if (G_in[nb + 2] === BS && G_in[nb + 3] === ESC_n) {
        G_p = nb + 4; G_line += 1;
        if (!cont) G_out[G_op++] = QUOTE;
        return 1;
      }
      G_err.push({ code: 'stray_cr', line: G_rline, row: G_rrow });
      G_p = nb + 2;
      continue;
    }
    if (e === QUOTE || e === BS || e === ESC_t || e === ESC_b || e === ESC_f) {
      G_out[G_op++] = BS; G_out[G_op++] = e; G_p = nb + 2; continue;
    }
    if (e === ESC_SLASH) { G_out[G_op++] = 0x2f; G_p = nb + 2; continue; }
    return 'fallback'; // \uXXXX or unknown escape
  }
}

// Decode an extra (beyond-width) unquoted field to a JS string.
function fieldExtraUnquoted() {
  let s = '';
  for (;;) {
    let nc = G_in.indexOf(COMMA, G_p);
    if (nc === -1 || nc >= G_te) nc = -1;
    let nb = G_in.indexOf(BS, G_p);
    if (nb === -1 || nb >= G_te) nb = -1;
    if (nc === -1 && nb === -1) {
      s += jsonDecodeRaw(G_p, G_te);
      G_p = G_te;
      return { ended: 2, val: s };
    }
    if (nb === -1 || (nc !== -1 && nc < nb)) {
      s += jsonDecodeRaw(G_p, nc);
      G_p = nc + 1;
      return { ended: 0, val: s };
    }
    s += jsonDecodeRaw(G_p, nb);
    const e = G_in[nb + 1];
    if (e === ESC_n) { G_p = nb + 2; G_line += 1; return { ended: 1, val: s }; }
    if (e === ESC_r) {
      if (G_in[nb + 2] === BS && G_in[nb + 3] === ESC_n) {
        G_p = nb + 4; G_line += 1; return { ended: 1, val: s };
      }
      G_err.push({ code: 'stray_cr', line: G_rline, row: G_rrow });
      G_p = nb + 2;
      continue;
    }
    if (e === QUOTE || e === BS || e === ESC_t || e === ESC_b || e === ESC_f || e === ESC_SLASH) {
      s += jsonDecodeRaw(nb, nb + 2);
      G_p = nb + 2;
      continue;
    }
    return 'fallback';
  }
}

// Quoted field. The opening \" is at G_p.
function fieldQuoted(isExtra) {
  if (isExtra) return fieldExtraQuoted();
  const open = G_p;
  const openLine = G_line;
  const fieldStartOut = G_op;
  G_out[G_op++] = QUOTE;
  G_p = open + 2;
  for (;;) {
    let nb = -1;
    let i = G_p;
    while (i < G_te) {
      const c = G_in[i];
      if (c === BS) { nb = i; break; }
      G_out[G_op++] = c;
      i++;
    }
    if (nb === -1) {
      // Unterminated: roll back, emit a literal quote, re-parse as unquoted.
      G_op = fieldStartOut;
      G_line = openLine;
      G_err.push({ code: 'unterminated_quote', line: G_rline, row: G_rrow });
      G_out[G_op++] = QUOTE;
      G_out[G_op++] = BS;
      G_out[G_op++] = QUOTE;
      G_p = open + 2;
      const r = fieldUnquoted(false, true);
      if (r === 'fallback') return 'fallback';
      G_out[G_op++] = QUOTE;
      return r;
    }
    G_p = nb;
    const e = G_in[nb + 1];
    if (e === QUOTE) {
      if (G_in[nb + 2] === BS && G_in[nb + 3] === QUOTE) {
        G_out[G_op++] = BS; G_out[G_op++] = QUOTE; G_p = nb + 4; continue;
      }
      G_p = nb + 2;
      break; // closing quote
    }
    if (e === ESC_n) {
      G_out[G_op++] = BS; G_out[G_op++] = ESC_n; G_p = nb + 2; G_line += 1; continue;
    }
    if (e === ESC_r) {
      if (G_in[nb + 2] === BS && G_in[nb + 3] === ESC_n) { G_p = nb + 4; }
      else { G_p = nb + 2; }
      G_out[G_op++] = BS; G_out[G_op++] = ESC_n; G_line += 1; continue;
    }
    if (e === BS || e === ESC_t || e === ESC_b || e === ESC_f) {
      G_out[G_op++] = BS; G_out[G_op++] = e; G_p = nb + 2; continue;
    }
    if (e === ESC_SLASH) { G_out[G_op++] = 0x2f; G_p = nb + 2; continue; }
    return 'fallback';
  }
  // Closed. What follows the closing quote?
  if (G_p >= G_te) { G_out[G_op++] = QUOTE; return 2; }
  const c = G_in[G_p];
  if (c === COMMA) { G_out[G_op++] = QUOTE; G_p += 1; return 0; }
  if (c === BS && G_in[G_p + 1] === ESC_n) { G_out[G_op++] = QUOTE; G_p += 2; G_line += 1; return 1; }
  if (c === BS && G_in[G_p + 1] === ESC_r && G_in[G_p + 2] === BS && G_in[G_p + 3] === ESC_n) {
    G_out[G_op++] = QUOTE; G_p += 4; G_line += 1; return 1;
  }
  // Junk after the closing quote: continue the same JSON string.
  const junkStartOut = G_op;
  const r = fieldUnquoted(false, true);
  if (r === 'fallback') return 'fallback';
  if (G_op > junkStartOut) G_err.push({ code: 'quote_junk', line: G_rline, row: G_rrow });
  G_out[G_op++] = QUOTE;
  return r;
}

// Decode an extra (beyond-width) quoted field to a JS string.
function fieldExtraQuoted() {
  const open = G_p;
  const openLine = G_line;
  let s = '';
  G_p = open + 2;
  for (;;) {
    let nb = G_in.indexOf(BS, G_p);
    if (nb === -1 || nb >= G_te) {
      G_line = openLine;
      G_err.push({ code: 'unterminated_quote', line: G_rline, row: G_rrow });
      G_p = open + 2;
      const r = fieldExtraUnquoted();
      if (r === 'fallback') return 'fallback';
      return { ended: r.ended, val: '"' + r.val };
    }
    s += jsonDecodeRaw(G_p, nb);
    const e = G_in[nb + 1];
    if (e === QUOTE) {
      if (G_in[nb + 2] === BS && G_in[nb + 3] === QUOTE) {
        s += '"'; G_p = nb + 4; continue;
      }
      G_p = nb + 2;
      break;
    }
    if (e === ESC_n) { s += '\n'; G_p = nb + 2; G_line += 1; continue; }
    if (e === ESC_r) {
      if (G_in[nb + 2] === BS && G_in[nb + 3] === ESC_n) { G_p = nb + 4; }
      else { G_p = nb + 2; }
      s += '\n'; G_line += 1; continue;
    }
    if (e === BS || e === ESC_t || e === ESC_b || e === ESC_f || e === ESC_SLASH) {
      s += jsonDecodeRaw(nb, nb + 2); G_p = nb + 2; continue;
    }
    return 'fallback';
  }
  if (G_p >= G_te) return { ended: 2, val: s };
  const c = G_in[G_p];
  if (c === COMMA) { G_p += 1; return { ended: 0, val: s }; }
  if (c === BS && G_in[G_p + 1] === ESC_n) { G_p += 2; G_line += 1; return { ended: 1, val: s }; }
  if (c === BS && G_in[G_p + 1] === ESC_r && G_in[G_p + 2] === BS && G_in[G_p + 3] === ESC_n) {
    G_p += 4; G_line += 1; return { ended: 1, val: s };
  }
  const beforeLen = s.length;
  const r = fieldExtraUnquoted();
  if (r === 'fallback') return 'fallback';
  s += r.val;
  if (s.length > beforeLen) G_err.push({ code: 'quote_junk', line: G_rline, row: G_rrow });
  return { ended: r.ended, val: s };
}

// ---- one record ----
// Returns { st: 'record', n } | { st: 'empty' } | { st: 'fallback' }.
function parseRecord(isColumns) {
  G_rline = G_line;
  G_rrow = (!G_hdr || G_colDone) ? G_rows : null;
  const rowOutStart = G_op;
  if (!isColumns && G_rows > 0) G_out[G_op++] = COMMA;
  G_out[G_op++] = 0x5b; // '['
  let n = 0;
  let widthEndOut = -1;
  let extraVals = null;
  let firstFieldQuoted = false;
  let firstFieldLen = 0;
  let ended = 0;

  for (;;) {
    const isExtra = G_width >= 0 && n >= G_width;
    const fStart = G_op;
    if (isExtra) {
      if (extraVals === null) extraVals = [];
      const er = field(true);
      if (er === 'fallback') return { st: 'fallback' };
      extraVals.push(er.val);
      ended = er.ended;
    } else {
      // S2: inline the unquoted fast path (cont=false, isExtra=false) —
      // saves field()+fieldUnquoted() calls per field (the majority are
      // unquoted) and gives TurboFan one fewer hot function to compile.
      // fieldQuoted stays a call (rarer); fieldUnquoted stays a function
      // for fieldQuoted's junk-continuation path (cont=true).
      G_cq = (G_p + 1 < G_te && G_in[G_p] === BS && G_in[G_p + 1] === QUOTE);
      if (G_cq) {
        const r = fieldQuoted(false);
        if (r === 'fallback') return { st: 'fallback' };
        ended = r;
      } else {
        G_out[G_op++] = QUOTE;
        let fEnded = -1;
        fieldLoop: for (;;) {
          let i = G_p;
          let stop = -1;
          while (i < G_te) {
            const c = G_in[i];
            if (c === COMMA) { stop = 0; break; }
            if (c === BS) { stop = 1; break; }
            G_out[G_op++] = c;
            i++;
          }
          if (stop === -1) { G_p = G_te; G_out[G_op++] = QUOTE; fEnded = 2; break fieldLoop; }
          if (stop === 0) { G_p = i + 1; G_out[G_op++] = QUOTE; fEnded = 0; break fieldLoop; }
          const nb = i;
          G_p = nb;
          const e = G_in[nb + 1];
          if (e === ESC_n) { G_p = nb + 2; G_line += 1; G_out[G_op++] = QUOTE; fEnded = 1; break fieldLoop; }
          if (e === ESC_r) {
            if (G_in[nb + 2] === BS && G_in[nb + 3] === ESC_n) { G_p = nb + 4; G_line += 1; G_out[G_op++] = QUOTE; fEnded = 1; break fieldLoop; }
            G_err.push({ code: 'stray_cr', line: G_rline, row: G_rrow });
            G_p = nb + 2;
            continue fieldLoop;
          }
          if (e === QUOTE || e === BS || e === ESC_t || e === ESC_b || e === ESC_f) {
            G_out[G_op++] = BS; G_out[G_op++] = e; G_p = nb + 2; continue fieldLoop;
          }
          if (e === ESC_SLASH) { G_out[G_op++] = 0x2f; G_p = nb + 2; continue fieldLoop; }
          return { st: 'fallback' };
        }
        ended = fEnded;
      }
      if (n === 0) { firstFieldQuoted = G_cq; firstFieldLen = G_op - fStart; }
      if (G_width >= 0 && n + 1 === G_width) widthEndOut = G_op;
    }
    n++;
    if (ended === 0) {
      if (!isExtra) G_out[G_op++] = COMMA;
      continue;
    }
    break;
  }

  // Stray-CR-only line: a single empty unquoted field -> no record
  // (its stray_cr errors stay).
  if (n === 1 && firstFieldLen === 2 && !firstFieldQuoted) {
    G_op = rowOutStart;
    return { st: 'empty' };
  }

  if (G_width < 0) G_width = n;
  if (!isColumns && n > G_width) {
    G_op = widthEndOut;
    G_err.push({ code: 'long_row', line: G_rline, row: G_rrow, extra: extraVals || [] });
  } else if (!isColumns && n < G_width) {
    G_err.push({ code: 'short_row', line: G_rline, row: G_rrow, fields: n });
    for (let i = n; i < G_width; i++) {
      G_out[G_op++] = COMMA;
      G_out[G_op++] = QUOTE;
      G_out[G_op++] = QUOTE;
    }
  }
  G_out[G_op++] = 0x5d; // ']'
  return { st: 'record', n };
}

function skipEmptyLines() {
  for (;;) {
    if (G_p + 1 < G_te && G_in[G_p] === BS && G_in[G_p + 1] === ESC_n) { G_p += 2; G_line += 1; continue; }
    if (G_p + 3 < G_te && G_in[G_p] === BS && G_in[G_p + 1] === ESC_r && G_in[G_p + 2] === BS && G_in[G_p + 3] === ESC_n) {
      G_p += 4; G_line += 1; continue;
    }
    break;
  }
}

// ---------------------------------------------------------------------------
// Fast path: parse one case's CSV (raw bytes [textStart, textEnd)) and emit
// {"columns":...,"rows":...,"errors":...} directly to outBuf.
// Returns { outPos } or { fallback: true }.
// ---------------------------------------------------------------------------
function emitCase(inBuf, textStart, textEnd, header, outBuf, outPos0) {
  G_in = inBuf; G_out = outBuf; G_te = textEnd; G_hdr = header;
  G_op = outPos0;
  G_p = textStart;
  if (G_p + 2 < G_te && G_in[G_p] === 0xef && G_in[G_p + 1] === 0xbb && G_in[G_p + 2] === 0xbf) G_p += 3; // BOM

  G_err = [];
  G_line = 1;
  G_width = -1;
  G_rows = 0;
  G_colDone = false;
  G_rline = 1;
  G_rrow = null;
  G_cq = false;

  // Write '{"columns":'
  G_out[G_op++] = 0x7b; // '{'
  G_out[G_op++] = QUOTE;
  G_op += G_out.write('columns', G_op);
  G_out[G_op++] = QUOTE;
  G_out[G_op++] = 0x3a; // ':'

  if (header) {
    for (;;) {
      skipEmptyLines();
      if (G_p >= G_te) {
        G_out[G_op++] = 0x5b; G_out[G_op++] = 0x5d; // []
        G_colDone = true;
        break;
      }
      const r = parseRecord(true);
      if (r.st === 'fallback') return { fallback: true };
      if (r.st === 'empty') continue;
      G_colDone = true;
      break;
    }
    G_out[G_op++] = COMMA;
    G_out[G_op++] = QUOTE;
    G_op += G_out.write('rows', G_op);
    G_out[G_op++] = QUOTE;
    G_out[G_op++] = 0x3a;
    G_out[G_op++] = 0x5b; // '['
  } else {
    G_out[G_op++] = 0x6e; G_out[G_op++] = 0x75; G_out[G_op++] = 0x6c; G_out[G_op++] = 0x6c; // null
    G_out[G_op++] = COMMA;
    G_out[G_op++] = QUOTE;
    G_op += G_out.write('rows', G_op);
    G_out[G_op++] = QUOTE;
    G_out[G_op++] = 0x3a;
    G_out[G_op++] = 0x5b; // '['
  }

  for (;;) {
    skipEmptyLines();
    if (G_p >= G_te) break;
    const r = parseRecord(false);
    if (r.st === 'fallback') return { fallback: true };
    if (r.st === 'empty') continue;
    G_rows++;
  }

  // '],"errors":' + JSON.stringify(errors) + '}'
  G_out[G_op++] = 0x5d; // ']'
  G_out[G_op++] = COMMA;
  G_out[G_op++] = QUOTE;
  G_op += G_out.write('errors', G_op);
  G_out[G_op++] = QUOTE;
  G_out[G_op++] = 0x3a;
  G_op += G_out.write(JSON.stringify(G_err), G_op, 'utf8');
  G_out[G_op++] = 0x7d; // '}'
  return { outPos: G_op };
}

// ---------------------------------------------------------------------------
// Setup: resolve each case's text range + header value.
// Fast path first (two native needle scans); any doubt -> v6.1 slow path.
// ---------------------------------------------------------------------------
function tryFastSetup(inBuf, N) {
  const starts = [];
  let p = 0;
  for (;;) {
    const t = inBuf.indexOf(NEEDLE_TEXT, p);
    if (t === -1) break;
    starts.push(t);
    p = t + 1;
  }
  if (starts.length === 0) return null;
  const ends = [];
  p = 0;
  for (;;) {
    const t = inBuf.indexOf(NEEDLE_HDREND, p);
    if (t === -1) break;
    ends.push(t);
    p = t + 1;
  }
  if (ends.length !== starts.length) return null;
  const cases = [];
  for (let i = 0; i < starts.length; i++) {
    const tk = starts[i];
    if (inBuf[tk + 6] !== 0x3a || inBuf[tk + 7] !== QUOTE) return null;
    const textStart = tk + 8;
    const q = ends[i];
    if (q <= textStart) return null;
    if (i + 1 < starts.length && q >= starts[i + 1]) return null;
    // Closing-quote parity: a quote preceded by an odd run of backslashes
    // is escaped and cannot be the terminator.
    let bs = 0, j = q - 1;
    while (j >= textStart && inBuf[j] === BS) { bs++; j--; }
    if ((bs & 1) !== 0) return null;
    const hv = inBuf[q + 11];
    if (hv !== 0x74 && hv !== 0x66) return null; // 't' / 'f'
    const vlen = hv === 0x74 ? 4 : 5;
    let k = q + 11 + vlen;
    while (k < N && (inBuf[k] === 0x20 || inBuf[k] === 0x09 || inBuf[k] === 0x0a || inBuf[k] === 0x0d)) k++;
    if (inBuf[k] !== 0x7d) return null; // input object must close '}' here
    cases.push({ textStart, textEnd: q, header: hv === 0x74 });
  }
  return cases;
}

// Exact v6.1 setup (proven correct for arbitrary key order / whitespace).
function slowSetup(inBuf, N) {
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
    // prevEnd = textEnd of the LAST pushed case (not cases[i-1]: a skipped
    // "text" occurrence (e.g. inside an id value) leaves cases shorter than i).
    const prevEnd = cases.length > 0 ? cases[cases.length - 1].textEnd : 0;
    const nextTk = i + 1 < textKeys.length ? textKeys[i + 1] : N;
    let header = false;
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
  return cases;
}

// ---------------------------------------------------------------------------
// Main entry: process a whole raw cases.json Buffer, write answers.json bytes.
// Returns { outPos, fallbackCases }. outBuf must be large enough.
// ---------------------------------------------------------------------------
function parseAll(inBuf, outBuf) {
  const N = inBuf.length;
  let outPos = 0;
  let fallbackCases = 0;

  let cases = tryFastSetup(inBuf, N);
  if (cases === null) cases = slowSetup(inBuf, N);

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
// TurboFan priming: synthetic mini-cases through the REAL parse path.
// Trains fieldUnquoted / fieldQuoted / fieldExtra* / parseRecord / emitCase
// (and the setup code) before the real input, so the real parse starts warm.
// Deterministic (seeded PRNG); exercises quoted, unquoted, escapes, junk,
// short/long rows, stray CR, empty lines, header true/false, BOM-less text.
// ---------------------------------------------------------------------------
function buildSynthText(nRec, nFields) {
  let seed = 0x12345678;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const WORDS = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet','kilo','lima','metro','november','oscar','papa','quebec','romeo','sierra','tango','uniform','victor','whiskey','xray','yankee','zulu','12345','67890','2024-01-15','99.95','hello world','foo bar baz','a,b','x"y','a"b"c','semi;colon','under_score','dash-thing','café','naïve','smörgås','Москва','Ωμέγα'];
  function field() {
    const r = rnd();
    if (r < 0.45) {
      let s = pick(WORDS); if (rnd() < 0.3) s += ' ' + pick(WORDS); return s;
    } else if (r < 0.75) {
      let inner = pick(WORDS); if (rnd() < 0.4) inner += ', ' + pick(WORDS); if (rnd() < 0.2) inner += '"q"'; if (rnd() < 0.2) inner += '\nline2';
      let f = '"' + inner.replace(/"/g, '""') + '"';
      if (rnd() < 0.08) f += 'junk';
      return f;
    } else if (r < 0.85) { return ''; }
    else if (r < 0.92) { return '"' + pick(WORDS) + '"'; }
    return pick(WORDS);
  }
  function record(nf) { const fs = []; for (let i = 0; i < nf; i++) fs.push(field()); return fs.join(','); }
  let text = '';
  const hdr = []; for (let i = 0; i < nFields; i++) hdr.push('col_' + i);
  text += hdr.join(',') + '\n';
  for (let r = 0; r < nRec; r++) {
    let nf = nFields;
    if (rnd() < 0.05) nf = nFields - 2; else if (rnd() < 0.05) nf = nFields + 2;
    text += record(nf) + (rnd() < 0.7 ? '\n' : '\r\n');
    if (rnd() < 0.03) text += '\n';
  }
  text += 'tail1,tail2\rwith-cr,"unterminated\n';
  return text;
}

let G_primed = false;
let G_synthIn = null;
let G_synthOut = null;

function doPrime() {
  if (G_synthIn === null) {
    const text = buildSynthText(PRIME_NREC, 10);
    const cases = [
      { id: 'p1', input: { header: true, text } },
      { id: 'p2', input: { header: false, text: text.slice(0, (text.length / 2) | 0) } },
    ];
    G_synthIn = Buffer.from(JSON.stringify(cases), 'utf8');
    G_synthOut = Buffer.allocUnsafe(1 << 20);
  }
  for (let i = 0; i < PRIME_REPS; i++) parseAll(G_synthIn, G_synthOut);
}

export function runCases(inBuf, outBuf) {
  if (!G_primed) { G_primed = true; doPrime(); }
  return parseAll(inBuf, outBuf);
}
