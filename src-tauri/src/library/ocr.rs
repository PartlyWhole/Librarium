//! Text recognition with Apple Vision (accurate, with language correction and automatic
//! language). Pictures are read directly; scanned PDF pages are rendered with CoreGraphics at
//! about 200 dpi first. Line boxes are fractions of the page or picture, from the top left.

use crate::error::{Error, Result};
use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_core_graphics::CGImage;
use objc2_foundation::{NSArray, NSDictionary, NSString, NSURL};
use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel};
use serde_json::{json, Value};
use std::ffi::c_void;
use std::path::Path;

pub const EXTRACTOR: &str = "apple-vision";
pub const VERSION: u32 = 1;

fn bad(m: impl std::fmt::Display) -> Error {
    Error::invalid(format!("the text couldn’t be recognised: {m}"))
}

/// Runs text recognition on a prepared handler: lines, top to bottom.
fn run(handler: &VNImageRequestHandler) -> Result<Vec<Value>> {
    let req = VNRecognizeTextRequest::new();
    req.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
    req.setUsesLanguageCorrection(true);
    req.setAutomaticallyDetectsLanguage(true);
    let as_request: &VNRequest = &req;
    handler.performRequests_error(&NSArray::from_slice(&[as_request])).map_err(|e| bad(e.localizedDescription()))?;
    let mut lines = vec![];
    if let Some(results) = req.results() {
        for obs in results.iter() {
            let Some(best) = obs.topCandidates(1).firstObject() else { continue };
            // SAFETY: a plain getter on a live observation.
            let b = unsafe { obs.boundingBox() };
            lines.push(json!({
                "text": best.string().to_string(),
                "confidence": best.confidence(),
                "x": b.origin.x, "y": 1.0 - (b.origin.y + b.size.height), "w": b.size.width, "h": b.size.height,
            }));
        }
    }
    lines.sort_by(|a, b| {
        let (ay, by) = (a["y"].as_f64().unwrap_or(0.0), b["y"].as_f64().unwrap_or(0.0));
        if (ay - by).abs() > 0.01 {
            ay.partial_cmp(&by).unwrap()
        } else {
            a["x"].as_f64().partial_cmp(&b["x"].as_f64()).unwrap()
        }
    });
    Ok(lines)
}

fn page_of(n: u32, lines: Vec<Value>) -> Value {
    let text = lines.iter().filter_map(|l| l["text"].as_str()).collect::<Vec<_>>().join("\n");
    json!({ "page": n, "text": text, "lines": lines })
}

/// The text of a picture, as one page.
pub fn image(path: &Path) -> Result<Value> {
    objc2::rc::autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        // SAFETY: a file URL and an empty options dictionary are valid.
        let handler: Retained<VNImageRequestHandler> = unsafe {
            VNImageRequestHandler::initWithURL_options(VNImageRequestHandler::alloc(), &url, &NSDictionary::new())
        };
        Ok(page_of(1, run(&handler)?))
    })
}

// CoreGraphics, for rendering PDF pages (C API).
#[repr(C)]
#[derive(Clone, Copy)]
struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPDFDocumentCreateWithURL(url: *const c_void) -> *mut c_void;
    fn CGPDFDocumentGetNumberOfPages(doc: *mut c_void) -> usize;
    fn CGPDFDocumentGetPage(doc: *mut c_void, n: usize) -> *mut c_void;
    fn CGPDFDocumentRelease(doc: *mut c_void);
    fn CGPDFPageGetBoxRect(page: *mut c_void, b: i32) -> Rect;
    fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
    fn CGColorSpaceRelease(cs: *mut c_void);
    fn CGBitmapContextCreate(
        data: *mut c_void,
        w: usize,
        h: usize,
        bpc: usize,
        bpr: usize,
        cs: *mut c_void,
        info: u32,
    ) -> *mut c_void;
    fn CGBitmapContextCreateImage(ctx: *mut c_void) -> *mut c_void;
    fn CGContextRelease(ctx: *mut c_void);
    fn CGContextSetRGBFillColor(ctx: *mut c_void, r: f64, g: f64, b: f64, a: f64);
    fn CGContextFillRect(ctx: *mut c_void, r: Rect);
    fn CGContextScaleCTM(ctx: *mut c_void, sx: f64, sy: f64);
    fn CGContextTranslateCTM(ctx: *mut c_void, tx: f64, ty: f64);
    fn CGContextDrawPDFPage(ctx: *mut c_void, page: *mut c_void);
    fn CGImageRelease(img: *mut c_void);
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFURLCreateFromFileSystemRepresentation(
        alloc: *const c_void,
        buf: *const u8,
        len: isize,
        dir: u8,
    ) -> *const c_void;
    fn CFRelease(o: *const c_void);
}

const MEDIA_BOX: i32 = 0;
/// kCGImageAlphaPremultipliedLast | kCGBitmapByteOrder32Big
const RGBA: u32 = 1 | (4 << 12);
/// About 200 dpi: enough for recognition, bounded in memory.
const SCALE: f64 = 200.0 / 72.0;
const MAX_SIDE: f64 = 4000.0;

/// The text of one page of a PDF (1-based), rendered first. `None` when there is no such page.
pub fn pdf_page(path: &Path, n: u32) -> Result<Option<Value>> {
    let p = path.to_string_lossy().into_owned();
    objc2::rc::autoreleasepool(|_| {
        // SAFETY: plain CoreGraphics calls; every object created is released before returning.
        unsafe {
            let url = CFURLCreateFromFileSystemRepresentation(std::ptr::null(), p.as_ptr(), p.len() as isize, 0);
            if url.is_null() {
                return Err(bad("no such file"));
            }
            let doc = CGPDFDocumentCreateWithURL(url);
            CFRelease(url);
            if doc.is_null() {
                return Err(bad("not a PDF"));
            }
            let out = if n >= 1 && n as usize <= CGPDFDocumentGetNumberOfPages(doc) {
                render_and_run(CGPDFDocumentGetPage(doc, n as usize)).map(|lines| lines.map(|l| page_of(n, l)))
            } else {
                Ok(None)
            };
            CGPDFDocumentRelease(doc);
            out
        }
    })
}

/// Renders a page into a bitmap and recognises its text (`None` if it can't be drawn).
///
/// # Safety
/// `page` must be a live page of an open document.
unsafe fn render_and_run(page: *mut c_void) -> Result<Option<Vec<Value>>> {
    // SAFETY: the caller's page; every object created here is released here.
    unsafe {
        let r = CGPDFPageGetBoxRect(page, MEDIA_BOX);
        let scale = SCALE.min(MAX_SIDE / r.w.max(r.h).max(1.0));
        let (w, h) = ((r.w * scale).ceil() as usize, (r.h * scale).ceil() as usize);
        let cs = CGColorSpaceCreateDeviceRGB();
        let ctx = CGBitmapContextCreate(std::ptr::null_mut(), w.max(1), h.max(1), 8, 0, cs, RGBA);
        CGColorSpaceRelease(cs);
        if ctx.is_null() {
            return Ok(None);
        }
        CGContextSetRGBFillColor(ctx, 1.0, 1.0, 1.0, 1.0);
        CGContextFillRect(ctx, Rect { x: 0.0, y: 0.0, w: w as f64, h: h as f64 });
        CGContextScaleCTM(ctx, scale, scale);
        CGContextTranslateCTM(ctx, -r.x, -r.y);
        CGContextDrawPDFPage(ctx, page);
        let img = CGBitmapContextCreateImage(ctx);
        CGContextRelease(ctx);
        if img.is_null() {
            return Ok(None);
        }
        let cg: &CGImage = &*(img as *const CGImage);
        let handler: Retained<VNImageRequestHandler> =
            VNImageRequestHandler::initWithCGImage_options(VNImageRequestHandler::alloc(), cg, &NSDictionary::new());
        let lines = run(&handler);
        drop(handler);
        CGImageRelease(img);
        lines.map(Some)
    }
}
