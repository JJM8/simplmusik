"""What CPython can actually do on this phone.

The first milestone of the iOS port, and the only one worth seeing before any
of the app is written: an interpreter, its compiled modules, a socket, a
thread, and a folder it may write to. Everything the port depends on is one of
those five, so this asks each of them a question and puts the answers on a
page.

It is served rather than printed because the page is also the test: a window
showing it is a WKWebView that has loaded `http://127.0.0.1` out of a server
run by Python inside the app, which is precisely the arrangement the whole app
rests on. If this page appears on the phone, the port is a matter of writing
code rather than of finding out whether it can be done.

Run on a desktop it does the same thing, minus the parts about being on a
phone - `python3 ios/selftest.py` and open the address it prints.
"""

import http.server
import io
import json
import os
import platform
import socket
import socketserver
import sys
import threading
import traceback


def check(name, fn):
    """One question and its answer, as a row for the page.

    Every check is wrapped: a failure here is a result to report, not a reason
    for the app to come up blank. The one thing worse than a phone that cannot
    import ssl is not being told which import it was."""
    try:
        return {"name": name, "ok": True, "detail": str(fn())}
    except Exception as e:
        return {"name": name, "ok": False,
                "detail": "%s: %s" % (type(e).__name__, e)}


def _write_read(folder):
    """Whether a folder is ours to write in, answered by writing in it."""
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, ".simplmusik-selftest")
    with open(path, "w") as f:
        f.write("ok")
    with open(path) as f:
        got = f.read()
    os.remove(path)
    return "%s (%s)" % (folder, got)


def _threads():
    """A thread that runs is the whole of the requirement: the player loop and
    every download the app starts are threads rather than processes here."""
    box = []
    t = threading.Thread(target=lambda: box.append(threading.current_thread().name))
    t.start()
    t.join(5)
    return box[0] if box else "thread never ran"


def _subprocess():
    """Expected to fail, and the failure is the point.

    iOS does not let an app start another program, which is why `detach` in the
    CLI runs a thread when `SIMPLMUSIK_EMBEDDED` is set, and why there is no
    ffmpeg and no mpv here. This records how it fails, because the CLI catches
    `OSError` around every call it makes - and a different exception escaping
    would be a bug to find now rather than on a phone in your pocket."""
    import subprocess
    subprocess.run([sys.executable or "/bin/ls"], capture_output=True, timeout=5)
    return "started a process - unexpected on iOS, fine on a desktop"


def results():
    """Every answer, newest question last."""
    music = os.environ.get("SIMPLMUSIK_FOLDER", os.path.expanduser("~/Music"))
    home = os.environ.get("HOME", "?")
    checks = [
        check("python", lambda: sys.version.split()[0] + " on " + sys.platform),
        check("platform", lambda: "%s %s" % (platform.system(), platform.release())),
        check("ssl", lambda: __import__("ssl").OPENSSL_VERSION),
        check("hashlib", lambda: __import__("hashlib").sha256(b"x").hexdigest()[:16]),
        check("sqlite3", lambda: "sqlite " + __import__("sqlite3").sqlite_version),
        check("zlib", lambda: "zlib " + __import__("zlib").ZLIB_VERSION),
        check("ctypes", lambda: "libffi loaded, sizeof(void*)=%d"
              % __import__("ctypes").sizeof(__import__("ctypes").c_void_p)),
        check("threads", _threads),
        check("home is writable", lambda: _write_read(home)),
        check("music folder is writable", lambda: _write_read(music)),
        check("songs in music folder", lambda: sum(
            len(files) for _, _, files in os.walk(music))),
        check("mutagen", lambda: "version " + ".".join(
            str(n) for n in __import__("mutagen").version)),
        check("yt-dlp", lambda: __import__("yt_dlp").version.__version__),
        check("subprocess (expected to fail on iOS)", _subprocess),
    ]
    return checks


PAGE = """<!doctype html>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>simplmusik self-test</title>
<style>
  :root { color-scheme: dark light; --accent: #ff7139; }
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 0;
         padding: 24px 18px 40px; background: #16171a; color: #e8e8ea; }
  h1 { font-size: 19px; margin: 0 0 4px; color: var(--accent); }
  p.sub { margin: 0 0 20px; opacity: .6; font-size: 13px; }
  .row { display: flex; gap: 10px; padding: 9px 0;
         border-bottom: 1px solid #2a2c31; align-items: baseline; }
  .mark { width: 1.2em; flex: none; }
  .ok .mark { color: #4ec26a; } .bad .mark { color: #e5484d; }
  .name { flex: none; width: 11em; font-weight: 600; }
  .detail { opacity: .8; font-family: ui-monospace, monospace; font-size: 12px;
            word-break: break-word; }
  @media (prefers-color-scheme: light) {
    body { background: #fff; color: #16171a; } .row { border-color: #e6e6e9; }
  }
</style>
<h1>simplmusik on iOS</h1>
<p class=sub>%(summary)s</p>
%(rows)s
"""


def page():
    checks = results()
    good = sum(1 for c in checks if c["ok"])
    rows = "\n".join(
        '<div class="row %s"><span class=mark>%s</span>'
        '<span class=name>%s</span><span class=detail>%s</span></div>'
        % ("ok" if c["ok"] else "bad", "OK" if c["ok"] else "X",
           _esc(c["name"]), _esc(c["detail"]))
        for c in checks)
    return (PAGE % {"summary": "%d of %d checks passed" % (good, len(checks)),
                    "rows": rows}).encode()


def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = page() if self.path != "/json" else json.dumps(
            results(), indent=2).encode()
        kind = "text/html" if self.path != "/json" else "application/json"
        self.send_response(200)
        self.send_header("Content-Type", kind + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass            # the device log has enough in it already


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def serve():
    """Start the server and answer with its port, having also written the port
    where Swift can read it.

    Port 0 is whichever one is free - the page is only ever reached from inside
    this app, so the number matters to nobody, which is the same reason the
    Android build picks one that way."""
    httpd = Server(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True,
                     name="simplmusik-selftest").start()
    home = os.environ.get("HOME")
    if home:
        with open(os.path.join(home, "selftest-port"), "w") as f:
            f.write(str(port))
    print("simplmusik self-test on http://127.0.0.1:%d/" % port, flush=True)
    return port


if __name__ == "__main__":
    serve()
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
