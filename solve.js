// Fast drop-in for csv-reader 1.0.0: returns exactly the same answer for every
// input, but scans with indexOf jumps and slice instead of one character at a
// time. Mirrors vendor/csv-reader (the reference) line for line in behaviour:
//
//   - a U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it one quote, each CRLF or lone CR inside it read as
//     LF; what follows its closing quote, up to the next comma or line break,
//     is appended as it stands (quote_junk, when the field ends); a quote that
//     never closes is a literal character and the text after it is read again
//     as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded (short_row) or cut (long_row) to the
//     first record's width;
//   - each error is {code, line, row}, in the order met; line the 1-based line
//     its record starts on, row its record's index in rows (null for header).
//
// How a field ended: 0 = comma, 1 = line break, 2 = end of text.

const COMMA = 44; // ','
const QUOTE = 34; // '"'
const LF = 10; // '\n'
const CR = 13; // '\r'

/** csv-reader 1.0.0's answer for one case's input {text, header}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  // How the last field ended: 0 = comma, 1 = line break, 2 = end of text.
  // Set by readUnquoted/readQuoted; helpers return the value string only,
  // so no per-field result object is allocated (709k fields per set).
  let ended = 0;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Errors met while reading it carry these.
  let recordLine = 1;
  let recordRow = null;

  // Reads an unquoted field starting at pos, onto `initial` ('' for a plain
  // field, the quoted value for the junk after a closing quote). Returns the
  // value string and sets `ended` (0 = comma, 1 = line break, 2 = end of
  // text). The span up to the next
  // comma or line break is sliced first, so a search for CRs never runs past
  // the field's own end.
  function readUnquoted(initial) {
    let value = initial;
    for (;;) {
      const c = text.indexOf(',', pos);
      const l = text.indexOf('\n', pos);
      let end;
      let isComma;
      if (c === -1) {
        end = l === -1 ? n : l;
        isComma = false;
      } else if (l === -1) {
        end = c;
        isComma = true;
      } else if (c < l) {
        end = c;
        isComma = true;
      } else {
        end = l;
        isComma = false;
      }
      const span = text.slice(pos, end);
      const r = span.indexOf('\r');
      if (r === -1) {
        value += span;
        if (isComma) {
          pos = end + 1;
          ended = 0; return value;
        }
        if (end < n) {
          pos = end + 1;
          line += 1;
          ended = 1; return value;
        }
        pos = end;
        ended = 2; return value;
      }
      if (r === span.length - 1 && !isComma && end < n) {
        // CRLF: the CR is part of the line break, not the field.
        value += span.slice(0, -1);
        pos = end + 1;
        line += 1;
        ended = 1; return value;
      }
      // Lone CR(s) in the span: each is dropped (stray_cr). A CR at the
      // span's very end is the CRLF's CR when the span ends at a line break,
      // and is dropped without an error. The span's end is still the field's
      // end: a dropped CR moves no delimiter after it.
      const lastIsCrlf = !isComma && end < n && span.charCodeAt(span.length - 1) === CR;
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
      if (isComma) {
        pos = end + 1;
        ended = 0; return value;
      }
      if (end < n) {
        pos = end + 1;
        line += 1;
        ended = 1; return value;
      }
      pos = end;
      ended = 2; return value;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Returns the value
  // string and sets `ended` (see readUnquoted).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const parts = [];
    pos += 1;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      // The chunk before the quote: convert each CRLF or lone CR inside it
      // to LF and count the lines it spans (a chunk with no line break is
      // appended as it stands).
      const chunk = text.slice(pos, q);
      if (chunk.indexOf('\r') === -1 && chunk.indexOf('\n') === -1) {
        parts.push(chunk);
      } else {
        const converted = chunk.replace(/\r\n?/g, '\n');
        let breaks = 0;
        for (let i = 0; i < converted.length; i++) if (converted.charCodeAt(i) === LF) breaks += 1;
        line += breaks;
        parts.push(converted);
      }
      if (text.charCodeAt(q + 1) === QUOTE) {
        // A doubled quote: one quote in the value, and the field goes on.
        parts.push('"');
        pos = q + 2;
        continue;
      }
      // The closing quote.
      pos = q + 1;
      const value = parts.join('');
      if (pos >= n) { ended = 2; return value; }
      const c = text.charCodeAt(pos);
      if (c === COMMA) {
        pos += 1;
        ended = 0; return value;
      }
      if (c === LF) {
        pos += 1;
        line += 1;
        ended = 1; return value;
      }
      if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
        ended = 1; return value;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      const junkValue = readUnquoted(value);
      if (junkValue.length > value.length) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      return junkValue;
    }
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === LF) {
        pos += 1;
        line += 1;
      } else if (c === CR && text.charCodeAt(pos + 1) === LF) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === QUOTE;
      fields.push(quoted ? readQuoted() : readUnquoted(''));
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
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
