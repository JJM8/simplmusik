# simplmusik

A local music player. Written in Python, native to Linux.

**Any distribution - Fedora, Arch, openSUSE, Mint, Ubuntu, a Steam Deck. Carries its own mpv, WebKit and ffmpeg, so there is nothing to install first.**

[![Download the flatpak](https://img.shields.io/badge/Download-.flatpak%20for%20any%20distro-4a90d9?style=for-the-badge&logo=flatpak&logoColor=white)](https://github.com/JJM8/simplmusik/releases/latest/download/simplmusik.flatpak)

**Debian and Ubuntu, and the distributions built on them - Mint, Pop!\_OS, Zorin. The lighter install, because apt already has the mpv and ffmpeg it needs.**

[![Download the .deb](https://img.shields.io/badge/Download-.deb%20for%20Debian%20%2F%20Ubuntu-2ea44f?style=for-the-badge&logo=debian&logoColor=white)](https://github.com/JJM8/simplmusik/releases/latest/download/simplmusik_all.deb)

**Anywhere else, run it straight from a checkout - `./install` puts it in your menu.**

- plays the music on your own machine
- points itself at the music folder your desktop already has, and asks
  for a different one only if that comes up empty
- clean modern minimalist GUI
- a CLI aimed at agent and assistant use
- download any music for FREE, into your library or straight into a playlist
- audio levelling, so songs sit at the same volume

Playlists sit beside it, with whatever's playing along the bottom.

![A playlist](screenshots/playlist.png)

Search for something you haven't got and it offers to pull it down into the
playlist you're looking at.

![Downloading](screenshots/download.png)

## Install

### Flatpak

**For any distribution that has flatpak, which is all of them. Nothing to
install first - mpv, WebKit, ffmpeg and Python are all inside it, so it doesn't
care what your package manager has.**

[Download the flatpak](https://github.com/JJM8/simplmusik/releases/latest/download/simplmusik.flatpak), then:

```sh
flatpak install --user ./simplmusik.flatpak
```

The download itself is 4.5 MB, but if this is your first flatpak app it pulls
down the GNOME runtime underneath it too - about a gigabyte, once, and shared
with every flatpak you install afterwards. Press **Super**, type `music`, and
it's there.

### Debian package

**For Debian, Ubuntu, Mint, Pop!\_OS, Zorin and anything else apt-based. A 3 MB
package with nothing underneath it, because it uses the mpv and ffmpeg your
system already has.**

[Download the .deb](https://github.com/JJM8/simplmusik/releases/latest/download/simplmusik_all.deb), then:

```sh
sudo apt install ./simplmusik_all.deb
```

That's everything - apt pulls in mpv, ffmpeg and the rest, and the package
carries its own yt-dlp, because the one in the archive is too old to reach
YouTube's audio any more. Press **Super**, type `music`, and it's there.

### Keeping downloads working

YouTube changes how it hands out audio every few weeks. When downloads start
failing, that's what it is:

```sh
simplmusik update
```

### ...or build it yourself

```sh
./build-flatpak
flatpak install --user ./build/simplmusik_0.1.3.flatpak
```

```sh
./build-deb
sudo apt install ./build/simplmusik_0.1.3_all.deb
```

Or both at once, which is what a release is - `--fresh` fetches the newest
yt-dlp rather than reusing the cached one:

```sh
./build-all --fresh
```

### ...or run it from this folder

```sh
./install
```

Adds it to the applications menu without installing anything system-wide, and
tells you what's missing. Everything stays in this folder, so keep the checkout
where it is (or re-run `./install` after moving it). The menu entry and the
window run these files as they sit, so an edit here is in the app the next time
you open it - which is what you want while working on it.

For the `simplmusik` command as well, point a name on your PATH at the CLI in
this folder:

```sh
ln -s "$PWD/simplmusik" ~/.local/bin/simplmusik
```

## Run

```sh
./simplmusik-ui              # the app window
./simplmusik-ui --browser    # or serve it and open your browser
```

## CLI

Meant for agents as much as for people.

```sh
simplmusik status
simplmusik list                          # All songs, then your playlists
simplmusik play --shuffle
simplmusik search wonderwall             # your library, numbered
simplmusik search --yt wonderwall        # ...or YouTube
simplmusik create "Road trip"
simplmusik add "Road trip" 2             # the second row it just showed you
```

Every command that takes a song takes it three ways: the number beside it in
the last list you were shown, its whole filename, or enough of the filename to
tell it from the rest. So searching and then adding is two steps rather than
two steps and a filename to copy - and `add PLAYLIST N` on a YouTube result
downloads it and adds it in one.

Put `--json` before the command and you get JSON back, so an agent can read
the result without parsing text meant for a person.

```sh
simplmusik --json status
```

## More

DESIGNNOTES.md has the longer version.
