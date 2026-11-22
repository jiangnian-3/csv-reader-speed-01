const SEPARATOR = /[\r\n,]/g;

function findFieldEnd(text, start, sink, recordLine, row) {
  let cursor = start;
  let cleanPrefix = null;
  let fragment = start;

  while (true) {
    SEPARATOR.lastIndex = cursor;
    const match = SEPARATOR.exec(text);
    if (match === null) {
      const end = text.length;
      const cleaned = cleanPrefix === null ? null : cleanPrefix + text.slice(fragment, end);
      return {
        end,
        next: end,
        kind: 'eof',
        cleaned,
        keptLength: cleaned === null ? end - start : cleaned.length,
      };
    }

    const end = match.index;
    const code = text.charCodeAt(end);
    if (code === 13 && text.charCodeAt(end + 1) !== 10) {
      sink.addError('stray_cr', recordLine, row);
      if (cleanPrefix === null) cleanPrefix = text.slice(fragment, end);
      else cleanPrefix += text.slice(fragment, end);
      cursor = end + 1;
      fragment = cursor;
      continue;
    }

    const cleaned = cleanPrefix === null ? null : cleanPrefix + text.slice(fragment, end);
    const keptLength = cleaned === null ? end - start : cleaned.length;
    if (code === 44) {
      return { end, next: end + 1, kind: 'comma', cleaned, keptLength };
    }
    if (code === 13) {
      return { end, next: end + 2, kind: 'record', cleaned, keptLength, lineBreak: true };
    }
    return { end, next: end + 1, kind: 'record', cleaned, keptLength, lineBreak: true };
  }
}

function decodeQuoted(text, start, end, lineState) {
  const parts = [];
  let chunk = start;
  for (let i = start; i < end; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 34) {
      parts.push(text.slice(chunk, i), '"');
      i += 1;
      chunk = i + 1;
    } else if (code === 13) {
      parts.push(text.slice(chunk, i), '\n');
      if (text.charCodeAt(i + 1) === 10) i += 1;
      lineState.line += 1;
      chunk = i + 1;
    } else if (code === 10) {
      parts.push(text.slice(chunk, i), '\n');
      lineState.line += 1;
      chunk = i + 1;
    }
  }
  parts.push(text.slice(chunk, end));
  return parts.join('');
}

function parseField(text, pos, sink, recordLine, row, lineState, isExtra) {
  if (text.charCodeAt(pos) !== 34) {
    const field = findFieldEnd(text, pos, sink, recordLine, row);
    if (field.cleaned === null) sink.rawField(text, pos, field.end, isExtra);
    else sink.textField(field.cleaned, isExtra);
    if (field.lineBreak) lineState.line += 1;
    return field;
  }

  const contentStart = pos + 1;
  let scan = contentStart;
  let close = -1;
  let escapedQuote = false;
  while (scan < text.length) {
    const quote = text.indexOf('"', scan);
    if (quote === -1) break;
    if (text.charCodeAt(quote + 1) === 34) {
      escapedQuote = true;
      scan = quote + 2;
    } else {
      close = quote;
      break;
    }
  }

  if (close === -1) {
    sink.addError('unterminated_quote', recordLine, row);
    const field = findFieldEnd(text, contentStart, sink, recordLine, row);
    const tail = field.cleaned === null ? text.slice(contentStart, field.end) : field.cleaned;
    sink.textField('"' + tail, isExtra);
    if (field.lineBreak) lineState.line += 1;
    return field;
  }

  const cr = text.indexOf('\r', contentStart);
  const lf = text.indexOf('\n', contentStart);
  const hasNewline = (cr !== -1 && cr < close) || (lf !== -1 && lf < close);
  const transformed = escapedQuote || hasNewline;
  let quotedText = null;
  if (transformed) quotedText = decodeQuoted(text, contentStart, close, lineState);

  const tailStart = close + 1;
  const tail = findFieldEnd(text, tailStart, sink, recordLine, row);
  if (tail.keptLength > 0) {
    sink.addError('quote_junk', recordLine, row);
    const quoted = transformed ? quotedText : text.slice(contentStart, close);
    const appended = tail.cleaned === null ? text.slice(tailStart, tail.end) : tail.cleaned;
    sink.textField(quoted + appended, isExtra);
  } else if (transformed) {
    sink.textField(quotedText, isExtra);
  } else {
    sink.rawField(text, contentStart, close, isExtra);
  }
  if (tail.lineBreak) lineState.line += 1;
  return tail;
}

function parseInto(input, sink) {
  const text = String(input.text);
  const header = input.header === true;
  const length = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let width = -1;
  let rowIndex = 0;
  let hasHeader = false;
  let line = 1;

  sink.beginAnswer(header);
  const lineState = { get line() { return line; }, set line(value) { line = value; } };

  while (true) {
    while (pos < length) {
      const code = text.charCodeAt(pos);
      if (code === 10) {
        pos += 1;
        line += 1;
      } else if (code === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= length) break;

    if (text.charCodeAt(pos) === 13) {
      let end = pos;
      while (end < length && text.charCodeAt(end) === 13) end += 1;
      if (end === length || text.charCodeAt(end) === 10) {
        const row = header && !hasHeader ? null : rowIndex;
        const strayCount = end - pos - (end < length ? 1 : 0);
        for (let i = 0; i < strayCount; i += 1) sink.addError('stray_cr', line, row);
        pos = end < length ? end + 1 : end;
        if (end < length) line += 1;
        continue;
      }
    }

    const recordLine = line;
    const isHeader = header && !hasHeader;
    const row = isHeader ? null : rowIndex;
    sink.beginRecord(isHeader);
    let fields = 0;
    let delimiter;
    do {
      const isExtra = !isHeader && width >= 0 && fields >= width;
      const field = parseField(text, pos, sink, recordLine, row, lineState, isExtra);
      pos = field.next;
      delimiter = field.kind;
      fields += 1;
    } while (delimiter === 'comma');

    if (isHeader) {
      width = fields;
      hasHeader = true;
    } else {
      if (width < 0) width = fields;
      if (fields < width) sink.addError('short_row', recordLine, row, fields);
      else if (fields > width) sink.addError('long_row', recordLine, row, null, sink.extraFields());
      rowIndex += 1;
    }
    sink.endRecord(isHeader, fields, width);
  }

  return sink.endAnswer();
}

class ObjectSink {
  beginAnswer(header) {
    this.header = header;
    this.columns = header ? [] : null;
    this.rows = [];
    this.errors = [];
  }

  beginRecord(isHeader) {
    this.isHeader = isHeader;
    this.fields = [];
    this.extras = [];
  }

  rawField(text, start, end, extra) {
    (extra ? this.extras : this.fields).push(text.slice(start, end));
  }

  textField(value, extra) {
    (extra ? this.extras : this.fields).push(value);
  }

  extraFields() {
    return this.extras;
  }

  addError(code, line, row, fields, extra) {
    if (code === 'short_row') this.errors.push({ code, line, row, fields });
    else if (code === 'long_row') this.errors.push({ code, line, row, extra: extra.slice() });
    else this.errors.push({ code, line, row });
  }

  endRecord(isHeader, fields, width) {
    if (isHeader) {
      this.columns = this.fields;
      return;
    }
    while (this.fields.length < width) this.fields.push('');
    this.rows.push(this.fields);
  }

  endAnswer() {
    return { columns: this.columns, rows: this.rows, errors: this.errors };
  }
}

class ByteWriter {
  constructor(writeChunk) {
    this.writeChunk = writeChunk;
    this.bytes = Buffer.allocUnsafe(65536);
    this.used = 0;
  }

  flush() {
    if (this.used === 0) return;
    this.writeChunk(this.bytes.subarray(0, this.used));
    this.used = 0;
  }

  byte(value) {
    if (this.used === this.bytes.length) this.flush();
    this.bytes[this.used++] = value;
  }

  ascii(value) {
    for (let i = 0; i < value.length; i += 1) this.byte(value.charCodeAt(i));
  }

  codePoint(value) {
    if (value < 0x80) this.byte(value);
    else if (value < 0x800) {
      this.byte(0xc0 | (value >> 6));
      this.byte(0x80 | (value & 0x3f));
    } else if (value < 0x10000) {
      this.byte(0xe0 | (value >> 12));
      this.byte(0x80 | ((value >> 6) & 0x3f));
      this.byte(0x80 | (value & 0x3f));
    } else {
      this.byte(0xf0 | (value >> 18));
      this.byte(0x80 | ((value >> 12) & 0x3f));
      this.byte(0x80 | ((value >> 6) & 0x3f));
      this.byte(0x80 | (value & 0x3f));
    }
  }

  jsonSpan(text, start, end) {
    this.byte(34);
    for (let i = start; i < end; i += 1) {
      const code = text.charCodeAt(i);
      if (code === 34) this.ascii('\\"');
      else if (code === 92) this.ascii('\\\\');
      else if (code === 8) this.ascii('\\b');
      else if (code === 9) this.ascii('\\t');
      else if (code === 10) this.ascii('\\n');
      else if (code === 12) this.ascii('\\f');
      else if (code === 13) this.ascii('\\r');
      else if (code < 0x20) {
        this.ascii('\\u00');
        this.hex(code);
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const low = i + 1 < end ? text.charCodeAt(i + 1) : 0;
        if (low >= 0xdc00 && low <= 0xdfff) {
          this.codePoint(0x10000 + ((code - 0xd800) << 10) + low - 0xdc00);
          i += 1;
        } else this.unicode(code);
      } else if (code >= 0xdc00 && code <= 0xdfff) this.unicode(code);
      else this.codePoint(code);
    }
    this.byte(34);
  }

  jsonText(value) {
    this.jsonSpan(value, 0, value.length);
  }

  unicode(code) {
    this.ascii('\\u');
    this.hex(code >> 8);
    this.hex(code & 0xff);
  }

  hex(value) {
    const digits = '0123456789abcdef';
    this.byte(digits.charCodeAt((value >> 4) & 15));
    this.byte(digits.charCodeAt(value & 15));
  }

  serialized(value) {
    const bytes = Buffer.from(value, 'utf8');
    let start = 0;
    while (start < bytes.length) {
      if (this.used === this.bytes.length) this.flush();
      const count = Math.min(this.bytes.length - this.used, bytes.length - start);
      bytes.copy(this.bytes, this.used, start, start + count);
      this.used += count;
      start += count;
    }
  }
}

class JsonSink {
  constructor(writeChunk) {
    this.writer = new ByteWriter(writeChunk);
    this.caseCount = 0;
  }

  beginOutput() {
    this.writer.byte(91);
  }

  beginCase() {
    if (this.caseCount > 0) this.writer.byte(44);
    this.caseCount += 1;
  }

  beginAnswer(header) {
    this.header = header;
    this.columnsStarted = false;
    this.rowsStarted = !header;
    this.rowCount = 0;
    this.errors = [];
    this.writer.ascii('{"columns":');
    if (header) this.columnsStarted = false;
    else this.writer.ascii('null,"rows":[');
  }

  beginRecord(isHeader) {
    this.isHeader = isHeader;
    this.visible = 0;
    this.extras = [];
    if (isHeader) {
      this.columnsStarted = true;
      this.writer.byte(91);
      return;
    }
    if (!this.rowsStarted) {
      this.writer.ascii('],"rows":[');
      this.rowsStarted = true;
    }
    if (this.rowCount > 0) this.writer.byte(44);
    this.writer.byte(91);
  }

  rawField(text, start, end, extra) {
    if (extra) {
      this.extras.push(text.slice(start, end));
      return;
    }
    if (this.visible > 0) this.writer.byte(44);
    this.writer.jsonSpan(text, start, end);
    this.visible += 1;
  }

  textField(value, extra) {
    if (extra) {
      this.extras.push(value);
      return;
    }
    if (this.visible > 0) this.writer.byte(44);
    this.writer.jsonText(value);
    this.visible += 1;
  }

  extraFields() {
    return this.extras;
  }

  addError(code, line, row, fields, extra) {
    if (code === 'short_row') this.errors.push({ code, line, row, fields });
    else if (code === 'long_row') this.errors.push({ code, line, row, extra: extra.slice() });
    else this.errors.push({ code, line, row });
  }

  endRecord(isHeader, fields, width) {
    if (isHeader) {
      this.writer.ascii('],"rows":[');
      this.rowsStarted = true;
      return;
    }
    for (let i = fields; i < width; i += 1) {
      if (this.visible > 0) this.writer.byte(44);
      this.writer.ascii('""');
      this.visible += 1;
    }
    this.writer.byte(93);
    this.rowCount += 1;
  }

  endAnswer() {
    if (this.header && !this.columnsStarted) this.writer.ascii('[],"rows":[');
    this.writer.ascii('],"errors":[');
    for (let i = 0; i < this.errors.length; i += 1) {
      if (i > 0) this.writer.byte(44);
      this.writer.serialized(JSON.stringify(this.errors[i]));
    }
    this.writer.ascii(']}');
  }

  endOutput() {
    this.writer.byte(93);
    this.writer.flush();
  }
}

export function run(input, sink = null) {
  return parseInto(input, sink ?? new ObjectSink());
}

export function createJsonSink(writeChunk) {
  return new JsonSink(writeChunk);
}
