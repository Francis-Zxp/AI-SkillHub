//! v3.3 debounced asynchronous delivery queue (skills contract §3.5).
//!
//! Mutating commands only write SQLite and call [`request`]; they return in
//! well under 300 ms (I-4). One worker thread merges requests into batches:
//! the batch starts when the newest request is 600 ms old, or at the latest
//! 3 s after the first one. Requests that arrive while a job runs collect into
//! exactly one follow-up batch. The state machine ([`DeliveryQueueCore`]) is
//! pure and takes the clock as a parameter so it can be unit-tested.

use crate::skill_delivery::{iso_from_nanos, AgentDeliveryResult, SkillTargetKey};
use crate::skillhub_error::SkillHubError;
use serde::Serialize;
use std::collections::BTreeSet;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;

pub(crate) const DELIVERY_STATUS_EVENT: &str = "delivery-status";
pub(crate) const DEBOUNCE_MS: u64 = 600;
pub(crate) const MAX_DELAY_MS: u64 = 3_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Depth {
    Verify,
    Links,
    Full,
}

impl Depth {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "verify" => Some(Self::Verify),
            "links" => Some(Self::Links),
            "full" => Some(Self::Full),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Verify => "verify",
            Self::Links => "links",
            Self::Full => "full",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Batch {
    pub job_id: u64,
    pub depth: Depth,
    pub reasons: BTreeSet<String>,
    pub refresh_detection: bool,
    pub first_ms: u64,
    pub last_ms: u64,
    pub queued_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeliveryJobTicket {
    pub job_id: u64,
    pub phase: &'static str,
    pub coalesced: bool,
}

/// Pure queue state. `now_ms` is any monotonic millisecond clock.
#[derive(Debug, Default)]
pub(crate) struct DeliveryQueueCore {
    last_job_id: u64,
    pending: Option<Batch>,
    running: Option<u64>,
}

impl DeliveryQueueCore {
    pub(crate) fn request(
        &mut self,
        now_ms: u64,
        depth: Depth,
        reason: &str,
        refresh_detection: bool,
        queued_at: &str,
    ) -> DeliveryJobTicket {
        if let Some(batch) = self.pending.as_mut() {
            batch.depth = batch.depth.max(depth);
            batch.reasons.insert(reason.to_string());
            batch.refresh_detection |= refresh_detection;
            batch.last_ms = now_ms;
            return DeliveryJobTicket {
                job_id: batch.job_id,
                phase: "queued",
                coalesced: true,
            };
        }
        self.last_job_id += 1;
        self.pending = Some(Batch {
            job_id: self.last_job_id,
            depth,
            reasons: BTreeSet::from([reason.to_string()]),
            refresh_detection,
            first_ms: now_ms,
            last_ms: now_ms,
            queued_at: queued_at.to_string(),
        });
        DeliveryJobTicket {
            job_id: self.last_job_id,
            phase: "queued",
            coalesced: false,
        }
    }

    /// Returns the batch to run now, if any. Nothing starts while a job runs.
    pub(crate) fn due(&mut self, now_ms: u64) -> Option<Batch> {
        if self.running.is_some() {
            return None;
        }
        let ready = self.pending.as_ref().is_some_and(|batch| {
            now_ms.saturating_sub(batch.last_ms) >= DEBOUNCE_MS
                || now_ms.saturating_sub(batch.first_ms) >= MAX_DELAY_MS
        });
        if !ready {
            return None;
        }
        let batch = self.pending.take()?;
        self.running = Some(batch.job_id);
        Some(batch)
    }

    pub(crate) fn finish(&mut self, job_id: u64) {
        if self.running == Some(job_id) {
            self.running = None;
        }
    }

    /// Milliseconds until the pending batch becomes due; `None` when idle.
    pub(crate) fn wait_ms(&self, now_ms: u64) -> Option<u64> {
        if self.running.is_some() {
            return None;
        }
        let batch = self.pending.as_ref()?;
        let by_debounce = (batch.last_ms + DEBOUNCE_MS).saturating_sub(now_ms);
        let by_cap = (batch.first_ms + MAX_DELAY_MS).saturating_sub(now_ms);
        Some(by_debounce.min(by_cap))
    }

    /// A job id for a link step that ran outside the queue (update, rollback).
    pub(crate) fn allocate_external_id(&mut self) -> u64 {
        self.last_job_id += 1;
        self.last_job_id
    }

    pub(crate) fn pending_job(&self) -> Option<&Batch> {
        self.pending.as_ref()
    }

    pub(crate) fn running_job(&self) -> Option<u64> {
        self.running
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeliveryJobStatus {
    pub job_id: u64,
    pub phase: String,
    pub depth: String,
    pub reasons: Vec<String>,
    pub queued_at: String,
    pub started_at: String,
    pub finished_at: String,
    pub waiting_for: String,
    pub agents: Vec<AgentDeliveryResult>,
    pub changed_targets: Vec<SkillTargetKey>,
    pub snapshot_stale: bool,
    pub error: Option<SkillHubError>,
}

impl DeliveryJobStatus {
    fn from_batch(batch: &Batch, phase: &str) -> Self {
        Self {
            job_id: batch.job_id,
            phase: phase.to_string(),
            depth: batch.depth.as_str().to_string(),
            reasons: batch.reasons.iter().cloned().collect(),
            queued_at: batch.queued_at.clone(),
            started_at: String::new(),
            finished_at: String::new(),
            waiting_for: String::new(),
            agents: Vec::new(),
            changed_targets: Vec::new(),
            snapshot_stale: false,
            error: None,
        }
    }
}

/// What a finished job reports back to the queue.
#[derive(Debug, Clone, Default)]
pub(crate) struct JobOutcome {
    /// done | failed | paused
    pub phase: &'static str,
    pub agents: Vec<AgentDeliveryResult>,
    pub changed_targets: Vec<SkillTargetKey>,
    pub snapshot_stale: bool,
    pub error: Option<SkillHubError>,
}

/// Handed to the job so it can publish `waiting` and `running`.
pub(crate) struct Reporter<'a> {
    batch: &'a Batch,
}

impl Reporter<'_> {
    pub(crate) fn waiting(&self, waiting_for: &str) {
        let mut status = DeliveryJobStatus::from_batch(self.batch, "waiting");
        status.waiting_for = waiting_for.to_string();
        publish(status);
    }

    pub(crate) fn running(&self) {
        let mut status = DeliveryJobStatus::from_batch(self.batch, "running");
        status.started_at = now_iso();
        publish(status);
    }

    pub(crate) fn batch(&self) -> &Batch {
        self.batch
    }
}

pub(crate) type JobRunner = fn(&Reporter<'_>) -> JobOutcome;

struct Queue {
    core: Mutex<DeliveryQueueCore>,
    wake: Condvar,
    status: Mutex<Option<DeliveryJobStatus>>,
    app: OnceLock<tauri::AppHandle>,
    started: OnceLock<()>,
    epoch: Instant,
}

static QUEUE: OnceLock<Queue> = OnceLock::new();

fn queue() -> &'static Queue {
    QUEUE.get_or_init(|| Queue {
        core: Mutex::new(DeliveryQueueCore::default()),
        wake: Condvar::new(),
        status: Mutex::new(None),
        app: OnceLock::new(),
        started: OnceLock::new(),
        epoch: Instant::now(),
    })
}

fn now_ms() -> u64 {
    queue().epoch.elapsed().as_millis() as u64
}

fn now_iso() -> String {
    iso_from_nanos(&super::unix_timestamp_string())
}

fn publish(status: DeliveryJobStatus) {
    publish_with(status, true);
}

fn publish_with(status: DeliveryJobStatus, store: bool) {
    let queue = queue();
    if store {
        if let Ok(mut current) = queue.status.lock() {
            *current = Some(status.clone());
        }
    }
    if let Some(app) = queue.app.get() {
        let _ = app.emit(DELIVERY_STATUS_EVENT, status);
    }
}

/// Starts the single worker thread once. `runner` executes one batch.
pub(crate) fn start(app: tauri::AppHandle, runner: JobRunner) {
    let queue = queue();
    let _ = queue.app.set(app);
    if queue.started.set(()).is_err() {
        return;
    }
    // Without a worker the requests simply stay queued; nothing is written.
    let _ = std::thread::Builder::new()
        .name("skillhub-delivery".to_string())
        .spawn(move || worker_loop(runner));
}

fn worker_loop(runner: JobRunner) {
    let queue = queue();
    loop {
        let batch = {
            let mut core = match queue.core.lock() {
                Ok(core) => core,
                Err(poisoned) => poisoned.into_inner(),
            };
            loop {
                if let Some(batch) = core.due(now_ms()) {
                    break batch;
                }
                core = match core.wait_ms(now_ms()) {
                    Some(wait) => queue
                        .wake
                        .wait_timeout(core, Duration::from_millis(wait.max(10)))
                        .map(|(guard, _)| guard)
                        .unwrap_or_else(|poisoned| poisoned.into_inner().0),
                    None => queue
                        .wake
                        .wait(core)
                        .unwrap_or_else(|poisoned| poisoned.into_inner()),
                };
            }
        };
        let reporter = Reporter { batch: &batch };
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| runner(&reporter)))
            .unwrap_or_else(|_| JobOutcome {
                phase: "failed",
                error: Some(SkillHubError::code("INTERNAL")),
                ..JobOutcome::default()
            });
        let mut status = DeliveryJobStatus::from_batch(&batch, outcome.phase);
        status.started_at = queue
            .status
            .lock()
            .ok()
            .and_then(|current| current.as_ref().map(|status| status.started_at.clone()))
            .unwrap_or_default();
        status.finished_at = now_iso();
        status.agents = outcome.agents;
        status.changed_targets = outcome.changed_targets;
        status.snapshot_stale = outcome.snapshot_stale;
        status.error = outcome.error;
        publish(status);
        let follow_up = {
            // Never leave the queue "running" forever, even after a panic
            // poisoned the lock elsewhere.
            let mut core = queue
                .core
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            core.finish(batch.job_id);
            core.pending_job()
                .map(|pending| DeliveryJobStatus::from_batch(pending, "queued"))
        };
        // A follow-up collected while this job ran must not stay hidden behind
        // the finished status (`get_skill_delivery_state().job` would read
        // "done" while work is still queued).
        if let Some(follow_up) = follow_up {
            publish(follow_up);
        }
        queue.wake.notify_all();
        // The job's scan and reconcile buffers are gone; keep the idle
        // process small (memory budget).
        super::trim_process_working_set();
    }
}

/// Enqueue a delivery job. Never blocks on the job itself.
pub(crate) fn request(depth: Depth, reason: &str, refresh_detection: bool) -> DeliveryJobTicket {
    let queue = queue();
    let ticket = {
        let mut core = match queue.core.lock() {
            Ok(core) => core,
            Err(poisoned) => poisoned.into_inner(),
        };
        let ticket = core.request(now_ms(), depth, reason, refresh_detection, &now_iso());
        let status = core
            .pending_job()
            .map(|batch| DeliveryJobStatus::from_batch(batch, "queued"));
        // A follow-up queued during a running job must not hide that job.
        let store = core.running_job().is_none();
        drop(core);
        if let Some(status) = status {
            publish_with(status, store);
        }
        ticket
    };
    queue.wake.notify_all();
    ticket
}

/// Publishes a finished status for a link step that ran outside the queue,
/// so read-back and the `done` event happen there too (§3.5).
pub(crate) fn publish_finished(depth: Depth, reason: &str, outcome: JobOutcome) {
    let queue = queue();
    let (job_id, store) = {
        let mut core = match queue.core.lock() {
            Ok(core) => core,
            Err(poisoned) => poisoned.into_inner(),
        };
        (core.allocate_external_id(), core.running_job().is_none())
    };
    let now = now_iso();
    publish_with(
        DeliveryJobStatus {
            job_id,
            phase: outcome.phase.to_string(),
            depth: depth.as_str().to_string(),
            reasons: vec![reason.to_string()],
            queued_at: now.clone(),
            started_at: now.clone(),
            finished_at: now,
            waiting_for: String::new(),
            agents: outcome.agents,
            changed_targets: outcome.changed_targets,
            snapshot_stale: outcome.snapshot_stale,
            error: outcome.error,
        },
        store,
    );
}

/// Running job, or the last finished one; `None` before the first job.
pub(crate) fn current_status() -> Option<DeliveryJobStatus> {
    queue().status.lock().ok().and_then(|status| status.clone())
}

/// True while a job is queued, waiting or running.
pub(crate) fn is_active() -> bool {
    queue()
        .core
        .lock()
        .map(|core| core.pending_job().is_some() || core.running_job().is_some())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        core: &mut DeliveryQueueCore,
        now: u64,
        depth: Depth,
        reason: &str,
    ) -> DeliveryJobTicket {
        core.request(now, depth, reason, false, "t")
    }

    #[test]
    fn delivery_queue_coalesces() {
        let mut core = DeliveryQueueCore::default();
        // 5 requests within 2 s → one batch.
        let first = request(&mut core, 0, Depth::Links, "target");
        assert!(!first.coalesced);
        for (index, now) in [400, 800, 1200, 1600].into_iter().enumerate() {
            let ticket = request(
                &mut core,
                now,
                if index == 2 {
                    Depth::Full
                } else {
                    Depth::Links
                },
                "child-skill",
            );
            assert!(ticket.coalesced);
            assert_eq!(ticket.job_id, first.job_id);
            assert!(core.due(now + 100).is_none());
        }
        assert_eq!(core.wait_ms(1700), Some(500));
        let batch = core.due(2200).expect("due after 600 ms of quiet");
        assert_eq!(batch.job_id, first.job_id);
        assert_eq!(batch.depth, Depth::Full, "depth is the max");
        assert_eq!(batch.reasons.len(), 2);

        // Requests during a running batch → exactly one follow-up.
        let a = request(&mut core, 2300, Depth::Links, "a");
        let b = request(&mut core, 2400, Depth::Verify, "b");
        assert_eq!(a.job_id, b.job_id);
        assert!(a.job_id > batch.job_id, "job ids increase monotonically");
        assert!(core.due(10_000).is_none(), "nothing starts while running");
        core.finish(batch.job_id);
        let follow_up = core.due(10_000).unwrap();
        assert_eq!(follow_up.job_id, a.job_id);
        assert_eq!(follow_up.depth, Depth::Links);
        core.finish(follow_up.job_id);
        assert!(core.due(20_000).is_none());

        // A steady stream still starts at the 3 s cap.
        let stream = request(&mut core, 30_000, Depth::Verify, "s");
        let mut now = 30_000;
        let mut started = None;
        while now < 34_000 {
            now += 200;
            if let Some(batch) = core.due(now) {
                started = Some((batch, now));
                break;
            }
            request(&mut core, now, Depth::Verify, "s");
        }
        let (batch, at) = started.expect("cap reached");
        assert_eq!(batch.job_id, stream.job_id);
        assert!((33_000..=33_200).contains(&at), "{at}");
    }

    #[test]
    fn depth_parse_round_trips() {
        for depth in [Depth::Verify, Depth::Links, Depth::Full] {
            assert_eq!(Depth::parse(depth.as_str()), Some(depth));
        }
        assert_eq!(Depth::parse("everything"), None);
        assert!(Depth::Verify < Depth::Links && Depth::Links < Depth::Full);
    }

    #[test]
    fn job_status_serializes_to_the_ts_shape() {
        let batch = Batch {
            job_id: 7,
            depth: Depth::Links,
            reasons: BTreeSet::from(["target".to_string()]),
            refresh_detection: false,
            first_ms: 0,
            last_ms: 0,
            queued_at: "2026-10-07T10:42:00Z".to_string(),
        };
        let value = serde_json::to_value(DeliveryJobStatus::from_batch(&batch, "queued")).unwrap();
        for key in [
            "jobId",
            "phase",
            "depth",
            "reasons",
            "queuedAt",
            "startedAt",
            "finishedAt",
            "waitingFor",
            "agents",
            "changedTargets",
            "snapshotStale",
            "error",
        ] {
            assert!(value.get(key).is_some(), "{key}");
        }
        assert!(value["error"].is_null());
        assert_eq!(value["depth"], "links");
    }
}
