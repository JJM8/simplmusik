"""Starting simplmusik inside an Android app.

This is the whole of the Android-specific Python, and it is short on purpose.
Everything above it - the CLI, the backend, the page - is the code that runs
on a desktop, read off the disk from where `Boot.java` laid it out, unmodified
and unaware of where it is. What is left for this file is the three things
that genuinely differ:

  * where the app lives. `~` on a phone is not a place, so `HOME` is pointed
    at the app's own storage before anything reads a setting, and the music
    folder is the one the platform hands us rather than one worked out from a
    desktop's preferences.

  * that there is no second process. `SIMPLMUSIK_EMBEDDED` tells the CLI to
    run its player and its downloads as threads, which is the one thing about
    an app the CLI needed telling.

  * what plays the songs. There is no mpv here, so `Backend` below stands
    where mpv stands. It is a subclass rather than a rewrite because most of
    what the player loop wants from mpv is not about mpv at all: reading whole
    JSON messages, and waiting for either a song to end or a command to
    arrive, are inherited exactly as they are. Only starting a song, sending
    it an order and taking it away are different, because only those actually
    touch a player.

The socketpair is what makes that inheritance possible. The loop waits on a
socket for a line of JSON saying how the song ended; here, the other end of
that socket is written by this file when the platform's player says so. The
loop cannot tell, and does not ask.
"""

import importlib.machinery
import importlib.util
import json
import os
import re
import socket
import sys
import threading

# Chaquopy's own imports are deliberately not up here. Everything below except
# the last few lines of `start` is ordinary Python that a desktop can run, and
# keeping it that way means the Android bootstrap can be tested without an
# Android - which is worth more than the two lines it costs.

_state = {}


# --------------------------------------------------------------- the backend

def _make_backend(sm, playback, server=None):
    """The class the CLI will build when it wants something to play with."""

    class Backend(sm.Mpv):
        """mpv's place, filled by the platform's own player.

        Inherited unchanged from `Mpv`: `lines`, which reads whole JSON
        messages off `self.sock`, and `until_end`, which waits on that socket
        and the wake pipe together. Both work here because `self.sock` is a
        real socket - one end of a pair whose other end this class writes an
        `end-file` into when a song finishes. That is the only event the loop
        has ever cared about.
        """

        def __init__(self):
            # `sock` is what the loop selects on; `_far` is ours to write.
            self.sock, self._far = socket.socketpair()
            self.buf, self.n, self.dead = b"", 0, False
            self.proc = None            # nothing to kill: there is no process
            playback.listen(self._ended)

        @staticmethod
        def measure(path):
            """A song's (mean square, peak) in dBFS, as `Mpv.measure` answers
            with ffmpeg - which a phone does not have, and which used to leave
            every gain at 0 dB and the target moving nothing. The platform's
            decoders do the decoding instead; the arithmetic that turns the
            numbers into a gain stays in the CLI."""
            try:
                got = playback.measure(str(path))
            except Exception:
                return None
            return (float(got[0]), float(got[1])) if got is not None else None

        def _ended(self, reason):
            """Told by the player, on its own thread, how a song finished.

            Writes one line and returns. Anything slower would be done on the
            thread the audio is coming off, which is the one thread in the app
            that must never wait for anything."""
            try:
                self._far.sendall(json.dumps(
                    {"event": "end-file", "reason": str(reason)}).encode() + b"\n")
            except OSError:
                self.dead = True

        def load(self, path, db, vol, start=0.0):
            playback.load(str(path), float(db or 0.0), int(vol), float(start or 0.0))
            # What the song is, for the notification - after it has started,
            # on a thread of its own, because a cover is a read off the disk
            # and the song is not to wait for one.
            threading.Thread(target=_describe, args=(sm, server, playback, str(path)),
                             daemon=True, name="simplmusik-describe").start()

        def send(self, *cmd):
            """The player loop's whole vocabulary, which is five things.

            Written out rather than translated generally, because five is all
            there has ever been and a general translator would be a place for
            a sixth to go wrong quietly."""
            if not cmd:
                return
            head = cmd[0]
            if head == "stop":
                playback.stop()
            elif head == "seek" and len(cmd) >= 2:
                playback.seek(float(cmd[1]))
            elif head == "set_property" and len(cmd) >= 3:
                prop, value = cmd[1], cmd[2]
                if prop == "pause":
                    playback.pause(bool(value))
                elif prop == "volume":
                    playback.volume(int(value))
                elif prop == "af":
                    # The CLI hands the gain over as mpv's filter string,
                    # because on a desktop that is what it is. The number in
                    # it is the levelling, and the number is what this player
                    # wants; an empty string is a song that needs no moving.
                    m = re.search(r"volume=(-?[\d.]+)dB", str(value or ""))
                    playback.gainDb(float(m.group(1)) if m else 0.0)

        def kill(self):
            playback.stop()
            self.dead = True
            for s in (self.sock, self._far):
                try:
                    s.close()
                except OSError:
                    pass

    return Backend


AUDIO_EXT = re.compile(r"\.(mp3|m4a|mp4|aac|opus|ogg|oga|flac|wav|webm)$", re.I)


def _describe(sm, server, playback, path):
    """Tell the player what the song at `path` is: title, artist, album, cover.

    The same tags and the same cover the page shows, read by the same
    functions. A song with no tags is named for its file, which is what the
    page calls it too - except that "Artist - Title", the shape a download is
    named in, is taken apart, because a notification has a line for each. A
    stream has no file to read, so it is named whatever the player says it is
    called."""
    info, cover = {}, None
    if "://" not in path and server is not None:
        try:
            info = server.tags(path) or {}
            cover = server.cover_bytes(path)
        except Exception:
            pass
    title, artist = info.get("title"), info.get("artist")
    if not title:
        name = None
        if "://" in path:
            try:
                name = (sm.playing(1.0) or {}).get("song")
            except Exception:
                pass
        else:
            name = os.path.basename(path)
        name = AUDIO_EXT.sub("", name or "") or None
        if name and not artist and " - " in name:
            artist, name = (p.strip() for p in name.split(" - ", 1))
        title = name
    try:
        playback.describe(path, title, artist or None, info.get("album") or None,
                          bytes(cover) if cover else None)
    except Exception:
        pass


def _control(sm, op, value):
    """A button outside the window: the notification, the lock screen, a
    headset. Put to the player loop exactly as the window would put it, so
    the window and the notification cannot disagree about what happened."""
    if op in ("play", "pause"):
        sm.ask({"op": "pause", "want": op == "pause"})
    elif op in ("skip", "back"):
        sm.send(op)
    elif op == "seek":
        sm.send("seek", pos=max(0.0, float(value)))


def _patch_props(sm, playback):
    """Where we are in the song, asked of the player instead of a socket.

    `mpv_props` opens mpv's IPC socket, which does not exist here. It is asked
    for `time-pos` and `duration` and nothing else - by `status`, so the page
    can draw the progress bar, and by the play log, so a skip is recorded at
    the point it happened. Both want the same two numbers from the thing that
    is playing, which is what this answers with.
    """
    def mpv_props(*names, **kw):
        have = {"time-pos": playback.position, "duration": playback.duration}
        out = {}
        for name in names:
            get = have.get(name)
            if get is None:
                continue
            try:
                v = float(get())
            except Exception:
                continue
            if v > 0 or name == "time-pos":
                out[name] = v
        return out

    sm.mpv_props = mpv_props


# ------------------------------------------------------------------ starting

def start(app_dir, home_dir, music_dir):
    """Bring the app up, and answer the port the page is served on.

    Called from `Boot.java` once. A second call is answered with the port the
    first one settled on rather than starting anything twice.
    """
    from com.chaquo.python import Python
    from java import jclass

    playback = jclass("org.simplmusik.player.PlayerService").playback(
        Python.getPlatform().getApplication())
    return bring_up(app_dir, home_dir, music_dir, playback)


def bring_up(app_dir, home_dir, music_dir, playback):
    """Everything about starting up that is not about Android.

    Split from `start` so that it can be run somewhere with no Java at all,
    handed something that stands in for the player. The port it answers with
    is real either way; so is every failure it can hit, which is the point.
    """
    if "port" in _state:
        return _state["port"]

    # Before anything reads a setting, decides where a playlist lives, or
    # walks a library. Every path in the CLI is `~`-relative, and this is the
    # line that gives `~` a meaning on a phone.
    os.makedirs(home_dir, exist_ok=True)
    os.environ["HOME"] = home_dir
    os.environ["XDG_CACHE_HOME"] = os.path.join(home_dir, ".cache")
    os.environ["SIMPLMUSIK_EMBEDDED"] = "1"
    os.environ["SIMPLMUSIK_FOLDER"] = music_dir

    # Loaded by path, out of where the assets were laid down - which is what
    # `server.py` does on a desktop too, and for the same reason: the CLI is
    # called `simplmusik`, with no `.py` for an import to find it by.
    sys.path.insert(0, app_dir)
    loader = importlib.machinery.SourceFileLoader(
        "simplmusik_server", os.path.join(app_dir, "server.py"))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    server = importlib.util.module_from_spec(spec)
    sys.modules[loader.name] = server
    loader.exec_module(server)              # this imports the CLI as server.sm

    sm = server.sm
    sm.BACKEND = _make_backend(sm, playback, server)
    _patch_props(sm, playback)
    playback.controls(lambda op, value: _control(sm, op, value))

    # Port 0 is "whichever one is free": the page is only ever reached from
    # inside this app, so the number matters to nobody and picking one that
    # something else already has would be a way to fail for no reason.
    httpd = server.serve(0, lan=False)
    _state["port"] = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True,
                     name="simplmusik-http").start()
    _state["server"] = server
    return _state["port"]
