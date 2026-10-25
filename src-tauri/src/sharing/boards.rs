//! Shared boards. A shared board keeps the address of its Automerge document in its record's
//! `sharing.doc`; the document holds the board's elements, each as its Excalidraw JSON under its
//! ID, and each text box's Markdown as Automerge text (so two people typing in one box both keep
//! their words). Of two versions of one element, Excalidraw's rule picks: the higher version,
//! then the lower nonce. Every replica sees the same versions, so every replica picks the same.
//!
//! While a board is open, what arrives goes to the page as a `sharing.board` event and the page
//! saves it with its own changes; while it is closed, it is written to the board's drawing here,
//! and the readable page is rewritten when the board next opens. Pointers and names pass as
//! ephemeral messages (`sharing.presence`), never stored.

use super::block_on;
use crate::boards::{self, SCENE};
use crate::error::{Error, Result};
use crate::store::frontmatter::FmValue;
use crate::store::{files, record, save, Emit, Library};
use crate::types::{SharedBoard, Written};
use crate::util::Id;
use automerge::transaction::Transactable;
use automerge::{AutoCommit, Automerge, ChangeHash, ObjId, ObjType, ReadDoc, ScalarValue, Value as AmValue, ROOT};
use futures::StreamExt;
use samod::{AutomergeUrl, DocHandle, Repo};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The record field holding a shared board's document address (`automerge:…`).
pub const DOC: &str = "sharing.doc";
/// A text box's link (its Markdown is in `customData.librarium.text`).
const TEXT_BOX: &str = "librarium://text";
/// How long opening a shared board waits for the server to hand over its document.
pub(super) const FIND_WAIT: Duration = Duration::from_secs(30);

pub struct Boards {
    lib: Arc<Library>,
    repo: Repo,
    emit: Emit,
    /// Shared boards being followed, by board ID.
    handles: Mutex<HashMap<Id, DocHandle>>,
    /// Boards open in the interface: what arrives goes there instead of to the file.
    /// The pages each is open in (it can be open in two windows or tabs at once).
    open: Mutex<HashMap<Id, HashSet<String>>>,
    stopped: AtomicBool,
}

/// The document address in a link: `librarium://board/<id>`, `automerge:<id>`, or the ID alone.
pub fn parse_link(link: &str) -> Result<AutomergeUrl> {
    let l = link.trim();
    let id = l.strip_prefix("librarium://board/").or_else(|| l.strip_prefix("automerge:")).unwrap_or(l);
    AutomergeUrl::from_str(&format!("automerge:{}", id.trim_end_matches('/')))
        .map_err(|_| Error::invalid("That isn’t a shared board’s link. It looks like librarium://board/…"))
}

/// The link colleagues are sent for a document.
pub fn link_of(url: &AutomergeUrl) -> String {
    format!("librarium://board/{}", url.document_id())
}

/// A message as a CBOR text string: the sync server decodes each passing (ephemeral) message as
/// CBOR before forwarding it, and drops what doesn't decode.
pub(super) fn cbor_text(json: &[u8]) -> Vec<u8> {
    let n = json.len();
    let mut out = match n {
        0..=23 => vec![0x60 | n as u8],
        24..=255 => vec![0x78, n as u8],
        256..=65535 => vec![0x79, (n >> 8) as u8, n as u8],
        _ => vec![0x7a, (n >> 24) as u8, (n >> 16) as u8, (n >> 8) as u8, n as u8],
    };
    out.extend_from_slice(json);
    out
}

/// The text of a CBOR text string (what `cbor_text` makes).
pub(super) fn from_cbor_text(m: &[u8]) -> Option<&[u8]> {
    let skip = match *m.first()? {
        b @ 0x60..=0x77 => return m.get(1..1 + (b & 0x1f) as usize),
        0x78 => 2,
        0x79 => 3,
        0x7a => 5,
        _ => return None,
    };
    m.get(skip..)
}

/// An element's `(version, versionNonce)`.
fn stamp(e: &Value) -> (i64, i64) {
    (e["version"].as_i64().unwrap_or(0), e["versionNonce"].as_i64().unwrap_or(0))
}

/// Excalidraw's rule: does `a` win over `b`? The higher version, then the lower nonce.
fn wins(a: &Value, b: &Value) -> bool {
    let (av, an) = stamp(a);
    let (bv, bn) = stamp(b);
    av > bv || (av == bv && an < bn)
}

fn is_box(e: &Value) -> bool {
    e["link"].as_str() == Some(TEXT_BOX)
}

/// The board's elements and text boxes as the document holds them.
fn read_doc(doc: &impl ReadDoc) -> (Vec<Value>, HashMap<String, String>) {
    let mut elements = Vec::new();
    if let Ok(Some((_, els))) = doc.get(ROOT, "elements") {
        for key in doc.keys(&els) {
            // Every version of the element anyone wrote at once, then Excalidraw's pick.
            let versions = doc.get_all(&els, key.as_str()).unwrap_or_default();
            let parsed = versions.iter().filter_map(|(v, _)| scalar_str(v).and_then(|t| serde_json::from_str::<Value>(&t).ok()));
            if let Some(best) = parsed.reduce(|a, b| if wins(&b, &a) { b } else { a }) {
                elements.push(best);
            }
        }
    }
    let mut boxes = HashMap::new();
    if let Ok(Some((_, bx))) = doc.get(ROOT, "boxes") {
        for key in doc.keys(&bx) {
            if let Ok(Some((_, t))) = doc.get(&bx, key.as_str()) {
                if let Ok(text) = doc.text(&t) {
                    boxes.insert(key, text);
                }
            }
        }
    }
    // Excalidraw keeps elements in the order of their fractional `index`.
    elements.sort_by(|a, b| a["index"].as_str().unwrap_or("").cmp(b["index"].as_str().unwrap_or("")).then_with(|| a["id"].as_str().cmp(&b["id"].as_str())));
    (elements, boxes)
}

/// The document's state for the page: its elements, text boxes, and heads (what a push from
/// the page is based on).
fn state_of(doc: &Automerge) -> (Vec<Value>, HashMap<String, String>, Vec<String>) {
    let (elements, boxes) = read_doc(doc);
    (elements, boxes, doc.get_heads().iter().map(ToString::to_string).collect())
}

/// A string value's text.
pub(super) fn scalar_str(v: &AmValue) -> Option<String> {
    match v {
        AmValue::Scalar(s) => match s.as_ref() {
            ScalarValue::Str(t) => Some(t.to_string()),
            _ => None,
        },
        _ => None,
    }
}

/// The map at `key` in the document's root, made if missing.
fn root_map(doc: &mut impl Transactable, key: &str) -> Result<ObjId> {
    match doc.get(ROOT, key).map_err(am)? {
        Some((AmValue::Object(ObjType::Map), id)) => Ok(id),
        _ => doc.put_object(ROOT, key, ObjType::Map).map_err(am),
    }
}

/// Puts elements into the document: each one that differs from the document's pick, without its
/// text box Markdown, which goes into the box's text (changed by the least edit).
fn write_doc(doc: &mut impl Transactable, elements: &[Value]) -> Result<()> {
    let els = root_map(doc, "elements")?;
    let bxs = root_map(doc, "boxes")?;
    for e in elements {
        let Some(id) = e["id"].as_str() else { continue };
        let mut stored = e.clone();
        if is_box(e) {
            let text = e.pointer("/customData/librarium/text").and_then(Value::as_str).unwrap_or("").to_string();
            if let Some(l) = stored.pointer_mut("/customData/librarium").and_then(Value::as_object_mut) {
                l.remove("text");
            }
            let t = match doc.get(&bxs, id).map_err(am)? {
                Some((AmValue::Object(ObjType::Text), t)) => t,
                _ => doc.put_object(&bxs, id, ObjType::Text).map_err(am)?,
            };
            if doc.text(&t).map_err(am)? != text {
                doc.update_text(&t, &text).map_err(am)?;
            }
        }
        let current = doc.get(&els, id).map_err(am)?.and_then(|(v, _)| scalar_str(&v)).and_then(|t| serde_json::from_str::<Value>(&t).ok());
        if current.as_ref() != Some(&stored) {
            doc.put(&els, id, serde_json::to_string(&stored).unwrap_or_default()).map_err(am)?;
        }
    }
    Ok(())
}

/// Makes the page's changes as of `heads` (the state it last saw), then merges them in. Returns
/// the heads of the page's state with its changes.
fn push_at(d: &mut Automerge, elements: &[Value], heads: &[ChangeHash]) -> Result<Vec<ChangeHash>> {
    let mut fork = if heads.is_empty() { d.fork() } else { d.fork_at(heads).unwrap_or_else(|_| d.fork()) };
    fork.transact(|tx| write_doc(tx, elements)).map_err(|f| f.error)?;
    let mine = fork.get_heads();
    d.merge(&mut fork).map_err(am)?;
    Ok(mine)
}

fn am(e: automerge::AutomergeError) -> Error {
    Error::io(format!("the shared board’s document: {e}"))
}

/// Merges what the document holds into a drawing's elements: each element the newer of the two,
/// and each text box's Markdown from the document. Returns whether anything changed.
fn merge_into(elements: &mut Vec<Value>, from_doc: &[Value], boxes: &HashMap<String, String>) -> bool {
    let mut changed = false;
    let at: HashMap<String, usize> = elements.iter().enumerate().filter_map(|(i, e)| Some((e["id"].as_str()?.to_string(), i))).collect();
    for d in from_doc {
        let Some(id) = d["id"].as_str() else { continue };
        match at.get(id) {
            Some(&i) if !wins(d, &elements[i]) => {}
            Some(&i) => {
                elements[i] = d.clone();
                changed = true;
            }
            None => {
                elements.push(d.clone());
                changed = true;
            }
        }
    }
    for e in elements.iter_mut().filter(|e| is_box(e)) {
        let Some(text) = e["id"].as_str().and_then(|id| boxes.get(id)) else { continue };
        if e.pointer("/customData/librarium/text").and_then(Value::as_str) != Some(text) {
            if let Some(l) = e.pointer_mut("/customData/librarium").and_then(Value::as_object_mut) {
                l.insert("text".into(), Value::String(text.clone()));
                changed = true;
            }
        }
    }
    elements.sort_by(|a, b| a["index"].as_str().unwrap_or("").cmp(b["index"].as_str().unwrap_or("")));
    changed
}

impl Boards {
    pub fn new(lib: Arc<Library>, repo: Repo, emit: Emit) -> Arc<Boards> {
        Arc::new(Boards { lib, repo, emit, handles: Mutex::default(), open: Mutex::default(), stopped: AtomicBool::new(false) })
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.handles.lock().unwrap().clear();
    }

    fn entry(&self, id: Id) -> Result<record::Entry> {
        self.lib.index.get(id).filter(|e| e.kind == boards::KIND).ok_or_else(|| Error::not_found("That board can’t be found."))
    }

    /// Follows every shared board in the library.
    pub fn follow_all(self: &Arc<Self>) {
        for e in self.lib.index.list(Some(boards::KIND)).unwrap_or_default() {
            if let Some(url) = e.field_str(DOC).and_then(|d| AutomergeUrl::from_str(d).ok()) {
                self.follow(e.id, url);
            }
        }
    }

    /// Follows one shared board: what arrives from colleagues goes to the page or the file.
    fn follow(self: &Arc<Self>, id: Id, url: AutomergeUrl) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(Some(handle)) = me.repo.find(url.document_id().clone()).await else {
                log::warn!("the shared board {id}’s document isn’t here or on the server yet");
                return;
            };
            me.handles.lock().unwrap().insert(id, handle.clone());
            // Changes made elsewhere while the app was closed.
            me.arrived(id, &handle);
            let presence = {
                let (me, handle) = (me.clone(), handle.clone());
                async move {
                    let mut ephemera = handle.ephemera();
                    while let Some(bytes) = ephemera.next().await {
                        if me.stopped.load(Ordering::SeqCst) {
                            break;
                        }
                        if let Some(Ok(mut v)) = from_cbor_text(&bytes).map(serde_json::from_slice::<Value>) {
                            v["board"] = json!(id.to_string());
                            (me.emit)("sharing.presence", v);
                        }
                    }
                }
            };
            tauri::async_runtime::spawn(presence);
            let mut changes = handle.changes();
            while changes.next().await.is_some() {
                if me.stopped.load(Ordering::SeqCst) || !me.handles.lock().unwrap().contains_key(&id) {
                    break;
                }
                me.arrived(id, &handle);
            }
        });
    }

    /// The document changed: the open page is told, or a closed board's drawing is updated.
    fn arrived(&self, id: Id, handle: &DocHandle) {
        let (elements, boxes, heads) = handle.with_document(|d| state_of(d));
        // Captures on the board that this library hasn't got are written first, so the board's
        // cards find them.
        let carried = handle.with_document(|d| super::captures::all(&*d));
        if let Err(e) = super::captures::receive(&self.lib, &handle.url().to_string(), carried) {
            log::warn!("captures from a shared board weren’t written: {e}");
        }
        if self.open.lock().unwrap().contains_key(&id) {
            (self.emit)("sharing.board", json!({ "id": id.to_string(), "elements": elements, "boxes": boxes, "heads": heads }));
        } else if let Err(e) = self.write_file(id, &elements, &boxes) {
            log::warn!("a shared board’s changes weren’t written to {id}: {e}");
        }
    }

    /// Writes what arrived into a closed board's drawing (its page is rewritten when it opens).
    fn write_file(&self, id: Id, from_doc: &[Value], boxes: &HashMap<String, String>) -> Result<()> {
        let e = self.entry(id)?;
        let w = self.lib.write();
        let path = e.dir(&self.lib).join(format!("{id}{SCENE}"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|_| boards::EMPTY_SCENE.to_string());
        let mut scene: Value = serde_json::from_str(&text).map_err(|_| Error::invalid("The board’s drawing isn’t an Excalidraw drawing."))?;
        let mut elements = scene["elements"].as_array().cloned().unwrap_or_default();
        if !merge_into(&mut elements, from_doc, boxes) {
            return Ok(());
        }
        scene["elements"] = Value::Array(elements);
        let bytes = serde_json::to_vec_pretty(&scene).map_err(|e| Error::io(e.to_string()))?;
        files::write_sidecar(&w, id, SCENE, &bytes)
    }

    /// The board's page `page` opened (`true`) or closed: while it is open in any, what arrives
    /// goes there. Returns
    /// the shared document's state when the board is shared.
    pub fn watch(self: &Arc<Self>, id: Id, open: bool, page: &str) -> Option<SharedBoard> {
        {
            let mut open_in = self.open.lock().unwrap();
            let pages = open_in.entry(id).or_default();
            if open {
                pages.insert(page.to_string());
            } else {
                pages.remove(page);
                if pages.is_empty() {
                    open_in.remove(&id);
                }
                return None;
            }
        }
        let url = self.entry(id).ok()?.field_str(DOC).and_then(|d| AutomergeUrl::from_str(d).ok())?;
        let handle = self.handles.lock().unwrap().get(&id).cloned();
        let Some(handle) = handle else {
            self.follow(id, url.clone());
            return Some(SharedBoard { link: link_of(&url), elements: vec![], boxes: HashMap::new(), heads: vec![] });
        };
        // Captures on a board shared before they travelled go across when it is opened here.
        self.carry(&handle);
        let (elements, boxes, heads) = handle.with_document(|d| state_of(d));
        Some(SharedBoard { link: link_of(&url), elements, boxes, heads })
    }

    /// Shares a board: makes its document from the drawing, records it on the board, follows it.
    pub fn share(self: &Arc<Self>, id: Id) -> Result<SharedBoard> {
        let e = self.entry(id)?;
        if let Some(url) = e.field_str(DOC).and_then(|d| AutomergeUrl::from_str(d).ok()) {
            return Ok(SharedBoard { link: link_of(&url), elements: vec![], boxes: HashMap::new(), heads: vec![] });
        }
        let text = std::fs::read_to_string(e.dir(&self.lib).join(format!("{id}{SCENE}"))).unwrap_or_else(|_| boards::EMPTY_SCENE.to_string());
        let scene: Value = serde_json::from_str(&text).map_err(|_| Error::invalid("The board’s drawing isn’t an Excalidraw drawing."))?;
        let mut doc = AutoCommit::new();
        doc.put(ROOT, "librarium", "board 1").map_err(am)?;
        doc.put(ROOT, "title", e.title.as_str()).map_err(am)?;
        if let Some(bg) = scene.pointer("/appState/viewBackgroundColor").and_then(Value::as_str) {
            doc.put(ROOT, "background", bg).map_err(am)?;
        }
        write_doc(&mut doc, scene["elements"].as_array().map(Vec::as_slice).unwrap_or_default())?;
        let initial = Automerge::load(&doc.save()).map_err(am)?;
        let handle = block_on(self.repo.create(initial)).map_err(|_| Error::io("Sharing has stopped."))?;
        let url = handle.url();
        {
            let w = self.lib.write();
            save::set_fields(&w, id, None, &[(DOC.to_string(), Some(FmValue::Str(url.to_string())))])?;
        }
        self.carry(&handle);
        self.handles.lock().unwrap().insert(id, handle);
        self.follow(id, url.clone());
        Ok(SharedBoard { link: link_of(&url), elements: vec![], boxes: HashMap::new(), heads: vec![] })
    }

    /// Stops sharing a board here: it stays as an ordinary board; colleagues keep theirs.
    pub fn unshare(&self, id: Id) -> Result<()> {
        self.handles.lock().unwrap().remove(&id);
        let w = self.lib.write();
        save::set_fields(&w, id, None, &[(DOC.to_string(), None)])?;
        Ok(())
    }

    /// Opens a board a colleague shared: finds its document (from the server, the first time)
    /// and makes the board in this library, or returns the one already here.
    pub fn open_shared(self: &Arc<Self>, link: &str, folder: Option<&str>) -> Result<Written> {
        let url = parse_link(link)?;
        if let Some(e) = self.lib.index.with_field(DOC, &url.to_string())?.into_iter().find(|e| e.kind == boards::KIND) {
            return Ok(Written { info: record::info(&self.lib, &e), seq: self.lib.seq() });
        }
        // A board shared a moment ago may not have reached the server yet: ask again for a while.
        let deadline = std::time::Instant::now() + FIND_WAIT;
        let handle = loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match block_on(async { tokio::time::timeout(left, self.repo.find(url.document_id().clone())).await }) {
                Ok(Ok(Some(h))) => break h,
                Ok(Ok(None)) if std::time::Instant::now() + Duration::from_secs(1) < deadline => std::thread::sleep(Duration::from_secs(1)),
                _ => return Err(Error::not_found("That board couldn’t be found. Check that Sharing is connected (Settings ▸ Sharing) and that the link is complete.")),
            }
        };
        let (elements, boxes, title, background) = handle.with_document(|d| {
            let (els, bxs) = read_doc(d);
            let s = |k: &str| d.get(ROOT, k).ok().flatten().and_then(|(v, _)| scalar_str(&v));
            (els, bxs, s("title"), s("background"))
        });
        let mut els = Vec::new();
        merge_into(&mut els, &elements, &boxes);
        let mut scene: Value = serde_json::from_str(boards::EMPTY_SCENE).unwrap_or_default();
        scene["elements"] = Value::Array(els);
        if let Some(bg) = background {
            scene["appState"] = json!({ "viewBackgroundColor": bg });
        }
        let made = boards::create(&self.lib, title.as_deref(), folder)?;
        let id = made.info.id;
        let e = {
            let w = self.lib.write();
            files::write_sidecar(&w, id, SCENE, &serde_json::to_vec_pretty(&scene).unwrap_or_default())?;
            save::set_fields(&w, id, None, &[(DOC.to_string(), Some(FmValue::Str(url.to_string())))])?
        };
        self.handles.lock().unwrap().insert(id, handle);
        self.follow(id, url);
        Ok(Written { info: record::info(&self.lib, &e), seq: self.lib.seq() })
    }

    /// The open page's elements, after its own merge, as changed since the document's `heads`
    /// it last saw: the changes are made as of those heads, then merged, so a text box's words
    /// typed here and by a colleague meanwhile are both kept.
    /// Returns the heads of what the page now has (its change, not what it hasn't seen yet), for
    /// its next push.
    pub fn push(&self, id: Id, elements: &[Value], heads: &[String]) -> Result<Vec<String>> {
        let Some(handle) = self.handles.lock().unwrap().get(&id).cloned() else { return Ok(heads.to_vec()) };
        let heads: Vec<ChangeHash> = heads.iter().filter_map(|h| ChangeHash::from_str(h).ok()).collect();
        let mine = handle.with_document(|d| push_at(d, elements, &heads))?;
        self.carry(&handle);
        Ok(mine.iter().map(ToString::to_string).collect())
    }

    /// Puts into the document the captures the board refers to that it doesn't hold yet.
    fn carry(&self, handle: &DocHandle) {
        let (elements, boxes) = handle.with_document(|d| read_doc(&*d));
        let held = handle.with_document(|d| super::captures::held(&*d));
        let new: Vec<_> = super::captures::referenced(&elements, &boxes).into_iter()
            .filter(|id| !held.contains(id))
            .filter_map(|id| super::captures::carried(&self.lib, id).map(|c| (id, c)))
            .collect();
        if new.is_empty() {
            return;
        }
        let done = handle.with_document(|d| d.transact(|tx| new.iter().try_for_each(|(id, c)| super::captures::put(tx, *id, c))).map(|_| ()));
        if let Err(e) = done {
            log::warn!("captures weren’t put on a shared board: {:?}", e.error);
        }
    }

    /// Where this person's pointer is on a shared board (and who they are), to colleagues there.
    pub fn presence(&self, id: Id, mut data: Map<String, Value>, name: Option<String>) {
        let Some(handle) = self.handles.lock().unwrap().get(&id).cloned() else { return };
        data.insert("peer".into(), json!(self.repo.peer_id().to_string()));
        data.insert("name".into(), json!(name));
        handle.broadcast(cbor_text(&serde_json::to_vec(&Value::Object(data)).unwrap_or_default()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(id: &str, version: i64, nonce: i64, x: i64) -> Value {
        json!({ "id": id, "version": version, "versionNonce": nonce, "x": x, "index": format!("a{id}") })
    }

    #[test]
    fn excalidraws_rule() {
        assert!(wins(&el("1", 3, 9, 0), &el("1", 2, 1, 0)));
        assert!(wins(&el("1", 3, 1, 0), &el("1", 3, 9, 0)));
        assert!(!wins(&el("1", 3, 9, 0), &el("1", 3, 1, 0)));
    }

    #[test]
    fn round_trip_and_concurrent_edits() {
        let mut a = AutoCommit::new();
        let box_el = json!({ "id": "b", "version": 1, "versionNonce": 1, "index": "a2", "link": TEXT_BOX, "customData": { "librarium": { "text": "hello" } } });
        write_doc(&mut a, &[el("1", 1, 5, 0), box_el.clone()]).unwrap();
        let mut b = a.fork();
        // Both move element 1 at once; a's edit has the higher version.
        write_doc(&mut a, &[el("1", 3, 5, 10)]).unwrap();
        write_doc(&mut b, &[el("1", 2, 5, 20)]).unwrap();
        // Both type in the box at once.
        let mut ba = box_el.clone();
        ba["customData"]["librarium"]["text"] = json!("hello world");
        write_doc(&mut a, &[ba]).unwrap();
        let mut bb = box_el.clone();
        bb["customData"]["librarium"]["text"] = json!("oh hello");
        write_doc(&mut b, &[bb]).unwrap();
        a.merge(&mut b).unwrap();
        b.merge(&mut a).unwrap();
        let (ea, ba_) = read_doc(&a);
        let (eb, bb_) = read_doc(&b);
        assert_eq!(ea, eb);
        assert_eq!(ba_, bb_);
        assert_eq!(ea.iter().find(|e| e["id"] == "1").unwrap()["x"], 10);
        assert_eq!(ba_["b"], "oh hello world");
        // Into a drawing: the box gets its merged text back.
        let mut drawing = vec![el("1", 1, 5, 0), box_el];
        assert!(merge_into(&mut drawing, &ea, &ba_));
        assert_eq!(drawing[1]["customData"]["librarium"]["text"], "oh hello world");
        assert_eq!(drawing[0]["x"], 10);
    }

    #[test]
    fn a_push_keeps_what_arrived_since() {
        let box_el = |t: &str| json!({ "id": "b", "version": 1, "versionNonce": 1, "index": "a1", "link": TEXT_BOX, "customData": { "librarium": { "text": t } } });
        let mut d = Automerge::new();
        push_at(&mut d, &[box_el("hello")], &[]).unwrap();
        let seen = d.get_heads();
        // A colleague's words arrive...
        let now = d.get_heads();
        push_at(&mut d, &[box_el("hello world")], &now).unwrap();
        // ...while words typed here, based on what was seen before, are pushed.
        let mine = push_at(&mut d, &[box_el("oh hello")], &seen).unwrap();
        assert_eq!(read_doc(&d).1["b"], "oh hello world");
        // More typed here, based on the page's own last push: nothing is doubled.
        push_at(&mut d, &[box_el("oh, hello")], &mine).unwrap();
        assert_eq!(read_doc(&d).1["b"], "oh, hello world");
    }

    #[test]
    fn cbor_texts() {
        for n in [0, 5, 23, 24, 200, 300, 70_000] {
            let s = "x".repeat(n);
            assert_eq!(from_cbor_text(&cbor_text(s.as_bytes())), Some(s.as_bytes()));
        }
    }

    #[test]
    fn links() {
        let u = parse_link("librarium://board/4J5JcruzAMRmgT873oSyN8SorpEo").unwrap();
        assert_eq!(link_of(&u), "librarium://board/4J5JcruzAMRmgT873oSyN8SorpEo");
        assert_eq!(parse_link("automerge:4J5JcruzAMRmgT873oSyN8SorpEo").unwrap(), u);
        assert!(parse_link("https://example.org").is_err());
    }
}
