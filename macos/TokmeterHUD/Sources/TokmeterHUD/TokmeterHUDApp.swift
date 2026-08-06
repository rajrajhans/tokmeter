import AppKit
import SwiftUI

@main
struct TokmeterHUDApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup("tokmeter") {
            ContentView()
        }
        .defaultSize(width: 440, height: 560)
        .commands {
            CommandGroup(replacing: .newItem) {}
        }
    }
}

/// Normal Dock app — user can move, resize, and Cmd-Tab to it.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}
