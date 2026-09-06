# simplmusik

A local music player. Written in Python, native to Linux.

- plays the music on your own machine
- clean modern minimalist GUI
- a CLI aimed at agent and assistant use
- download any music for FREE, into your library or straight into a playlist
- audio levelling, so songs sit at the same volume

![The library](screenshots/library.png)

Search for something you haven't got and it offers to pull it down into the
playlist you're looking at.

![Downloading](screenshots/download.png)

## Install

Needs mpv for playback and ffmpeg for the levelling:

```sh
sudo apt install mpv ffmpeg
```

Then put it in the applications menu:

```sh
./install
```

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
