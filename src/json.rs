pub(crate) fn number(out: &mut Vec<u8>, mut value: usize) {
    let mut digits = [0; 10]; // wasm32 usize has at most ten decimal digits.
    let mut pos = digits.len();
    loop {
        pos -= 1;
        digits[pos] = b'0' + (value % 10) as u8;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    out.extend_from_slice(&digits[pos..]);
}

fn escape(out: &mut Vec<u8>, unit: u16) {
    let hex = b"0123456789abcdef";
    out.extend_from_slice(&[
        b'\\', b'u', hex[usize::from(unit >> 12)], hex[usize::from((unit >> 8) & 15)],
        hex[usize::from((unit >> 4) & 15)], hex[usize::from(unit & 15)],
    ]);
}

fn scalar(out: &mut Vec<u8>, code: u32) {
    let mut encoded = [0; 4];
    let ch = char::from_u32(code).expect("JSON emitter received a non-scalar");
    out.extend_from_slice(ch.encode_utf8(&mut encoded).as_bytes());
}

// A field can join spans across a discarded CR or closing quote. Hold a high
// surrogate until the next *emitted* unit is known, rather than escaping it at a span break.
#[inline]
pub(crate) fn unit(out: &mut Vec<u8>, pending: &mut u16, value: u16) {
    if *pending != 0 {
        let high = std::mem::take(pending);
        if (0xdc00..=0xdfff).contains(&value) {
            scalar(out, 0x10000 + (u32::from(high - 0xd800) << 10) + u32::from(value - 0xdc00));
            return;
        }
        escape(out, high);
    }
    match value {
        0x22 => out.extend_from_slice(b"\\\""),
        0x5c => out.extend_from_slice(b"\\\\"),
        8 => out.extend_from_slice(b"\\b"),
        9 => out.extend_from_slice(b"\\t"),
        10 => out.extend_from_slice(b"\\n"),
        12 => out.extend_from_slice(b"\\f"),
        13 => out.extend_from_slice(b"\\r"),
        0..=31 | 0xdc00..=0xdfff => escape(out, value),
        32..=127 => out.push(value as u8),
        0xd800..=0xdbff => *pending = value,
        _ => scalar(out, u32::from(value)),
    }
}

pub(crate) fn span(out: &mut Vec<u8>, units: &[u16], pending: &mut u16) {
    for &value in units {
        unit(out, pending, value);
    }
}

pub(crate) fn end_string(out: &mut Vec<u8>, pending: u16) {
    if pending != 0 {
        escape(out, pending);
    }
    out.push(b'"');
}
