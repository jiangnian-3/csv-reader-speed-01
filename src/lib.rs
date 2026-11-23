#![deny(unsafe_op_in_unsafe_fn)]

mod csv;
mod json;

use std::alloc::{alloc, dealloc, Layout};
use std::ptr::copy_nonoverlapping;

fn input_layout(units: u32) -> Layout {
    Layout::array::<u16>(units.max(1) as usize).expect("input is too large")
}

fn output_layout(bytes: u32) -> Layout {
    Layout::array::<u8>(bytes.max(1) as usize).expect("output is too large")
}

#[unsafe(no_mangle)]
pub extern "C" fn alloc_input(units: u32) -> *mut u16 {
    // SAFETY: the host frees this allocation with its original unit count.
    let ptr = unsafe { alloc(input_layout(units)) }.cast::<u16>();
    assert!(!ptr.is_null(), "input allocation failed");
    // SAFETY: the allocation covers at least one unit and is writable.
    unsafe { ptr.write_bytes(0, units.max(1) as usize) };
    ptr
}

/// # Safety
/// `ptr` and `units` must be an outstanding allocation returned by `alloc_input`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn free_input(ptr: *mut u16, units: u32) {
    // SAFETY: the host returns the original pointer and exact layout once.
    unsafe { dealloc(ptr.cast::<u8>(), input_layout(units)) };
}

/// Return a packed `(byte_length << 32) | byte_pointer` for one owned UTF-8 value.
///
/// # Safety
/// The host must supply an initialized, outstanding input allocation of this size.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn run_csv(ptr: *const u16, units: u32, header: u32) -> u64 {
    // SAFETY: this only borrows the input for the duration of the call.
    let text = unsafe { std::slice::from_raw_parts(ptr, units as usize) };
    let result = csv::parse(text, header != 0);
    let bytes = result.len() as u32;
    // SAFETY: the host frees this allocation with the returned byte count.
    let output = unsafe { alloc(output_layout(bytes)) };
    assert!(!output.is_null(), "output allocation failed");
    // SAFETY: output has at least result.len() bytes; the regions do not overlap.
    unsafe { copy_nonoverlapping(result.as_ptr(), output, result.len()) };
    let addr = output as u32;
    (u64::from(bytes) << 32) | u64::from(addr)
}

/// # Safety
/// `ptr` and `bytes` must describe an outstanding output allocation from `run_csv`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn free_output(ptr: *mut u8, bytes: u32) {
    // SAFETY: the host returns the original pointer and exact layout once.
    unsafe { dealloc(ptr, output_layout(bytes)) };
}
