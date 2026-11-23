use crate::json;
use core::arch::wasm32::*;

const DELIM: u16 = b',' as u16;
const QUOTE: u16 = b'"' as u16;
const CR: u16 = b'\r' as u16;
const LF: u16 = b'\n' as u16;

#[inline]
fn next_special<const QUOTED: bool>(text: &[u16], mut pos: usize) -> usize {
    while text.len() - pos >= 8 {
        // SAFETY: eight UTF-16 units are present; v128_load permits unaligned loads.
        let lanes = unsafe { v128_load(text.as_ptr().add(pos).cast()) };
        let breaks = i16x8_bitmask(v128_or(
            i16x8_eq(lanes, u16x8_splat(CR)),
            i16x8_eq(lanes, u16x8_splat(LF)),
        ));
        let separators = if QUOTED {
            i16x8_bitmask(i16x8_eq(lanes, u16x8_splat(QUOTE)))
        } else {
            i16x8_bitmask(i16x8_eq(lanes, u16x8_splat(DELIM)))
        };
        let selected = breaks | separators;
        if selected != 0 {
            return pos + selected.trailing_zeros() as usize;
        }
        pos += 8;
    }
    let separator = if QUOTED { QUOTE } else { DELIM };
    while let Some(&c) = text.get(pos) {
        if c == separator || c == CR || c == LF {
            break;
        }
        pos += 1;
    }
    pos
}

#[derive(Clone, Copy)]
struct RecordSite {
    line: usize,
    row: Option<usize>,
}

impl RecordSite {
    fn error(self, errors: &mut Vec<u8>, code: &[u8]) {
        if !errors.is_empty() {
            errors.push(b',');
        }
        errors.extend_from_slice(b"{\"code\":\"");
        errors.extend_from_slice(code);
        errors.extend_from_slice(b"\",\"line\":");
        json::number(errors, self.line);
        errors.extend_from_slice(b",\"row\":");
        match self.row {
            Some(row) => json::number(errors, row),
            None => errors.extend_from_slice(b"null"),
        }
    }

    fn simple(self, errors: &mut Vec<u8>, code: &[u8]) {
        self.error(errors, code);
        errors.push(b'}');
    }
}

struct Csv<'a> {
    text: &'a [u16],
    pos: usize,
    line: usize,
    errors: Vec<u8>,
}

impl Csv<'_> {
    #[inline]
    fn at(&self, pos: usize) -> u16 {
        self.text.get(pos).copied().unwrap_or(0)
    }

    // Blank records do not claim a column/row slot. Any discarded CRs still
    // carry the current record's line and would-be row index.
    fn skip_empty_lines(&mut self, row: Option<usize>) {
        while self.pos < self.text.len() {
            match self.at(self.pos) {
                LF => {
                    self.pos += 1;
                    self.line += 1;
                }
                CR => {
                    let mut end = self.pos + 1;
                    while self.at(end) == CR {
                        end += 1;
                    }
                    let lf = self.at(end) == LF;
                    if !lf && end < self.text.len() {
                        break;
                    }
                    let site = RecordSite { line: self.line, row };
                    for _ in self.pos..end - usize::from(lf) {
                        site.simple(&mut self.errors, b"stray_cr");
                    }
                    self.pos = end + usize::from(lf);
                    self.line += usize::from(lf);
                }
                _ => break,
            }
        }
    }

    // Emit one field. The return value says whether the delimiter starts
    // another field (including a final empty field at EOF).
    fn field(&mut self, out: &mut Vec<u8>, site: RecordSite) -> bool {
        out.push(b'"');
        let mut pending = 0;
        let mut after_quote = false;
        if self.at(self.pos) == QUOTE {
            let body = self.pos + 1;
            let saved_line = self.line;
            let saved_output = out.len();
            self.pos = body;
            loop {
                let hit = next_special::<true>(self.text, self.pos);
                if hit == self.text.len() {
                    // Invalidate only this speculative field, not any prior error or field.
                    out.truncate(saved_output);
                    self.pos = body;
                    self.line = saved_line;
                    pending = 0;
                    site.simple(&mut self.errors, b"unterminated_quote");
                    json::unit(out, &mut pending, QUOTE);
                    break;
                }
                json::span(out, &self.text[self.pos..hit], &mut pending);
                let c = self.text[hit];
                let next = self.at(hit + 1);
                self.pos = hit + 1;
                match c {
                    QUOTE if next != QUOTE => {
                        after_quote = true;
                        break;
                    }
                    QUOTE => {
                        json::unit(out, &mut pending, QUOTE);
                        self.pos += 1;
                    }
                    CR | LF => {
                        json::unit(out, &mut pending, LF);
                        self.pos += usize::from(c == CR && next == LF);
                        self.line += 1;
                    }
                    _ => unreachable!(),
                }
            }
        }

        let mut junk = false;
        let more = loop {
            let hit = next_special::<false>(self.text, self.pos);
            if self.pos != hit {
                json::span(out, &self.text[self.pos..hit], &mut pending);
                junk = true;
            }
            self.pos = hit;
            if hit == self.text.len() {
                break false;
            }
            self.pos += 1;
            match self.text[hit] {
                DELIM => break true,
                LF => {
                    self.line += 1;
                    break false;
                }
                CR if self.at(self.pos) == LF => {
                    self.pos += 1;
                    self.line += 1;
                    break false;
                }
                CR => site.simple(&mut self.errors, b"stray_cr"),
                _ => unreachable!(),
            }
        };
        if after_quote && junk {
            site.simple(&mut self.errors, b"quote_junk");
        }
        json::end_string(out, pending);
        more
    }
}

pub(crate) fn parse(text: &[u16], header: bool) -> Vec<u8> {
    let mut csv = Csv {
        text,
        pos: usize::from(text.first() == Some(&0xfeff)),
        line: 1,
        errors: Vec::new(),
    };
    let mut out = Vec::with_capacity(text.len().saturating_add(text.len() / 4).max(64));
    out.extend_from_slice(b"{\"columns\":");
    if !header {
        out.extend_from_slice(b"null,\"rows\":[");
    }
    let mut width = None;
    let mut rows = 0;
    let mut extra = Vec::new();
    loop {
        let columns = header && width.is_none();
        let row = (!columns).then_some(rows);
        csv.skip_empty_lines(row);
        if csv.pos == text.len() {
            if columns {
                out.extend_from_slice(b"[],\"rows\":[");
            }
            break;
        }
        let site = RecordSite { line: csv.line, row };
        if rows != 0 {
            out.push(b',');
        }
        out.push(b'[');
        extra.clear();
        let mut count = 0;
        loop {
            let (dst, has_previous) = match width {
                Some(w) if count >= w => (&mut extra, count > w),
                _ => (&mut out, count > 0),
            };
            if has_previous {
                dst.push(b',');
            }
            let more = csv.field(dst, site);
            count += 1;
            if !more {
                break;
            }
        }
        let w = *width.get_or_insert(count);
        if columns {
            out.extend_from_slice(b"],\"rows\":[");
        } else {
            if count < w {
                site.error(&mut csv.errors, b"short_row");
                csv.errors.extend_from_slice(b",\"fields\":");
                json::number(&mut csv.errors, count);
                csv.errors.push(b'}');
                for _ in count..w {
                    out.extend_from_slice(b",\"\"");
                }
            } else if count > w {
                site.error(&mut csv.errors, b"long_row");
                csv.errors.extend_from_slice(b",\"extra\":[");
                csv.errors.extend_from_slice(&extra);
                csv.errors.extend_from_slice(b"]}");
            }
            out.push(b']');
            rows += 1;
        }
    }
    out.extend_from_slice(b"],\"errors\":[");
    out.extend_from_slice(&csv.errors);
    out.extend_from_slice(b"]}");
    out
}
