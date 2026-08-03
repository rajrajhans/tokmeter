import AppKit
import SwiftUI

@main
struct TokmeterHUDApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra {
            ContentView()
        } label: {
            // `gauge` is available on macOS 13+; needle variants need 14+.
            Label("tokmeter", systemImage: "gauge.medium")
        }
        .menuBarExtraStyle(.window)
    }
}

/// Accessory app: no dock icon, menu-bar only.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }
}
