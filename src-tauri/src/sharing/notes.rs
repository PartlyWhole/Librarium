//! Shared notes. A shared note keeps its Automerge document's address in `sharing.doc`, as a
//! shared board does; the document holds the note's text (its Markdown body) as Automerge text,
//! so two people typing in one note at once both keep their words, offline too. Titles and
//! folders stay each person's own.
//!
//! While a note is open, what arrives goes to the page as a `sharing.note` event and the page
//! saves it; while it is closed, it is written into the note's file here. Cursors and names
//! pass as ephemeral messages (`sharing.cursor`), never stored.

use super::block_on;
use super::boards::{cbor_text, from_cbor_text, scalar_str, DOC, FIND_WAIT};
use crate::error::{Error, Result};
use crate::store::frontmatter::FmValue;
use crate::store::{record, save, Emit, Library};
use crate::types::{NoteParams, SharedNote, Written};
use crate::util::Id;
use automerge::transaction::Transactable;
use automerge::{AutoCommit, Automerge, ChangeHash, ObjType, ReadDoc, Value as AmValue, ROOT};
use futures::StreamExt;
use samod::{AutomergeUrl, DocHandle, Repo};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const KIND: &str = "note";

pub struct Notes {
    lib: Arc<Library>,
    repo: Repo,
    emit: Emit,
    /// Shared notes being followed, by note ID.
    handles: Mutex<HashMap<Id, DocHandle>>,
    /// Notes open in the interface: what arrives goes there instead of to the file.
    /// The pages each is open in (it can be open in two windows or tabs at once).
    open: Mutex<HashMap<Id, HashSet<String>>>,
    stopped: AtomicBool,
}

/// The document address in a link: `librarium://note/<id>`, `automerge:<id>`, or the ID alone.
pub fn parse_link(link: &str) -> Result<AutomergeUrl> {
    let l = link.trim();
    let id = l.strip_prefix("librarium://note/").or_else(|| l.strip_prefix("automerge:")).unwrap_or(l);
    AutomergeUrl::from_str(&format!("automerge:{}", id.trim_end_matches('/')))
        .map_err(|_| Error::invalid("That isn’t a shared note’s link. It looks like librarium://note/…"))
}

/// The link colleagues are sent for a document.
pub fn link_of(url: &AutomergeUrl) -> String {
    format!("librarium://note/{}", url.document_id())
}

fn am(e: automerge::AutomergeError) -> Error {
    Error::io(format!("the shared note’s document: {e}"))
}

/// The note's text as the document holds it.
fn text_of(doc: &impl ReadDoc) -> String {
    match doc.get(ROOT, "text") {
        Ok(Some((AmValue::Object(ObjType::Text), t))) => doc.text(&t).unwrap_or_default(),
        _ => String::new(),
    }
}

/// Puts the note's text into the document, by the least edit.
fn write_text(doc: &mut impl Transactable, text: &str) -> Result<()> {
    let t = match doc.get(ROOT, "text").map_err(am)? {
        Some((AmValue::Object(ObjType::Text), t)) => t,
        _ => doc.put_object(ROOT, "text", ObjType::Text).map_err(am)?,
    };
    if doc.text(&t).map_err(am)? != text {
        doc.update_text(&t, text).map_err(am)?;
    }
    Ok(())
}

/// Makes the page's text as of `heads` (the state it last saw), then merges it in. Returns the
/// heads of the page's state with its change.
fn push_at(d: &mut Automerge, text: &str, heads: &[ChangeHash]) -> Result<Vec<ChangeHash>> {
    let mut fork = if heads.is_empty() { d.fork() } else { d.fork_at(heads).unwrap_or_else(|_| d.fork()) };
    fork.transact(|tx| write_text(tx, text)).map_err(|f| f.error)?;
    let mine = fork.get_heads();
    d.merge(&mut fork).map_err(am)?;
    Ok(mine)
}

fn state_of(doc: &Automerge) -> (String, Vec<String>) {
    (text_of(doc), doc.get_heads().iter().map(ToString::to_string).collect())
}

impl Notes {
    pub fn new(lib: Arc<Library>, repo: Repo, emit: Emit) -> Arc<Notes> {
        Arc::new(Notes { lib, repo, emit, handles: Mutex::default(), open: Mutex::default(), stopped: AtomicBool::new(false) })
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.handles.lock().unwrap().clear();
    }

    fn entry(&self, id: Id) -> Result<record::Entry> {
        self.lib.index.get(id).filter(|e| e.kind == KIND).ok_or_else(|| Error::not_found("That note can’t be found."))
    }

    /// Follows every shared note in the library.
    pub fn follow_all(self: &Arc<Self>) {
        for e in self.lib.index.list(Some(KIND)).unwrap_or_default() {
            if let Some(url) = e.field_str(DOC).and_then(|d| AutomergeUrl::from_str(d).ok()) {
                self.follow(e.id, url);
            }
        }
    }

    /// Follows one shared note: what arrives from colleagues goes to the page or the file.
    fn follow(self: &Arc<Self>, id: Id, url: AutomergeUrl) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let Ok(Some(handle)) = me.repo.find(url.document_id().clone()).await else {
                log::warn!("the shared note {id}’s document isn’t here or on the server yet");
                return;
            };
            me.handles.lock().unwrap().insert(id, handle.clone());
            // Changes made elsewhere while the app was closed.
            me.arrived(id, &handle);
            let cursors = {
                let (me, handle) = (me.clone(), handle.clone());
                async move {
                    let mut ephemera = handle.ephemera();
                    while let Some(bytes) = ephemera.next().await {
                        if me.stopped.load(Ordering::SeqCst) {
                            break;
                        }
                        if let Some(Ok(mut v)) = from_cbor_text(&bytes).map(serde_json::from_slice::<Value>) {
                            v["note"] = json!(id.to_string());
                            (me.emit)("sharing.cursor", v);
                        }
                    }
                }
            };
            tauri::async_runtime::spawn(cursors);
            let mut changes = handle.changes();
            while changes.next().await.is_some() {
                if me.stopped.load(Ordering::SeqCst) || !me.handles.lock().unwrap().contains_key(&id) {
                    break;
                }
                me.arrived(id, &handle);
            }
        });
    }

    /// The document changed: the open page is told, or a closed note's file is rewritten.
    fn arrived(&self, id: Id, handle: &DocHandle) {
        let (text, heads) = handle.with_document(|d| state_of(d));
        if self.open.lock().unwrap().contains_key(&id) {
            (self.emit)("sharing.note", json!({ "id": id.to_string(), "text": text, "heads": heads }));
        } else if let Err(e) = self.write_file(id, &text) {
            log::warn!("a shared note’s changes weren’t written to {id}: {e}");
        }
    }

    /// Writes what arrived into a closed note's file (its frontmatter stays as it is).
    fn write_file(&self, id: Id, text: &str) -> Result<()> {
        let e = self.entry(id)?;
        let w = self.lib.write();
        save::rewrite_body(&w, id, &e.hash, |body| (body != text).then(|| text.to_string()))?;
        Ok(())
    }

    /// The note's page `page` opened (`true`) or closed: while it is open in any, what arrives
    /// goes there. Returns
    /// the shared document's state when the note is shared.
    pub fn watch(self: &Arc<Self>, id: Id, open: bool, page: &str) -> Option<SharedNote> {
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
            return Some(SharedNote { link: link_of(&url), text: None, heads: vec![] });
        };
        let (text, heads) = handle.with_document(|d| state_of(d));
        Some(SharedNote { link: link_of(&url), text: Some(text), heads })
    }

    /// Shares a note: makes its document from the saved text, records it on the note, follows it.
    pub fn share(self: &Arc<Self>, id: Id) -> Result<SharedNote> {
        let e = self.entry(id)?;
        if let Some(url) = e.field_str(DOC).and_then(|d| AutomergeUrl::from_str(d).ok()) {
            return Ok(SharedNote { link: link_of(&url), text: None, heads: vec![] });
        }
        let file = std::fs::read_to_string(self.lib.root.join(&e.path)).map_err(|e| Error::io(e.to_string()))?;
        let mut doc = AutoCommit::new();
        doc.put(ROOT, "librarium", "note 1").map_err(am)?;
        doc.put(ROOT, "title", e.title.as_str()).map_err(am)?;
        write_text(&mut doc, record::body(&file))?;
        let initial = Automerge::load(&doc.save()).map_err(am)?;
        let handle = block_on(self.repo.create(initial)).map_err(|_| Error::io("Sharing has stopped."))?;
        let url = handle.url();
        {
            let w = self.lib.write();
            save::set_fields(&w, id, None, &[(DOC.to_string(), Some(FmValue::Str(url.to_string())))])?;
        }
        self.handles.lock().unwrap().insert(id, handle);
        self.follow(id, url.clone());
        Ok(SharedNote { link: link_of(&url), text: None, heads: vec![] })
    }

    /// Stops sharing a note here: it stays as an ordinary note; colleagues keep theirs.
    pub fn unshare(&self, id: Id) -> Result<()> {
        self.handles.lock().unwrap().remove(&id);
        let w = self.lib.write();
        save::set_fields(&w, id, None, &[(DOC.to_string(), None)])?;
        Ok(())
    }

    /// Opens a note a colleague shared: finds its document (from the server, the first time)
    /// and makes the note in this library, or returns the one already here.
    pub fn open_shared(self: &Arc<Self>, link: &str, folder: Option<&str>) -> Result<Written> {
        let url = parse_link(link)?;
        if let Some(e) = self.lib.index.with_field(DOC, &url.to_string())?.into_iter().find(|e| e.kind == KIND) {
            return Ok(Written { info: record::info(&self.lib, &e), seq: self.lib.seq() });
        }
        // A note shared a moment ago may not have reached the server yet: ask again for a while.
        let deadline = std::time::Instant::now() + FIND_WAIT;
        let handle = loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match block_on(async { tokio::time::timeout(left, self.repo.find(url.document_id().clone())).await }) {
                Ok(Ok(Some(h))) => break h,
                Ok(Ok(None)) if std::time::Instant::now() + Duration::from_secs(1) < deadline => std::thread::sleep(Duration::from_secs(1)),
                _ => return Err(Error::not_found("That note couldn’t be found. Check that Sharing is connected (Settings ▸ Sharing) and that the link is complete.")),
            }
        };
        let (text, title) = handle.with_document(|d| (text_of(d), d.get(ROOT, "title").ok().flatten().and_then(|(v, _)| scalar_str(&v))));
        let made = crate::notes::create(&self.lib, NoteParams { title, body: text, folder: folder.map(str::to_string) })?;
        let id = made.info.id;
        let e = {
            let w = self.lib.write();
            save::set_fields(&w, id, None, &[(DOC.to_string(), Some(FmValue::Str(url.to_string())))])?
        };
        self.handles.lock().unwrap().insert(id, handle);
        self.follow(id, url);
        Ok(Written { info: record::info(&self.lib, &e), seq: self.lib.seq() })
    }

    /// The open page's text, as changed since the document's `heads` it last saw: the change is
    /// made as of those heads, then merged, so words typed here and by a colleague meanwhile are
    /// both kept. Returns the heads of what the page now has, for its next push.
    pub fn push(&self, id: Id, text: &str, heads: &[String]) -> Result<Vec<String>> {
        let Some(handle) = self.handles.lock().unwrap().get(&id).cloned() else { return Ok(heads.to_vec()) };
        let heads: Vec<ChangeHash> = heads.iter().filter_map(|h| ChangeHash::from_str(h).ok()).collect();
        let mine = handle.with_document(|d| push_at(d, text, &heads))?;
        Ok(mine.iter().map(ToString::to_string).collect())
    }

    /// Where this person's cursor is in a shared note (and who they are), to colleagues there.
    pub fn cursor(&self, id: Id, mut data: Map<String, Value>, name: Option<String>) {
        let Some(handle) = self.handles.lock().unwrap().get(&id).cloned() else { return };
        data.insert("peer".into(), json!(self.repo.peer_id().to_string()));
        data.insert("name".into(), json!(name));
        handle.broadcast(cbor_text(&serde_json::to_vec(&Value::Object(data)).unwrap_or_default()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typing_at_once_keeps_both() {
        let mut d = Automerge::new();
        push_at(&mut d, "The plan is simple.", &[]).unwrap();
        let seen = d.get_heads();
        // A colleague adds a sentence...
        let now = d.get_heads();
        push_at(&mut d, "The plan is simple. It has two parts.", &now).unwrap();
        // ...while a word is changed here, based on what was seen before.
        let mine = push_at(&mut d, "The plan is short.", &seen).unwrap();
        assert_eq!(text_of(&d), "The plan is short. It has two parts.");
        // More typed here, based on the page's own last push: nothing is doubled.
        push_at(&mut d, "The plan is short!", &mine).unwrap();
        assert_eq!(text_of(&d), "The plan is short! It has two parts.");
    }

    #[test]
    fn links() {
        let u = parse_link("librarium://note/4J5JcruzAMRmgT873oSyN8SorpEo").unwrap();
        assert_eq!(link_of(&u), "librarium://note/4J5JcruzAMRmgT873oSyN8SorpEo");
        assert!(parse_link("librarium://board/4J5JcruzAMRmgT873oSyN8SorpEo").is_err());
    }
}
