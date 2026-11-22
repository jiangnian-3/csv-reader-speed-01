export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  const error = (code) => errors.push({ code, line: recordLine, row: recordRow });

  function readUnquoted(initial, countAdded = false) {
    let start = pos;
    let scan = pos;
    let chunks = null;
    let added = 0;

    while (scan < text.length) {
      const comma = text.indexOf(',', scan);
      const lf = text.indexOf('\n', scan);
      const cr = text.indexOf('\r', scan);
      let end = text.length;
      let kind = 0;
      if (comma !== -1 && comma < end) {
        end = comma;
        kind = 1;
      }
      if (lf !== -1 && lf < end) {
        end = lf;
        kind = 2;
      }
      if (cr !== -1 && cr < end) {
        end = cr;
        kind = 3;
      }

      if (kind === 0) {
        if (countAdded) added += text.length - start;
        if (chunks) chunks.push(text.slice(start));
        pos = text.length;
        return { value: chunks ? chunks.join('') : initial + text.slice(start), ended: 2, added };
      }

      if (kind === 3 && text.charCodeAt(end + 1) !== 10) {
        if (chunks === null) chunks = [initial];
        chunks.push(text.slice(start, end));
        if (countAdded) added += end - start;
        error('stray_cr');
        scan = end + 1;
        start = scan;
        pos = scan;
        continue;
      }

      if (chunks) chunks.push(text.slice(start, end));
      if (countAdded) added += end - start;
      const value = chunks ? chunks.join('') : initial + text.slice(start, end);
      if (kind === 1) {
        pos = end + 1;
        return { value, ended: 0, added };
      }
      if (kind === 2) {
        pos = end + 1;
        line += 1;
        return { value, ended: 1, added };
      }
      pos = end + 2;
      line += 1;
      return { value, ended: 1, added };
    }

    if (countAdded) added += text.length - start;
    if (chunks) chunks.push(text.slice(start));
    pos = text.length;
    return { value: chunks ? chunks.join('') : initial + text.slice(start), ended: 2, added };
  }

  function readQuoted() {
    const open = pos;
    const openLine = line;
    let quote = text.indexOf('"', open + 1);
    let close = -1;
    while (quote !== -1) {
      if (text.charCodeAt(quote + 1) === 34) {
        quote = text.indexOf('"', quote + 2);
      } else {
        close = quote;
        break;
      }
    }

    if (close === -1) {
      pos = open + 1;
      line = openLine;
      error('unterminated_quote');
      return readUnquoted('"');
    }

    let value;
    const contentStart = open + 1;
    const firstQuote = text.indexOf('"', contentStart);
    const firstCr = text.indexOf('\r', contentStart);
    const firstLf = text.indexOf('\n', contentStart);
    const hasEscape = firstQuote !== -1 && firstQuote < close;
    const hasCr = firstCr !== -1 && firstCr < close;
    const hasLf = firstLf !== -1 && firstLf < close;

    if (!hasEscape && !hasCr) {
      value = text.slice(contentStart, close);
      if (hasLf) {
        let newline = firstLf;
        while (newline < close) {
          line += 1;
          newline = text.indexOf('\n', newline + 1);
          if (newline === -1) break;
        }
      }
    } else {
      const chunks = [];
      let cursor = contentStart;
      while (cursor < close) {
        const q = text.indexOf('"', cursor);
        const cr = text.indexOf('\r', cursor);
        const lf = text.indexOf('\n', cursor);
        let next = close;
        let kind = 0;
        if (q !== -1 && q < next) {
          next = q;
          kind = 1;
        }
        if (cr !== -1 && cr < next) {
          next = cr;
          kind = 2;
        }
        if (lf !== -1 && lf < next) {
          next = lf;
          kind = 3;
        }
        chunks.push(text.slice(cursor, next));
        if (kind === 0) break;
        if (kind === 1) {
          chunks.push('"');
          cursor = next + 2;
        } else if (kind === 2) {
          chunks.push('\n');
          line += 1;
          cursor = next + (text.charCodeAt(next + 1) === 10 ? 2 : 1);
        } else {
          chunks.push('\n');
          line += 1;
          cursor = next + 1;
        }
      }
      value = chunks.join('');
    }

    pos = close + 1;
    if (pos === text.length) return { value, ended: 2 };

    const next = text.charCodeAt(pos);
    if (next === 44) {
      pos += 1;
      return { value, ended: 0 };
    }
    if (next === 10) {
      pos += 1;
      line += 1;
      return { value, ended: 1 };
    }
    if (next === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: 1 };
    }

    const junk = readUnquoted(value, true);
    if (junk.added > 0) error('quote_junk');
    return junk;
  }

  while (true) {
    while (pos < text.length) {
      if (text.charCodeAt(pos) === 10) {
        pos += 1;
        line += 1;
      } else if (text.charCodeAt(pos) === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= text.length) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === 0);

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
