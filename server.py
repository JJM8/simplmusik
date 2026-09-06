#!/usr/bin/env python3
"""simplmusik backend - the thin layer the UI talks to.

Two jobs, and deliberately no more:
  1. Relay commands to the `simplmusik` CLI, which stays the only thing that
     ever touches playback, the library or your settings. Every mutation the
     page makes is a CLI call.
  2. Serve what a CLI can't: cover art bytes and tag metadata, and the other
     way round, the bytes of a picture dropped on a playlist - which go to a
     file and then straight back through the CLI, so setting cover art from
     the window is the same `cover` command a terminal would run. Where we are
     in the song comes from the player's own state file, which records it.

The CLI is imported rather than re-implemented here. Which folder is your
music folder, what a playlist holds and where each of its songs actually went
are questions with exactly one right answer, and importing is how the window
and a terminal are guaranteed to get the same one.

A song's filename is its identity everywhere - which, with the playlist the
player was started on, is what lets the UI highlight the playing row in the
list it is playing from and nowhere else. A playlist song that isn't in your
music folder is still sent, marked missing, so the row can say so instead of
vanishing.

Reachable from your own network and nowhere else - see `allowed` below. A
name from the page is only ever looked up in the songs we found ourselves, so
it can't point at anything else on the disk.
"""

import http.server, importlib.machinery, importlib.util, ipaddress, json
import mimetypes, os, socketserver, subprocess, sys, tempfile, threading, time
from urllib.parse import urlparse, parse_qs, quote

HERE = os.path.dirname(os.path.abspath(__file__))
CLI = os.path.join(HERE, "simplmusik")
WEB = os.path.join(HERE, "web")

def load_cli():
    """Import the CLI, which has no .py on the end of it."""
    loader = importlib.machinery.SourceFileLoader("simplmusik_cli", CLI)
    spec = importlib.util.spec_from_loader(loader.name, loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod

sm = load_cli()
sm.migrate()                    # the config and the playlists both moved, once

# yt-dlp is imported the first time something wants it, which costs a fifth of
# a second or so. This process outlives every command it runs, so importing it
# here means that is paid once, at startup, instead of by whoever asks first -
# and on a thread, so the window is being served while it happens.
threading.Thread(target=sm.ytdlp, daemon=True).start()

# Commands the UI is allowed to invoke. Anything else is refused, so a stray
# request can never turn into an arbitrary subprocess.
ALLOWED = {"status", "folder", "songs", "list", "create", "add", "remove",
           "delete", "rename", "cover", "play", "shuffle", "levelling", "pause",
           "resume", "skip", "back", "seek", "stop", "search", "download",
           "stream", "volume", "target"}

# Most commands are a file read and answer at once. These two go to the network
# instead, and a download re-encodes what it fetched, so they get their own
# ceiling rather than dragging the common one up to meet them.
# `stream` is not one of the slow ones: it looks the song up and hands the URL
# to mpv, and the download it starts runs on behind it in its own process - so
# it answers in about the time a search does, not the time a download does.
SLOW = {"search": 60, "download": 900, "folder": 900, "stream": 60}

# ------------------------------------------------------------------- the CLI

def cli(args, timeout=20):
    """Run the CLI in --json mode and hand back what it said."""
    if not args or args[0] not in ALLOWED:
        return {"ok": False, "error": "command not allowed: %s" % (args[:1] or "")}
    try:
        p = subprocess.run([sys.executable, CLI, "--json"] + [str(a) for a in args],
                           capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        return {"ok": False, "error": str(e)}
    try:
        data = json.loads(p.stdout or "null")
    except ValueError:
        data = p.stdout.strip() or None
    return {"ok": p.returncode == 0, "code": p.returncode, "data": data,
            "error": (data or {}).get("error") if isinstance(data, dict) else None}

# ------------------------------------------------------------------ the disk
# Walking your music folder is the one thing here that touches the whole disk,
# and the page asks for a cover per row. So one walk is held for a moment and
# shared: long enough that a screenful of covers costs a single walk, short
# enough that a song you just copied in turns up while you're still looking.

_idx = {"at": 0.0, "map": {}}
_idx_lock = threading.Lock()

def index(maxage=3.0):
    with _idx_lock:
        if time.time() - _idx["at"] > maxage:
            _idx["map"], _idx["at"] = sm.index(), time.time()
        return _idx["map"]

def restale():
    """Throw the held walk away. A command that has just changed what is on
    disk knows more than a walk taken up to three seconds before it ran, and
    the page asks what the library is the moment such a command answers - so
    without this it is told, authoritatively, that the song it just deleted is
    still there, and puts the row back."""
    with _idx_lock:
        _idx["at"] = 0.0

# Commands that can change what a walk would find. `folder` moves the whole
# library; the rest add or remove one file or one playlist.
CHANGES = {"remove", "delete", "create", "add", "rename", "cover", "download",
           "folder"}

def song_path(name):
    """Where a song the page named is, or None. Only names we found ourselves
    resolve, so nothing sent from the page can reach outside your folder."""
    return index().get(os.path.basename(name or ""))

# Tags are read once per file and kept until the file changes on disk, so
# scrolling a big library never re-parses anything.

_tags = {}
_tags_lock = threading.Lock()

def tags(path):
    """title / artist / album / duration for one song, best effort."""
    try:
        key = (path, os.path.getmtime(path))
    except OSError:
        return {}
    with _tags_lock:
        if key in _tags:
            return _tags[key]
    info = {}
    try:
        import mutagen
        a = mutagen.File(path, easy=True)
        if a is not None:
            g = lambda k: (a.get(k) or [None])[0]
            info = {"title": g("title"), "artist": g("artist"), "album": g("album"),
                    "duration": round(a.info.length, 1) if a.info else None}
    except Exception:
        pass
    info = {k: v for k, v in info.items() if v}
    with _tags_lock:
        _tags[key] = info
    return info

def song_entry(name, path):
    """One song as the UI wants it. `file` is its whole identity; `path` is
    None for a song a playlist names that isn't in your music folder - it is
    still a row, it just says so."""
    t = tags(path) if path else {}
    stem = os.path.splitext(name)[0]
    return {"file": name, "rel": name, "missing": path is None,
            "title": t.get("title") or stem, "artist": t.get("artist") or "",
            "album": t.get("album") or "", "duration": t.get("duration"),
            "folder": os.path.dirname(path) if path else ""}

def playlists():
    """Every playlist, most recently changed first - the order both the sidebar
    and the add-to-playlist menu use, decided here so there is one answer to it.
    The file's own timestamp is the whole mechanism: adding a song rewrites the
    playlist, which is what makes it recent. Nothing is stored to track it, and
    editing a playlist by hand counts too, which is what you'd want."""
    out = []
    for p in sm.playlists():
        try:
            mtime = os.path.getmtime(sm.playlist_file(p["file"]))
        except OSError:
            mtime = 0
        out.append(dict(p, mtime=mtime))
    out.sort(key=lambda p: (-p["mtime"], p["name"].lower()))
    return out

def library():
    """The whole library plus every playlist. Playlists carry filenames only;
    the page looks the details up in `songs`, so a song shared by five
    playlists is still sent once."""
    songs = {n: song_entry(n, p) for n, p in index().items()}
    pls = []
    for p in playlists():
        names = [s["file"] for s in p["songs"]]
        for n in names:
            songs.setdefault(n, song_entry(n, None))    # named but not found
        pls.append({"file": p["file"], "name": p["name"], "songs": names,
                    "count": len(names), "mtime": p["mtime"],
                    "cover": cover_url(p)})
    for p in pls:
        p["duration"] = sum(songs[n]["duration"] or 0 for n in p["songs"])
    ordered = sorted(songs.values(), key=lambda s: s["file"].lower())
    return {"root": sm.folder(), "playlists": pls, "songs": ordered,
            "playlists_dir": sm.playlists_dir(), "levelling": sm.levelling(), "picker": bool(sm.chooser()),
            "target": sm.target(),
            # The ends of the target slider, so the page can't offer a setting
            # the CLI would refuse - there is one place they are decided.
            "target_range": [sm.TARGET_LO, sm.TARGET_HI],
            "cover_max": sm.COVER_MAX,   # so the page turns away a picture too big
            "duration": sum(s["duration"] or 0 for s in ordered)}

# ------------------------------------------------------------------ cover art

def cover_url(pl):
    """Where the page should ask for a playlist's own artwork, or None if it
    hasn't any. The picture's own timestamp rides along in the address, so a
    cover you just changed is a new address and no browser can hand you back
    the one it was showing a second ago."""
    try:
        v = int(os.path.getmtime(pl["cover"])) if pl.get("cover") else 0
    except OSError:
        return None
    return "/api/playlist-cover?pl=%s&v=%d" % (quote(pl["file"]), v) if v else None

def playlist_cover(name):
    """One playlist's artwork as (bytes, content type), or (None, None). The
    name is resolved through the CLI's own lookup, so only a playlist that
    exists resolves at all and what comes back is a file the CLI put there."""
    stem = sm.find(name or "")
    path = sm.cover_path(stem) if stem else None
    kind = sm.image_kind(path) if path else None
    if not kind:
        return None, None
    try:
        with open(path, "rb") as f:
            return f.read(), "image/" + ("jpeg" if kind == "jpg" else kind)
    except OSError:
        return None, None

def take_cover(stem, body):
    """A picture dropped on a playlist in the window. It goes to a file and
    then in through `cover`, which is the command a terminal would run - so
    the CLI is still the only thing that edits a playlist, and it is the CLI
    that decides whether those bytes are an image at all."""
    fd, tmp = tempfile.mkstemp(prefix="simplmusik-cover-")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(body)
        return cli(["cover", stem, tmp])
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass

_cover_cache = {}

def cover_bytes(path):
    """Embedded artwork for a song, or None. There is no folder to fall back
    to: a folder holds whatever you happened to put in it, so a cover.jpg
    there would be every song's cover, which is worse than none."""
    try:
        key = (path, os.path.getmtime(path))
    except OSError:
        return None
    if key in _cover_cache:
        return _cover_cache[key]
    data = None
    try:
        import mutagen
        a = mutagen.File(path)
        if a is not None:
            for tag in (getattr(a, "tags", None) or {}):
                if str(tag).startswith("APIC"):            # mp3
                    data = a.tags[tag].data
                    break
            if data is None and getattr(a, "pictures", None):   # flac / ogg
                data = a.pictures[0].data
            if data is None and isinstance(getattr(a, "tags", None), dict):
                cov = a.tags.get("covr")                   # m4a
                if cov:
                    data = bytes(cov[0])
    except Exception:
        data = None
    if len(_cover_cache) > 500:
        _cover_cache.clear()
    _cover_cache[key] = data
    return data

# -------------------------------------------------------------- play state
# The state file names the song; how far into it we are comes from `position`,
# which asks the mpv that is playing it. So a seek or a pause is reflected
# exactly, and there is no clock here to drift out of step with the player.

def playing():
    """The player's state, or {} if nothing is playing."""
    try:
        with open(sm.STATE) as f:
            st = json.load(f)
        os.kill(int(st.get("pid") or 0), 0)          # player still alive?
        return st
    except (OSError, ValueError, TypeError):
        return {}

def downloads():
    """Downloads running right now, keyed by video id, as the CLI reports them.
    Each download process writes its own file and deletes it when it finishes,
    so a live entry is one whose process is still there - which is also how a
    download killed halfway disappears, with nothing here to time out."""
    out = {}
    for f in sorted(os.listdir(sm.DLDIR)) if os.path.isdir(sm.DLDIR) else []:
        if not f.endswith(".json"):
            continue
        path = os.path.join(sm.DLDIR, f)
        try:
            with open(path) as fh:
                d = json.load(fh)
            # Filling the cache behind a song being played is not a download
            # anyone asked to wait for, so it is not reported as one. It is
            # written down all the same - `download` reads it to tell a song
            # already on its way from one nobody has started.
            if d.get("stage") == "caching":
                continue
            # A fetch that failed names no live pid, and is kept rather than
            # tidied away: the point of it is to be seen. Asking for the song
            # again is what clears it.
            if d.get("stage") != "failed":
                os.kill(int(d.get("pid") or 0), 0)     # still downloading?
        except (OSError, ValueError, TypeError):
            try:
                os.remove(path)      # its process died without tidying up
            except OSError:
                pass
            continue
        out[str(d.get("id") or f[:-5])] = {"stage": d.get("stage") or "downloading",
                                           "percent": d.get("percent"),
                                           "error": d.get("error")}
    return out

def prefetch(vid):
    """Look a song up before anybody has asked to play it.

    In this process rather than out in a subprocess, which is the whole of the
    saving: a lookup is a read, reads already happen here, and yt-dlp is
    already imported. What it learns is written where `stream` looks first, so
    pressing play a moment later has nothing left to wait for.

    Nobody is waiting on the answer, so a failure is not worth reporting -
    the stream that follows simply looks the song up itself, the way it did
    before any of this."""
    vid = sm.video_id(vid or "")
    if not vid:
        return {"ok": False}
    try:
        sm.resolve(vid)         # its own cache is the point; the answer is not
        return {"ok": True}
    except Exception:
        return {"ok": False}

def snapshot():
    st = playing()
    dls = downloads()          # rides along on the poll the page already makes
    # Shuffle and volume are settings rather than properties of what is
    # playing, so they are reported either way - the button and the slider in
    # the page are set by them even with nothing going, which is the whole
    # point of their being settings.
    if not st:
        return {"playing": False, "shuffle": sm.shuffling(),
                "volume": sm.volume(), "downloads": dls}
    song = st.get("song", "")
    # The player worked out every path when the queue was built, so the file
    # it is holding open is known exactly, even if the song has since moved.
    path = (st.get("paths") or {}).get(song) or song_path(song)
    duration = (tags(path) or {}).get("duration") if path else None
    if duration is None and sm.remote(path):
        # A stream has no file to read a length off, so mpv is asked for the
        # one it worked out from the source itself. Without this the slider has
        # no end to draw and nothing to seek against - the whole of what makes
        # a streamed song feel unlike a downloaded one.
        try:
            duration = round(float(sm.ask_mpv("duration")), 1)
        except (TypeError, ValueError):
            duration = None
    elapsed = sm.position(st)
    if duration:
        elapsed = min(elapsed, duration)   # never report past the end
    return {"playing": True, "paused": bool(st.get("paused")),
            "song": song, "playlist": st.get("playlist"),
            "rel": song, "index": st.get("index", 0),
            "queue": len(st.get("songs") or []),
            "shuffle": sm.shuffling(),
            "volume": sm.volume(),
            "elapsed": round(elapsed, 1),
            "duration": duration,
            "downloads": dls,
            "meta": tags(path) if path else {}}

# ------------------------------------------------------------------- access
# Two questions, and the answer to one is not the answer to the other.
#
# *Who connected?* Only your own machine, or another on your own network, has
# any business here. Anything from beyond it is refused before it is read.
#
# *Who put them up to it?* A page on any website you happen to open runs in a
# browser on your network, so it clears the first question with room to spare -
# and `remove SONG` deletes a file whether or not that page is allowed to read
# the reply. So that question is a different one, and the browser answers it:
# a request it makes on behalf of another site says whose it is in `Origin`,
# and only a page we served ourselves names us. `Host` is checked from the
# other end for the same reason, since a domain pointed at this machine would
# otherwise be a way for a site to claim to be us.

def local(host):
    """Is this address on your own network - or this machine?"""
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    if ip.version == 6 and ip.ipv4_mapped:      # ::ffff:192.168.1.5 is v4 here
        ip = ip.ipv4_mapped
    return ip.is_loopback or ip.is_private or ip.is_link_local

def hostport(s):
    """(host, port) out of a Host header or an Origin, brackets and all."""
    try:
        u = urlparse(s if "//" in s else "//" + s)
        return u.hostname, u.port
    except ValueError:
        return None, None

def allowed(handler):
    """Whether to answer this request at all."""
    if not local(handler.client_address[0]):
        return False                            # not from your network
    host, _ = hostport(handler.headers.get("Host") or "")
    if not (host == "localhost" or local(host or "")):
        return False                            # a domain aimed at this machine
    origin = handler.headers.get("Origin")
    if not origin:
        return True                             # not a browser acting for a site
    return hostport(origin) == hostport(handler.headers.get("Host") or "")

# ------------------------------------------------------------------- server

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "simplmusik"

    def log_message(self, *a):
        pass                                          # quiet by default

    def send_json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_blob(self, data, ctype, cache=True):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=3600" if cache else "no-store")
        self.end_headers()
        self.wfile.write(data)

    def guard(self):
        """403 and False if this request isn't ours to answer."""
        if allowed(self):
            return True
        self.send_json({"error": "forbidden"}, 403)
        return False

    def do_GET(self):
        if not self.guard():
            return
        u = urlparse(self.path)
        q = parse_qs(u.query)
        path = u.path

        if path == "/api/library":
            return self.send_json(library())
        if path == "/api/prefetch":
            return self.send_json(prefetch((q.get("id") or [""])[0]))
        if path == "/api/state":
            return self.send_json(snapshot())
        if path == "/api/cover":
            full = song_path((q.get("rel") or [""])[0])
            data = cover_bytes(full) if full else None
            if not data:
                return self.send_json({"error": "no cover"}, 404)
            kind = "image/png" if data[:4] == b"\x89PNG" else "image/jpeg"
            return self.send_blob(data, kind)
        if path == "/api/playlist-cover":
            data, kind = playlist_cover((q.get("pl") or [""])[0])
            if not data:
                return self.send_json({"error": "no cover"}, 404)
            return self.send_blob(data, kind)

        # static frontend
        name = "index.html" if path == "/" else path.lstrip("/")
        f = os.path.realpath(os.path.join(WEB, name))
        if not f.startswith(WEB + os.sep) or not os.path.isfile(f):
            return self.send_json({"error": "not found"}, 404)
        with open(f, "rb") as fh:
            self.send_blob(fh.read(), mimetypes.guess_type(f)[0] or "text/plain",
                           cache=False)

    def do_POST(self):
        if not self.guard():
            return
        u = urlparse(self.path)
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self.send_json({"ok": False, "error": "bad request"}, 400)

        # The one request here that isn't a command: the bytes of a picture,
        # which have nowhere to go in a JSON command line.
        if u.path == "/api/playlist-cover":
            if n > sm.COVER_MAX:
                return self.send_json({"ok": False, "error": "that image is bigger "
                                       "than %d MB" % (sm.COVER_MAX >> 20)}, 413)
            pl = (parse_qs(u.query).get("pl") or [""])[0]
            stem = sm.find(pl)
            if not stem:
                return self.send_json({"ok": False, "error": "no playlist '%s'" % pl}, 404)
            return self.send_json(take_cover(stem, self.rfile.read(n)))

        if u.path != "/api/cmd":
            return self.send_json({"error": "not found"}, 404)
        try:
            body = json.loads(self.rfile.read(n) or "{}")
        except ValueError:
            return self.send_json({"ok": False, "error": "bad request"}, 400)
        args = body.get("args") or []
        head = args[0] if args and isinstance(args[0], str) else None
        out = cli(args, timeout=SLOW.get(head, 20))
        if head in CHANGES:
            restale()          # the next answer is walked fresh, not remembered
        return self.send_json(out)

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

def serve(port=8777, lan=False):
    """Loopback unless you ask for the network. `allowed` is what says who may
    talk to us; this only says who can reach far enough to be asked."""
    return Server(("0.0.0.0" if lan else "127.0.0.1", port), Handler)

if __name__ == "__main__":
    args = sys.argv[1:]
    lan = "--lan" in args
    port = int(next((a for a in args if a != "--lan"), 8777))
    httpd = serve(port, lan)
    print("simplmusik ui on http://%s:%d"
          % ("0.0.0.0 (your network)" if lan else "127.0.0.1", port))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
