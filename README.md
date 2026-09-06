# simplmusik

A local music player. Written in Python, native to Linux.

[![Download the .deb](https://img.shields.io/badge/Download-.deb%20for%20Debian%20%2F%20Ubuntu-2ea44f?style=for-the-badge&logo=debian&logoColor=white)](https://github.com/JJM8/simplmusik/releases/latest/download/simplmusik_all.deb)

- plays the music on your own machine
- points itself at the music folder your desktop already has, and asks
  for a different one only if that comes up empty
- clean modern minimalist GUI
- a CLI aimed at agent and assistant use
- download any music for FREE, into your library or straight into a playlist
- audio levelling, so songs sit at the same volume

![The library](screenshots/library.png)

Search for something you haven't got and it offers to pull it down into the
playlist you're looking at.

![Downloading](screenshots/download.png)

## Install

[Download the .deb](https://github.com/JJM8/simplmusik/releases/latest/download/simplmusik_all.deb), then:

```sh
sudo apt install ./simplmusik_all.deb
```

That's everything - apt pulls in mpv, ffmpeg and the rest, and the package
carries its own yt-dlp, because the one in the archive is too old to reach
YouTube's audio any more. Press **Super**, type `music`, and it's there.

YouTube changes how it hands out audio every few weeks. When downloads start
failing, that's what it is:

```sh
simplmusik update
```

### ...or build it yourself

```sh
./build-deb
sudo apt install ./build/simplmusik_0.1.0_all.deb
```

### ...or run it from this folder

```sh
./install
```

Adds it to the applications menu without installing anything system-wide, and
tells you what's missing. Everything stays in this folder, so keep the checkout
where it is (or re-run `./install` after moving it).

## Run

```sh
./simplmusik-ui              # the app window
./simplmusik-ui --browser    # or serve it and open your browser
```

## CLI

```sh
simplmusik status
simplmusik list
simplmusik play --shuffle
simplmusik search wonderwall
simplmusik create "Road trip"
```

Put `--json` before the command and you get JSON back, which is the point of
it: an assistant can read what came back without parsing text meant for a
person.

```sh
simplmusik --json status
```

## More

DESIGNNOTES.md has the longer version.
