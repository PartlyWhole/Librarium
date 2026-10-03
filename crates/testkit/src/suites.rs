//! Shared port suites: one suite per port, run against both its real and its test adapter.

pub mod worker {
    use librarium_contracts::ports::WorkerHost;
    use std::time::Duration;

    /// Every WorkerHost answers `ping` and reports unknown methods as errors.
    pub fn basic(host: &dyn WorkerHost) {
        let v = host.call("ping", serde_json::json!({}), Duration::from_secs(10)).expect("ping");
        assert!(v.get("worker_version").is_some(), "ping reply has a version: {v}");
        let e = host.call("no.such.method", serde_json::json!({}), Duration::from_secs(10)).unwrap_err();
        assert_eq!(e.code, librarium_contracts::ErrorCode::NotFound);
    }
}

pub mod filesystem {
    use librarium_contracts::ports::{FileSystem, Flush};
    use std::io::ErrorKind;
    use std::path::Path;

    /// The FileSystem contract. `root` must not exist yet.
    pub fn run(fs: &dyn FileSystem, root: &Path) {
        assert!(fs.stat(root).unwrap().is_none(), "root must not exist");
        let d = root.join("a/b");
        fs.create_dir_all(&d).unwrap();
        fs.create_dir_all(&d).unwrap();
        assert!(fs.stat(&d).unwrap().unwrap().is_dir);

        // write_new is exclusive
        let f = d.join("one.md");
        fs.write_new(&f, b"hello").unwrap();
        assert_eq!(fs.write_new(&f, b"again").unwrap_err().kind(), ErrorKind::AlreadyExists);
        assert_eq!(fs.read(&f).unwrap(), b"hello");
        fs.flush_file(&f, Flush::Data).unwrap();
        fs.flush_file(&f, Flush::Full).unwrap();
        fs.flush_dir(&d, Flush::Data).unwrap();
        fs.flush_dir(&d, Flush::Full).unwrap();
        fs.barrier(&d).unwrap();

        let m = fs.stat(&f).unwrap().unwrap();
        assert_eq!(m.len, 5);
        assert!(!m.is_dir);
        assert!(fs.stat(&d.join("missing")).unwrap().is_none());
        assert_eq!(fs.read(&d.join("missing")).unwrap_err().kind(), ErrorKind::NotFound);

        // rename replaces, keeping the moved file's inode
        let tmp = d.join(".tmp-1");
        fs.write_new(&tmp, b"replaced").unwrap();
        let tmp_ino = fs.stat(&tmp).unwrap().unwrap().inode;
        fs.rename(&tmp, &f).unwrap();
        assert_eq!(fs.read(&f).unwrap(), b"replaced");
        assert_eq!(fs.stat(&f).unwrap().unwrap().inode, tmp_ino);
        assert!(fs.stat(&tmp).unwrap().is_none());

        // rename_exclusive refuses to replace and leaves both files
        let other = d.join("two.md");
        fs.write_new(&other, b"two").unwrap();
        assert_eq!(fs.rename_exclusive(&other, &f).unwrap_err().kind(), ErrorKind::AlreadyExists);
        assert_eq!(fs.read(&f).unwrap(), b"replaced");
        assert_eq!(fs.read(&other).unwrap(), b"two");
        let moved = root.join("a/moved.md");
        fs.rename_exclusive(&other, &moved).unwrap();
        assert_eq!(fs.read(&moved).unwrap(), b"two");

        // list shows files and folders
        let names: Vec<_> = fs.list(&root.join("a")).unwrap().into_iter().map(|e| (e.name, e.is_dir)).collect();
        assert!(names.contains(&("b".to_string(), true)), "{names:?}");
        assert!(names.contains(&("moved.md".to_string(), false)), "{names:?}");

        // removal
        fs.remove_file(&moved).unwrap();
        assert!(fs.stat(&moved).unwrap().is_none());
        assert!(fs.remove_dir(&root.join("a")).is_err(), "not empty");
        fs.remove_file(&f).unwrap();
        fs.remove_dir(&d).unwrap();
        assert!(fs.stat(&d).unwrap().is_none());

        // a rewrite changes mtime or ctime
        let g = root.join("g");
        fs.write_new(&g, b"1").unwrap();
        let before = fs.stat(&g).unwrap().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let t2 = root.join(".g-tmp");
        fs.write_new(&t2, b"22").unwrap();
        fs.rename(&t2, &g).unwrap();
        let after = fs.stat(&g).unwrap().unwrap();
        assert_ne!((before.mtime_ns, before.inode, before.len), (after.mtime_ns, after.inode, after.len));
    }
}

pub mod index {
    use librarium_contracts::ports::{Cell, IndexEngine, OpenState, Passage, TableSpec, TextQuery, ViewSpec};

    pub fn spec(version: u32) -> ViewSpec {
        ViewSpec {
            name: "suite".into(),
            schema_version: version,
            tables: vec![TableSpec {
                name: "links".into(),
                columns: vec!["key".into(), "target".into(), "n".into()],
                indexed: vec!["target".into()],
            }],
            text: true,
        }
    }

    fn p(record: &str, kind: &str, ordinal: i64, title: &str, body: &str) -> Passage {
        Passage {
            record: record.into(),
            kind: kind.into(),
            ordinal,
            title: title.into(),
            body: body.into(),
            offset: ordinal * 100,
        }
    }

    /// The IndexEngine contract. `persistent` engines must also keep data across opens.
    pub fn run(engine: &dyn IndexEngine, persistent: bool) {
        engine.drop_view("suite").unwrap();
        let (mut v, state) = engine.open(&spec(1)).unwrap();
        assert_eq!(state, OpenState::Empty);

        // tables
        v.begin().unwrap();
        v.put("links", vec!["a".into(), "x".into(), Cell::Int(1)]).unwrap();
        v.put("links", vec!["b".into(), "x".into(), Cell::Int(2)]).unwrap();
        v.put("links", vec!["c".into(), "y".into(), Cell::Null]).unwrap();
        v.put("links", vec!["a".into(), "z".into(), Cell::Int(3)]).unwrap();
        v.commit().unwrap();
        assert_eq!(v.get("links", "a").unwrap(), Some(vec!["a".into(), "z".into(), Cell::Int(3)]));
        assert_eq!(v.find("links", "target", &"x".into()).unwrap().len(), 1);
        assert_eq!(v.all("links").unwrap().len(), 3);
        v.delete("links", "b").unwrap();
        v.delete_where("links", "target", &"y".into()).unwrap();
        assert_eq!(v.all("links").unwrap().len(), 1);
        assert!(v.put("nope", vec![]).is_err());
        v.meta_put("k", "v").unwrap();
        assert_eq!(v.meta_get("k").unwrap().as_deref(), Some("v"));

        // text
        v.put_passages(
            "r1",
            &[
                p("r1", "note", 0, "Jacques Ellul", "He wrote about technique and society."),
                p("r1", "note", 1, "Jacques Ellul", "Propaganda follows."),
            ],
        )
        .unwrap();
        v.put_passages("r2", &[p("r2", "note", 0, "Technique notes", "Nothing about him here.")]).unwrap();
        v.put_passages(
            "r3",
            &[p("r3", "capture", 0, "A quotation", "The technological society is a book about technique.")],
        )
        .unwrap();
        let q = |text: &str, kinds: &[&str], limit| TextQuery {
            text: text.into(),
            kinds: kinds.iter().map(|s| s.to_string()).collect(),
            limit,
        };

        let hits = v.search(&q("techni", &[], 10)).unwrap();
        assert_eq!(hits.len(), 3, "prefix search: {hits:?}");
        assert_eq!(hits[0].record, "r2", "title outweighs body: {hits:?}");
        assert!(
            hits.iter().any(|h| h.snippet.contains('\u{2}') && h.snippet.contains('\u{3}')),
            "snippets mark matches"
        );

        let hits = v.search(&q("\"technological society\"", &[], 10)).unwrap();
        assert_eq!(hits.iter().map(|h| h.record.as_str()).collect::<Vec<_>>(), ["r3"], "phrases");

        let hits = v.search(&q("technique -propaganda -society", &[], 10)).unwrap();
        assert_eq!(hits.iter().map(|h| h.record.as_str()).collect::<Vec<_>>(), ["r2"], "exclusions");

        let hits = v.search(&q("technique", &["capture"], 1)).unwrap();
        assert_eq!(hits.iter().map(|h| h.record.as_str()).collect::<Vec<_>>(), ["r3"], "kind filter before the limit");

        v.delete_passages("r3").unwrap();
        assert!(v.search(&q("technological", &[], 10)).unwrap().is_empty());
        drop(v);

        if persistent {
            let (v, state) = engine.open(&spec(1)).unwrap();
            assert_eq!(state, OpenState::Ready);
            assert_eq!(v.all("links").unwrap().len(), 1);
            drop(v);
            // A new schema version means an empty view until a rebuild replaces the file.
            let (v, state) = engine.open(&spec(2)).unwrap();
            assert_eq!(state, OpenState::Empty);
            assert!(v.all("links").unwrap().is_empty());
            drop(v);
            let mut r = engine.rebuild(&spec(2)).unwrap();
            r.put("links", vec!["new".into(), "t".into(), Cell::Null]).unwrap();
            let v = r.finish_rebuild().unwrap();
            assert_eq!(v.all("links").unwrap().len(), 1);
            drop(v);
            let (v, state) = engine.open(&spec(2)).unwrap();
            assert_eq!(state, OpenState::Ready);
            assert_eq!(v.get("links", "new").unwrap().unwrap()[1], Cell::from("t"));
        }
        engine.drop_view("suite").unwrap();
    }
}

pub mod changes {
    use librarium_contracts::ports::{ChangeBatch, ChangeSource, StartOutcome};
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn wait_for(rx: &mpsc::Receiver<ChangeBatch>, want: &Path, history: bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(15);
        let (mut saw_path, mut saw_done) = (false, !history);
        while Instant::now() < deadline && !(saw_path && saw_done) {
            if let Ok(b) = rx.recv_timeout(Duration::from_millis(100)) {
                saw_path |= b.rescan || b.paths.iter().any(|p| p == want || want.starts_with(p));
                saw_done |= b.history_done;
            }
        }
        saw_path && saw_done
    }

    /// The ChangeSource contract. `touch` changes a file the way an outside program would (and,
    /// for a scripted source, records the event).
    pub fn run(src: &dyn ChangeSource, root: &Path, touch: &dyn Fn(&Path)) {
        let (tx, rx) = mpsc::channel();
        let sink = move |b: ChangeBatch| {
            let _ = tx.send(b);
        };
        let outcome = src.start(root, None, Box::new(sink)).unwrap();
        assert!(matches!(outcome, StartOutcome::Unavailable(_)), "no saved state: {outcome:?}");
        let a: PathBuf = root.join("a.md");
        touch(&a);
        assert!(wait_for(&rx, &a, false), "a live change arrives");

        // Changes made while not watching are replayed from the saved state.
        let state = src.current(root).unwrap();
        src.stop();
        let b = root.join("b.md");
        touch(&b);
        let (tx, rx) = mpsc::channel();
        let outcome = src
            .start(
                root,
                Some(state.clone()),
                Box::new(move |b| {
                    let _ = tx.send(b);
                }),
            )
            .unwrap();
        assert_eq!(outcome, StartOutcome::Replaying);
        assert!(wait_for(&rx, &b, true), "the replay brings the change, then history_done");
        src.stop();

        // A different volume can't be replayed.
        let mut other = state;
        other.volume_uuid = "NOT-THIS-VOLUME".into();
        let outcome = src.start(root, Some(other), Box::new(|_| {})).unwrap();
        assert!(matches!(outcome, StartOutcome::Unavailable(_)), "{outcome:?}");
        src.stop();
    }
}

pub mod versions {
    use librarium_contracts::ports::VersionStore;

    /// The VersionStore contract: accepts every write; history is newest first when kept.
    pub fn run(v: &dyn VersionStore, keeps_history: bool) {
        v.recorded("notes/a.md", b"one").unwrap();
        v.recorded("notes/a.md", b"two").unwrap();
        let h = v.history("notes/a.md").unwrap();
        if keeps_history {
            assert_eq!(h, ["two", "one"]);
        } else {
            assert!(h.is_empty());
        }
        assert!(v.history("never/written.md").unwrap().is_empty());
    }
}
