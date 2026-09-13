import Foundation
import Python

/// Starting the interpreter that everything above this file is written in.
///
/// The app bundle holds two Python things, laid out the way CPython expects to
/// find them: `python/lib/python3.x`, which is the standard library, and
/// `app/`, which is the CLI, the backend and the page staged out of the
/// repository root. The first is put there by `install_python.py` at build
/// time; the second by xtool, because `xtool.yml` names it a resource.
///
/// Nothing here is iOS-specific except where those two folders are. An
/// interpreter is started, `sys.path` is pointed at both of them, and a Python
/// entry point is called - which is the same shape the Android build has, and
/// for the same reason: the app is the Python, and this is the part that
/// switches it on.
enum PythonRuntime {

    /// Where the app's own files live, inside the bundle. Read-only: iOS signs
    /// the bundle and will not let a process write into it, which is why
    /// `HOME` below points somewhere else entirely.
    static var bundleRoot: URL { Bundle.main.bundleURL }

    /// The one writable place, and what `~` means on this phone. Everything
    /// the CLI keeps - config, state, caches - lands under here.
    static var home: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Home")
    }

    /// Your music, in the folder iOS shows in Files under On My iPhone. It is
    /// the app's own Documents folder, which is the only folder that can be
    /// both visible to you and writable by the app without asking anything.
    static var music: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    /// Bring the interpreter up, however many times it is asked for.
    ///
    /// Starting one twice in a process is a crash rather than an error, so
    /// this has to happen exactly once. The once is a lazy `static let`, which
    /// Swift runs on the first read and makes every other caller wait for: a
    /// flag of our own would be shared mutable state, which Swift 6 refuses,
    /// and it would be a race besides.
    static func start() { _ = bootstrap }

    private static let bootstrap: Void = {
        let python = bundleRoot.appendingPathComponent("python")
        let stdlib = python.appendingPathComponent("lib").appendingPathComponent(pythonVersion)
        let app = bundleRoot.appendingPathComponent("app")

        for dir in [home, music] {
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }

        // Set before the interpreter reads any of them. `PYTHONHOME` is what
        // tells CPython where its own standard library is; the rest are the
        // settings the iOS build asks for - no bytecode, since the bundle is
        // read-only, and unbuffered output so a log line appears when it is
        // written rather than when something happens to flush it.
        setenv("PYTHONHOME", python.path, 1)
        setenv("PYTHONPATH", [stdlib.path,
                              stdlib.appendingPathComponent("lib-dynload").path,
                              app.path].joined(separator: ":"), 1)
        setenv("PYTHONDONTWRITEBYTECODE", "1", 1)
        setenv("PYTHONUNBUFFERED", "1", 1)
        setenv("PYTHONUTF8", "1", 1)

        // What the CLI reads to know where it is. The same three the Android
        // bootstrap sets, and they mean the same things here.
        setenv("HOME", home.path, 1)
        setenv("XDG_CACHE_HOME", home.appendingPathComponent(".cache").path, 1)
        setenv("SIMPLMUSIK_EMBEDDED", "1", 1)
        setenv("SIMPLMUSIK_FOLDER", music.path, 1)

        Py_Initialize()
    }()

    /// The standard library folder's name, which carries the version in it.
    /// Read off the disk rather than written down, so a Python upgrade is a
    /// change to `build-ipa` and to nothing else.
    private static var pythonVersion: String {
        let lib = bundleRoot.appendingPathComponent("python/lib")
        let names = (try? FileManager.default.contentsOfDirectory(atPath: lib.path)) ?? []
        return names.first { $0.hasPrefix("python3.") } ?? "python3.14"
    }

    /// Run a line of Python, the blunt way: no value comes back, and an
    /// exception prints a traceback to the log rather than being thrown. Good
    /// enough for starting things, which is all this is used for.
    @discardableResult
    static func run(_ code: String) -> Bool {
        PyRun_SimpleString(code) == 0
    }
}
