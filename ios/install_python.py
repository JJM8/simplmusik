#!/usr/bin/env python3
"""Put the standard library into the app, the way iOS insists on.

    ./install_python.py Python.xcframework path/to/Simplmusik.app

On a Mac this is a build step Xcode runs, out of a shell script that ships
beside the framework. There is no Xcode here, so this is that script, in
Python, minus the two things that only exist on a Mac: `plutil`, which is
`plistlib` below, and `codesign`, because xtool signs the whole bundle
afterwards.

It does two things.

**The standard library is copied in.** An xcframework may hold a binary and
its metadata and nothing else, so Python's own library cannot travel inside
it - it sits beside it in the archive and is laid into the bundle here, under
`python/lib`, which is what `PYTHONHOME` points at when the app starts.

**Every compiled module becomes a framework.** iOS will not load a `.so` out
of an app's resources; a dynamic library has to be a framework in the bundle's
`Frameworks` folder. So each of the sixty-odd compiled modules in the standard
library - `_ssl`, `_sqlite3`, `_socket` and the rest - is moved into a
framework of its own, and a small `.fwork` file is left where it used to be
saying where it went. CPython's own import machinery reads those files: it
installs a loader for them precisely so this rearrangement is possible.

Run it again on a bundle it has already processed and it finds nothing left to
move, which is what makes a rebuild safe.
"""

import os
import plistlib
import shutil
import sys

# What the standard library is called inside the bundle, and where the app's
# own Python code lives. Both are relative to the .app.
STDLIB = "python/lib"
FRAMEWORKS = "Frameworks"


def slice_for(xcframework, want="ios-arm64"):
    """The part of the xcframework meant for a phone.

    An xcframework holds one build per platform - a device build and a
    simulator build here - and only the device one can go in an app that will
    be installed on a phone. Named rather than guessed, because the simulator
    slice is also called ios-something and picking it would produce an app
    that installs and then refuses to start."""
    path = os.path.join(xcframework, want)
    if not os.path.isdir(path):
        sys.exit("no '%s' slice in %s" % (want, xcframework))
    return path


def copy_tree(src, dst, skip=()):
    """Copy a folder into another, leaving what is already there.

    `dirs_exist_ok` because the standard library arrives in two halves - the
    pure-Python part, which is shared by every architecture, and the compiled
    part, which is not - and they are meant to end up as one folder."""
    if not os.path.isdir(src):
        return
    shutil.copytree(src, dst, dirs_exist_ok=True, symlinks=True,
                    ignore=shutil.ignore_patterns(*skip) if skip else None)


def install_stdlib(xcframework, app, arch="arm64"):
    """Both halves of the standard library, into `python/lib`.

    The `libpython*.dylib` symlink is left behind deliberately: the real
    library is the framework binary, and a dangling symlink in a bundle is
    something for the signature to trip over."""
    dest = os.path.join(app, STDLIB)
    os.makedirs(dest, exist_ok=True)

    shared = os.path.join(xcframework, "lib")
    device = slice_for(xcframework)
    if os.path.isdir(shared):
        copy_tree(shared, dest, skip=("libpython*.dylib",))
        copy_tree(os.path.join(device, "lib-" + arch), dest,
                  skip=("libpython*.dylib",))
    else:
        copy_tree(os.path.join(device, "lib"), dest,
                  skip=("libpython*.dylib",))

    for name in sorted(os.listdir(dest)):
        if name.startswith("python3."):
            return os.path.join(dest, name)
    sys.exit("no python3.x folder landed in %s" % dest)


def bundle_id(app):
    """The app's own identifier, which each framework's is built from."""
    with open(os.path.join(app, "Info.plist"), "rb") as f:
        return plistlib.load(f).get("CFBundleIdentifier", "org.simplmusik.player")


def install_dylib(template, app, base, so_path, app_id):
    """One compiled module, moved into a framework of its own.

    The name of the framework is the module's full dotted name - `_ssl`, or
    `yt_dlp.something._native` had we any - because a bundle has one flat
    `Frameworks` folder and two modules called `_parser` in different packages
    would otherwise be one file."""
    relative = os.path.relpath(so_path, os.path.join(app, base))
    dotted = relative.split(".")[0].replace(os.sep, ".")
    framework = os.path.join(FRAMEWORKS, dotted + ".framework")
    framework_dir = os.path.join(app, framework)

    os.makedirs(framework_dir, exist_ok=True)
    info = dict(template)
    info["CFBundleExecutable"] = dotted
    info["CFBundleIdentifier"] = ("%s.%s" % (app_id, dotted)).replace("_", "-")
    with open(os.path.join(framework_dir, "Info.plist"), "wb") as f:
        plistlib.dump(info, f)

    shutil.move(so_path, os.path.join(framework_dir, dotted))

    # The pointer CPython's importer follows, where the module used to be...
    with open(so_path[:-len(".so")] + ".fwork", "w") as f:
        f.write(os.path.join(framework, dotted))
    # ...and the way back, which the framework carries so that the two can
    # always be matched up again.
    with open(os.path.join(framework_dir, dotted + ".origin"), "w") as f:
        f.write(os.path.relpath(so_path, app)[:-len(".so")] + ".fwork")

    # A module with a privacy manifest keeps it: Apple wants that file inside
    # the framework rather than next to the code it describes.
    privacy = so_path.split(".")[0] + ".xcprivacy"
    if os.path.exists(privacy):
        shutil.move(privacy, os.path.join(framework_dir, "PrivacyInfo.xcprivacy"))

    return dotted


def process_dylibs(template, app, base, app_id):
    """Every `.so` under one folder of the bundle."""
    root_dir = os.path.join(app, base)
    done = []
    for root, _, files in os.walk(root_dir):
        for name in sorted(files):
            if name.endswith(".so"):
                done.append(install_dylib(template, app, base,
                                          os.path.join(root, name), app_id))
    return done


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    xcframework, app = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
    extra = sys.argv[3:] or ["app"]     # the app's own code, for any .so in it

    template_path = os.path.join(xcframework, "build",
                                 "iOS-dylib-Info-template.plist")
    with open(template_path, "rb") as f:
        template = plistlib.load(f)

    stdlib = install_stdlib(xcframework, app)
    version = os.path.basename(stdlib)
    app_id = bundle_id(app)

    moved = process_dylibs(template, app,
                           os.path.join(STDLIB, version, "lib-dynload"), app_id)
    print("installed %s and framed %d standard library modules"
          % (version, len(moved)))

    for folder in extra:
        if os.path.isdir(os.path.join(app, folder)):
            also = process_dylibs(template, app, folder, app_id)
            if also:
                print("framed %d modules in %s" % (len(also), folder))


if __name__ == "__main__":
    main()
