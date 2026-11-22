class ObjectSink {
  beginAnswer(header) {
    this.header = header;
    this.columns = null;
    this.rows = [];
    this.errors = [];
  }

  beginRecord(kind) {
    this.kind = kind;
    this.fields = [];
    this.extra = [];
  }

  beginField(isExtra) {
    this.isExtra = isExtra;
    this.parts = [];
  }

  appendSpan(text, start, end) {
    if (end > start) this.parts.push(text.slice(start, end));
  }

  appendText(value) {
    if (value) this.parts.push(value);
  }

  endField() {
    const value = this.parts.join("");
    (this.isExtra ? this.extra : this.fields).push(value);
    this.parts = null;
  }

  addError(code, line, row, fieldCount, width) {
    if (code === "short_row") {
      this.errors.push({ code, line, row, fields: fieldCount });
    } else if (code === "long_row") {
      this.errors.push({ code, line, row, extra: this.extra.slice() });
    } else {
      this.errors.push({ code, line, row });
    }
  }

  endRecord(kind, fieldCount, width) {
    if (kind === "columns") {
      this.columns = this.fields;
      return;
    }
    while (this.fields.length < width) this.fields.push("");
    this.rows.push(this.fields);
  }

  endAnswer() {
    return {
      columns: this.header ? (this.columns ?? []) : null,
      rows: this.rows,
      errors: this.errors,
    };
  }
}

class ByteWriter {
  constructor(writeChunk) {
    this.writeChunk = writeChunk;
    this.buffer = Buffer.allocUnsafe(65536);
    this.used = 0;
  }

  flush() {
    if (this.used === 0) return;
    this.writeChunk(this.buffer.subarray(0, this.used));
    this.used = 0;
  }

  byte(value) {
    if (this.used === this.buffer.length) this.flush();
    this.buffer[this.used++] = value;
  }

  ascii(value) {
    for (let i = 0; i < value.length; i++) this.byte(value.charCodeAt(i));
  }

  codePoint(value) {
    if (value < 0x80) {
      this.byte(value);
    } else if (value < 0x800) {
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
    this.jsonContent(text, start, end);
    this.byte(34);
  }

  jsonText(value) {
    this.byte(34);
    this.jsonContent(value, 0, value.length);
    this.byte(34);
  }

  // Write JSON escapes directly from UTF-16 spans, including lone surrogates.
  jsonContent(text, start, end) {
    for (let i = start; i < end; i++) {
      const code = text.charCodeAt(i);
      if (code === 34) this.ascii('\\"');
      else if (code === 92) this.ascii("\\\\");
      else if (code === 8) this.ascii("\\b");
      else if (code === 9) this.ascii("\\t");
      else if (code === 10) this.ascii("\\n");
      else if (code === 12) this.ascii("\\f");
      else if (code === 13) this.ascii("\\r");
      else if (code < 0x20) {
        this.ascii("\\u00");
        this.hexByte(code);
      } else if (code >= 0xd800 && code <= 0xdbff) {
        const low = i + 1 < end ? text.charCodeAt(i + 1) : 0;
        if (low >= 0xdc00 && low <= 0xdfff) {
          this.codePoint(0x10000 + ((code - 0xd800) << 10) + low - 0xdc00);
          i++;
        } else {
          this.unicodeEscape(code);
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        this.unicodeEscape(code);
      } else {
        this.codePoint(code);
      }
    }
  }

  unicodeEscape(code) {
    this.ascii("\\u");
    this.hexByte(code >> 8);
    this.hexByte(code & 0xff);
  }

  hexByte(value) {
    const hex = "0123456789abcdef";
    this.byte(hex.charCodeAt((value >> 4) & 15));
    this.byte(hex.charCodeAt(value & 15));
  }
}

class JsonSink {
  constructor(writeChunk) {
    this.writer = new ByteWriter(writeChunk);
    this.caseCount = 0;
  }

  beginOutput() {
    this.writer.ascii("[");
  }

  beginCase() {
    if (this.caseCount++) this.writer.ascii(",");
  }

  beginAnswer(header) {
    this.header = header;
    this.errors = [];
    this.rowCount = 0;
    this.rowsStarted = !header;
    this.writer.ascii('{"columns":');
    if (header) {
      this.columnsStarted = false;
    } else {
      this.writer.ascii('null,"rows":[');
    }
  }

  beginRecord(kind) {
    this.kind = kind;
    this.visibleCount = 0;
    this.extraFields = [];
    if (kind === "columns") {
      this.columnsStarted = true;
      this.writer.ascii("[");
    } else {
      if (!this.rowsStarted) {
        this.writer.ascii('],"rows":[');
        this.rowsStarted = true;
      }
      if (this.rowCount) this.writer.ascii(",");
      this.writer.ascii("[");
    }
  }

  beginField(isExtra) {
    this.isExtra = isExtra;
    if (isExtra) {
      this.parts = [];
      return;
    }
    if (this.visibleCount) this.writer.ascii(",");
    this.writer.byte(34);
  }

  appendSpan(text, start, end) {
    if (this.isExtra) {
      if (end > start) this.parts.push(text.slice(start, end));
    } else {
      this.writer.jsonContent(text, start, end);
    }
  }

  appendText(value) {
    if (this.isExtra) {
      if (value) this.parts.push(value);
    } else {
      this.writer.jsonContent(value, 0, value.length);
    }
  }

  endField() {
    if (this.isExtra) {
      this.extraFields.push(this.parts.join(""));
      this.parts = null;
    } else {
      this.writer.byte(34);
      this.visibleCount++;
    }
  }

  addError(code, line, row, fieldCount) {
    if (code === "short_row") {
      this.errors.push({ code, line, row, fields: fieldCount });
    } else if (code === "long_row") {
      this.errors.push({ code, line, row, extra: this.extraFields.slice() });
    } else {
      this.errors.push({ code, line, row });
    }
  }

  endRecord(kind, fieldCount, width) {
    if (kind === "columns") {
      this.writer.ascii('],"rows":[');
      this.rowsStarted = true;
      return;
    }
    for (let i = fieldCount; i < width; i++) this.writer.ascii(',""');
    this.writer.byte(93);
    this.rowCount++;
  }

  endAnswer() {
    if (this.header && !this.columnsStarted) this.writer.ascii('[],"rows":[');
    this.writer.ascii('],"errors":[');
    for (let i = 0; i < this.errors.length; i++) {
      if (i) this.writer.ascii(",");
      const value = JSON.stringify(this.errors[i]);
      for (let j = 0; j < value.length; j++) {
        const code = value.charCodeAt(j);
        if (code >= 0xd800 && code <= 0xdbff) {
          const low = j + 1 < value.length ? value.charCodeAt(j + 1) : 0;
          if (low >= 0xdc00 && low <= 0xdfff) {
            this.writer.codePoint(0x10000 + ((code - 0xd800) << 10) + low - 0xdc00);
            j++;
            continue;
          }
        }
        this.writer.codePoint(code);
      }
    }
    this.writer.ascii("]}");
  }

  endOutput() {
    this.writer.ascii("]");
    this.writer.flush();
  }
}

function createJsonSink(writeChunk) {
  return new JsonSink(writeChunk);
}

function parseInto(input, sink) {
  const FIELD_SEPARATOR = /[\r\n,]/g;
  const QUOTED_SPECIAL = /["\r\n]/g;
  const text = String(input.text);
  const header = input.header === true;
  const length = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let width = -1;
  let rows = 0;
  let hasColumns = false;
  let recordLine = 1;
  let recordRow = null;
  let recordKind = "row";
  let fieldEnded = 0;

  sink.beginAnswer(header);

  const readUnquoted = (initial = "", countAdded = false) => {
    if (initial) sink.appendText(initial);
    let start = pos;
    let scan = pos;
    let added = 0;
    while (true) {
      FIELD_SEPARATOR.lastIndex = scan;
      const match = FIELD_SEPARATOR.exec(text);
      if (!match) {
        sink.appendSpan(text, start, length);
        if (countAdded) added += length - start;
        pos = length;
        fieldEnded = 2;
        return added;
      }
      const end = match.index;
      const code = text.charCodeAt(end);
      if (code === 13 && text.charCodeAt(end + 1) !== 10) {
        sink.appendSpan(text, start, end);
        if (countAdded) added += end - start;
        sink.addError("stray_cr", recordLine, recordRow);
        scan = end + 1;
        start = scan;
        continue;
      }
      sink.appendSpan(text, start, end);
      if (countAdded) added += end - start;
      if (code === 44) {
        pos = end + 1;
        fieldEnded = 0;
      } else if (code === 13) {
        pos = end + 2;
        line++;
        fieldEnded = 1;
      } else if (code === 10) {
        pos = end + 1;
        line++;
        fieldEnded = 1;
      } else {
        pos = end;
        fieldEnded = 0;
      }
      return added;
    }
  };

  const readQuoted = () => {
    const open = pos;
    const openLine = line;
    let scan = open + 1;
    let close = -1;
    let hasEscape = false;
    while (scan < length) {
      const next = text.indexOf('"', scan);
      if (next === -1) break;
      if (text.charCodeAt(next + 1) === 34) {
        hasEscape = true;
        scan = next + 2;
      } else {
        close = next;
        break;
      }
    }

    if (close === -1) {
      pos = open + 1;
      line = openLine;
      sink.addError("unterminated_quote", recordLine, recordRow);
      sink.appendText('"');
      readUnquoted();
      return;
    }

    const contentStart = open + 1;
    const firstCr = text.indexOf("\r", contentStart);
    const firstLf = text.indexOf("\n", contentStart);
    const hasNewline = (firstCr !== -1 && firstCr < close) || (firstLf !== -1 && firstLf < close);
    if (!hasEscape && !hasNewline) {
      sink.appendSpan(text, contentStart, close);
    } else {
      let cursor = contentStart;
      while (cursor < close) {
        QUOTED_SPECIAL.lastIndex = cursor;
        const match = QUOTED_SPECIAL.exec(text);
        if (!match || match.index >= close) {
          sink.appendSpan(text, cursor, close);
          break;
        }
        const next = match.index;
        const code = text.charCodeAt(next);
        sink.appendSpan(text, cursor, next);
        if (code === 34) {
          sink.appendText('"');
          cursor = next + 2;
        } else if (code === 13) {
          sink.appendText("\n");
          line++;
          cursor = text.charCodeAt(next + 1) === 10 ? next + 2 : next + 1;
        } else {
          sink.appendText("\n");
          line++;
          cursor = next + 1;
        }
      }
    }

    pos = close + 1;
    if (pos >= length) {
      fieldEnded = 2;
      return;
    }
    const code = text.charCodeAt(pos);
    if (code === 44) {
      pos++;
      fieldEnded = 0;
    } else if (code === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line++;
      fieldEnded = 1;
    } else if (code === 10) {
      pos++;
      line++;
      fieldEnded = 1;
    } else {
      const added = readUnquoted("", true);
      if (added > 0) sink.addError("quote_junk", recordLine, recordRow);
    }
  };

  while (true) {
    while (pos < length) {
      const code = text.charCodeAt(pos);
      if (code === 10) {
        pos++;
        line++;
      } else if (code === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= length) break;

    if (text.charCodeAt(pos) === 13) {
      let end = pos;
      while (end < length && text.charCodeAt(end) === 13) end++;
      if (end === length || text.charCodeAt(end) === 10) {
        recordLine = line;
        recordRow = header && !hasColumns ? null : rows;
        const strayCount = end - pos - (end < length ? 1 : 0);
        for (let i = 0; i < strayCount; i++) sink.addError("stray_cr", recordLine, recordRow);
        pos = end < length ? end + 1 : end;
        if (end < length) line++;
        continue;
      }
    }

    recordLine = line;
    recordKind = header && !hasColumns ? "columns" : "row";
    recordRow = recordKind === "columns" ? null : rows;
    sink.beginRecord(recordKind);
    let fields = 0;
    do {
      const isExtra = recordKind === "row" && width >= 0 && fields >= width;
      sink.beginField(isExtra);
      if (text.charCodeAt(pos) === 34) {
        readQuoted();
      } else {
        readUnquoted();
      }
      sink.endField();
      fields++;
    } while (fieldEnded === 0);

    if (recordKind === "columns") {
      width = fields;
      hasColumns = true;
    } else {
      if (width < 0) width = fields;
      if (fields < width) sink.addError("short_row", recordLine, recordRow, fields, width);
      else if (fields > width) sink.addError("long_row", recordLine, recordRow, fields, width);
      rows++;
    }
    sink.endRecord(recordKind, fields, width);
  }

  return sink.endAnswer();
}

// The one-argument API materializes the public object; main uses the same parser with a streaming sink.
export function run(input, sink = null) {
  const output = sink ?? new ObjectSink();
  const answer = parseInto(input, output);
  return sink === null ? answer : undefined;
}

export { createJsonSink };
