// No console window in release builds on Windows; harmless on macOS.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    librarium::run();
}
