# simplmusik

A local music player for Linux and Android.

[![Watch the intro](screenshots/intro.jpg)](https://github.com/JJM8/simplmusik/releases/download/v0.2.5/intro.mp4)

![simplmusik](screenshots/playlist.png)

## Download

| | |
|---|---|
| **Any Linux** | [simplmusik.flatpak](https://github.com/JJM8/simplmusik/releases/latest/download/simplmusik.flatpak) |
| **Debian / Ubuntu / Mint** | [simplmusik_all.deb](https://github.com/JJM8/simplmusik/releases/latest/download/simplmusik_all.deb) |
| **Android** | [simplmusik.apk](https://github.com/JJM8/simplmusik/releases/latest/download/simplmusik.apk) |

These links always give you the newest release. Older versions are on the
[releases page](https://github.com/JJM8/simplmusik/releases).

## Install

**Flatpak**

```sh
flatpak install --user ./simplmusik.flatpak
```

**.deb**

```sh
sudo apt install ./simplmusik_all.deb
```

**APK:** open the file on your phone. You may need to allow installs from
your browser or file manager.

## Build it yourself

```sh
./build-all
```

This builds all three packages into `build/`.

## CLI

```sh
simplmusik --help
```

## Credits

Music in the intro video:

```
Rock Ain't Dead by ONLAP
Source: https://www.youtube.com/@ONLAP
Copyright Free Rock Song
```

```
Music track: Thats Right by Moavii
Source: https://freetouse.com/music
Royalty Free Background Music
```

## License

GPL-3.0. See [LICENSE](LICENSE).
