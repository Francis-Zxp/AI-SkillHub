//! Keeps the WebView small while nobody is looking at it.
//!
//! Measured on 3.2.18 (reports/v3.3-work/research-memory.md): a minimized
//! window still rendered the 3D islands at full rate (~330 MB), because Tauri
//! never tells WebView2 that the window is hidden. Hiding the WebView2
//! controller and asking for the Low memory target brought the same page to
//! ~5–15 MB; an unfocused, visible window settles around 80–100 MB with the
//! Low target. This module does exactly that, and tells the page so it can
//! pause and release its own heavy resources (the 3D scene):
//!
//! - minimized: controller hidden + Low, page event `app-visibility` = hidden;
//! - unfocused for [`BACKGROUND_DELAY`]: Low, page event = background;
//!   re-applied every [`REAPPLY_EVERY`] because Chromium drifts back up;
//! - restored or focused: controller visible + Normal, page event = visible.
//!
//! Every WebView2 call is best effort: an older runtime without
//! `ICoreWebView2_19` simply keeps its normal memory behaviour.

use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{Emitter, Manager, Runtime, Window, WindowEvent};

/// How long the window must stay unfocused before memory is trimmed.
const BACKGROUND_DELAY: Duration = Duration::from_secs(20);
/// Chromium slowly grows back while the Low target is held; nudge it again.
const REAPPLY_EVERY: Duration = Duration::from_secs(240);

/// Page-facing event name; payload is [`VisibilityPayload`].
pub const APP_VISIBILITY_EVENT: &str = "app-visibility";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
enum Mode {
    Visible = 0,
    Background = 1,
    Hidden = 2,
}

impl Mode {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Mode::Background,
            2 => Mode::Hidden,
            _ => Mode::Visible,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Mode::Visible => "visible",
            Mode::Background => "background",
            Mode::Hidden => "hidden",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VisibilityPayload {
    state: &'static str,
}

/// Shared state, one per app. `generation` invalidates pending timers.
#[derive(Default)]
pub struct MemorySaver {
    mode: AtomicU8,
    generation: AtomicU64,
}

impl MemorySaver {
    fn mode(&self) -> Mode {
        Mode::from_u8(self.mode.load(Ordering::SeqCst))
    }

    fn bump(&self) -> u64 {
        self.generation.fetch_add(1, Ordering::SeqCst) + 1
    }
}

/// Wire into `Builder::on_window_event`. Only the main window is managed.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    let Some(saver) = window.try_state::<Arc<MemorySaver>>() else {
        return;
    };
    let saver = saver.inner().clone();
    let minimized = window.is_minimized().unwrap_or(false);
    match event {
        WindowEvent::Resized(_) if minimized => {
            saver.bump();
            apply(window, &saver, Mode::Hidden);
        }
        WindowEvent::Resized(_) if saver.mode() == Mode::Hidden => {
            saver.bump();
            apply(window, &saver, Mode::Visible);
            // Restored behind another window: visible now, trimmed later.
            if !window.is_focused().unwrap_or(true) {
                schedule_background(window.clone(), saver);
            }
        }
        WindowEvent::Focused(true) => {
            saver.bump();
            if !minimized && saver.mode() != Mode::Visible {
                apply(window, &saver, Mode::Visible);
            }
        }
        WindowEvent::Focused(false) if saver.mode() == Mode::Visible && !minimized => {
            saver.bump();
            schedule_background(window.clone(), saver);
        }
        _ => {}
    }
}

fn schedule_background<R: Runtime>(window: Window<R>, saver: Arc<MemorySaver>) {
    let generation = saver.generation.load(Ordering::SeqCst);
    std::thread::spawn(move || {
        std::thread::sleep(BACKGROUND_DELAY);
        if saver.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if window.is_focused().unwrap_or(true) || window.is_minimized().unwrap_or(false) {
            return;
        }
        apply(&window, &saver, Mode::Background);
        loop {
            std::thread::sleep(REAPPLY_EVERY);
            if saver.generation.load(Ordering::SeqCst) != generation
                || saver.mode() != Mode::Background
            {
                return;
            }
            // Normal → Low again prompts another trim pass.
            set_memory_target(&window, false);
            set_memory_target(&window, true);
        }
    });
}

fn apply<R: Runtime>(window: &Window<R>, saver: &MemorySaver, mode: Mode) {
    let previous = Mode::from_u8(saver.mode.swap(mode as u8, Ordering::SeqCst));
    if previous == mode {
        return;
    }
    // Tell the page first so it can pause and release before the trim.
    let _ = window.emit(
        APP_VISIBILITY_EVENT,
        VisibilityPayload {
            state: mode.label(),
        },
    );
    match mode {
        Mode::Hidden => {
            set_controller_visible(window, false);
            set_memory_target(window, true);
        }
        Mode::Background => set_memory_target(window, true),
        Mode::Visible => {
            set_controller_visible(window, true);
            set_memory_target(window, false);
        }
    }
}

#[cfg(windows)]
fn set_memory_target<R: Runtime>(window: &Window<R>, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;
    let Some(webview) = window.get_webview_window("main") else {
        return;
    };
    let _ = webview.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };
        if let Ok(core) = core.cast::<ICoreWebView2_19>() {
            let level = if low {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            };
            let _ = core.SetMemoryUsageTargetLevel(level);
        }
    });
}

#[cfg(windows)]
fn set_controller_visible<R: Runtime>(window: &Window<R>, visible: bool) {
    let Some(webview) = window.get_webview_window("main") else {
        return;
    };
    let _ = webview.with_webview(move |platform| unsafe {
        let _ = platform.controller().SetIsVisible(visible);
    });
}

#[cfg(not(windows))]
fn set_memory_target<R: Runtime>(_window: &Window<R>, _low: bool) {}

#[cfg(not(windows))]
fn set_controller_visible<R: Runtime>(_window: &Window<R>, _visible: bool) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_round_trip_and_label() {
        for mode in [Mode::Visible, Mode::Background, Mode::Hidden] {
            assert_eq!(Mode::from_u8(mode as u8), mode);
        }
        assert_eq!(Mode::Hidden.label(), "hidden");
        assert_eq!(Mode::Background.label(), "background");
        assert_eq!(Mode::Visible.label(), "visible");
        assert_eq!(Mode::from_u8(9), Mode::Visible);
    }

    #[test]
    fn bump_invalidates_earlier_generations() {
        let saver = MemorySaver::default();
        let first = saver.bump();
        let second = saver.bump();
        assert!(second > first);
        assert_eq!(saver.generation.load(Ordering::SeqCst), second);
    }
}
