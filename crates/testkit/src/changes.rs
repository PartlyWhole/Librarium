//! A scripted ChangeSource: tests record events; replay delivers everything after a state.

use librarium_contracts::ports::{ChangeBatch, ChangeSink, ChangeSource, ReplayState, StartOutcome};
use librarium_contracts::Result;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Default)]
struct S {
    log: Vec<(u64, PathBuf)>,
    next: u64,
    volume: String,
    sink: Option<Arc<ChangeSink>>,
    /// Pretend the history was purged before this event ID.
    purged_before: u64,
}

pub struct ScriptedChanges {
    s: Mutex<S>,
}

impl Default for ScriptedChanges {
    fn default() -> Self {
        Self::new()
    }
}

impl ScriptedChanges {
    pub fn new() -> Self {
        ScriptedChanges { s: Mutex::new(S { next: 100, volume: "VOLUME-A".into(), ..Default::default() }) }
    }

    /// Records an event; delivers it at once if watching.
    pub fn record(&self, path: &Path) {
        let (sink, batch) = {
            let mut s = self.s.lock().unwrap();
            s.next += 1;
            let id = s.next;
            s.log.push((id, path.to_path_buf()));
            let batch = ChangeBatch {
                paths: vec![path.to_path_buf()],
                rescan: false,
                history_done: false,
                state: ReplayState { event_id: id, volume_uuid: s.volume.clone() },
            };
            (s.sink.clone(), batch)
        };
        if let Some(sink) = sink {
            sink(batch);
        }
    }

    /// Delivers a "dropped events" batch.
    pub fn drop_events(&self) {
        let (sink, batch) = {
            let mut s = self.s.lock().unwrap();
            s.next += 1;
            (
                s.sink.clone(),
                ChangeBatch {
                    paths: vec![],
                    rescan: true,
                    history_done: false,
                    state: ReplayState { event_id: s.next, volume_uuid: s.volume.clone() },
                },
            )
        };
        if let Some(sink) = sink {
            sink(batch);
        }
    }

    /// The volume is now a different one (as after reformatting or restoring).
    pub fn change_volume(&self, uuid: &str) {
        self.s.lock().unwrap().volume = uuid.into();
    }

    /// History before now is gone.
    pub fn purge_history(&self) {
        let mut s = self.s.lock().unwrap();
        s.purged_before = s.next + 1;
        s.log.clear();
    }
}

impl ChangeSource for ScriptedChanges {
    fn start(&self, _root: &Path, since: Option<ReplayState>, sink: ChangeSink) -> Result<StartOutcome> {
        let sink = Arc::new(sink);
        let replay = {
            let mut s = self.s.lock().unwrap();
            s.sink = Some(sink.clone());
            match since {
                None => Err("no saved state".to_string()),
                Some(st) if st.volume_uuid != s.volume => Err("the volume changed".to_string()),
                Some(st) if st.event_id + 1 < s.purged_before => Err("the history was purged".to_string()),
                Some(st) => Ok((
                    s.log.iter().filter(|(id, _)| *id > st.event_id).map(|(_, p)| p.clone()).collect::<Vec<_>>(),
                    ReplayState { event_id: s.next.max(st.event_id), volume_uuid: s.volume.clone() },
                )),
            }
        };
        match replay {
            Err(why) => Ok(StartOutcome::Unavailable(why)),
            Ok((paths, state)) => {
                let s2 = sink.clone();
                std::thread::spawn(move || s2(ChangeBatch { paths, rescan: false, history_done: true, state }));
                Ok(StartOutcome::Replaying)
            }
        }
    }

    fn stop(&self) {
        self.s.lock().unwrap().sink = None;
    }

    fn current(&self, _root: &Path) -> Result<ReplayState> {
        let s = self.s.lock().unwrap();
        Ok(ReplayState { event_id: s.next, volume_uuid: s.volume.clone() })
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn passes_the_shared_suite() {
        let src = super::ScriptedChanges::new();
        crate::suites::changes::run(&src, std::path::Path::new("/lib"), &|p| src.record(p));
    }
}
