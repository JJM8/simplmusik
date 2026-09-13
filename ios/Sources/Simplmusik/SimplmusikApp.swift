import SwiftUI
import WebKit

/// The window.
///
/// As on Android, there is deliberately almost nothing here: the interface is
/// the page the desktop shows, served by the same backend off the same disk,
/// and this is the frame it is shown in.
///
/// What it shows first, though, is the self-test - the app's own
/// `selftest.py`, which reports what CPython could do on this phone. It is the
/// first milestone of the port and the thing worth seeing on the device before
/// any of the rest is written.
@main
struct SimplmusikApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
                .ignoresSafeArea(edges: .bottom)
        }
    }
}

struct ContentView: View {
    @State private var url: URL?
    @State private var failure: String?

    var body: some View {
        Group {
            if let url {
                WebView(url: url)
            } else if let failure {
                ScrollView {
                    Text(failure)
                        .font(.system(.footnote, design: .monospaced))
                        .padding()
                }
            } else {
                ProgressView("Starting Python...")
            }
        }
        .task {
            // Off the main thread: starting an interpreter and reading a
            // folder of songs are both slow enough to drop frames, and the
            // window is meant to be up before either finishes.
            let result = await Task.detached(priority: .userInitiated) { () -> Startup in
                PythonRuntime.start()
                guard PythonRuntime.run("import selftest; selftest.serve()") else {
                    return .failed("Python started but selftest.serve() failed.\n"
                                   + "The traceback is in the device log: idevicesyslog.")
                }
                guard let port = SelftestPort.read(), port > 0 else {
                    return .failed("selftest.py ran but never wrote its port file.")
                }
                return .ready(Int(port))
            }.value

            switch result {
            case .ready(let port):
                url = URL(string: "http://127.0.0.1:\(port)/")
            case .failed(let message):
                failure = message
            }
        }
    }
}

/// How starting up went: a page to show, or something to say about why there
/// isn't one. An enum rather than a `Result` because the failure here is a
/// sentence for a person to read, and a bare `String` is not an `Error`.
enum Startup: Sendable {
    case ready(Int)
    case failed(String)
}

/// The port the self-test's server picked, which it writes into a file under
/// `HOME` because a number is easier to pass through a file than through the C
/// API. The real app will get its port back from `bring_up` directly.
enum SelftestPort {
    static func read() -> Int32? {
        let file = PythonRuntime.home.appendingPathComponent("selftest-port")
        for _ in 0..<100 {                      // up to 10s; a first run unpacks
            if let text = try? String(contentsOf: file, encoding: .utf8),
               let port = Int32(text.trimmingCharacters(in: .whitespacesAndNewlines)) {
                return port
            }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return nil
    }
}

/// A web view, which SwiftUI has no wrapper of its own for.
struct WebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView()
        view.isInspectable = true       // so Safari's inspector can reach it
        view.load(URLRequest(url: url))
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
}
