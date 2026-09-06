# simplmusik

A CLI music player and a desktop UI for it, on Linux Mint.

## Install

Playback is **mpv**, and the loudness measuring is **ffmpeg**:

```sh
sudo apt install mpv ffmpeg
```

```sh
./install                     # adds it to the applications menu
./install --accent '#0c75de'  # ...with the icon in a different colour
./install --uninstall
```

Then press **Super**, type `music`, and it's there. Nothing goes anywhere
system-wide - just a `.desktop` entry and icons under `~/.local/share`, both
pointing back at this folder, so keep the checkout where it is (or re-run
`./install` after moving it).

Launching it a second time raises the window that's already open rather than
starting another copy.

## Run

```sh
./simplmusik-ui              # app window (WebKit)
./simplmusik-ui --browser    # serve and open your browser instead
./server.py 8777              # backend only, if you want to point a browser at it
```

The CLI works on its own: `./simplmusik status`, `play`, `shuffle`, `add`,
and so on. `./simplmusik help` lists everything.

## Your library

Your library is **one** folder, the one you pick, walked **all the way
down**. A subfolder isn't a level you browse - it's just where a file happens
to sit - so however your music is arranged on disk, what you get is one flat
list of songs. There is only ever one music folder, which is what makes "where
is my music" a question with a single answer: everywhere a song can be is
inside it.

Playlists live **with the music**, in a hidden folder inside your music folder
- so that folder copied to another drive, or synced to another machine, brings
its playlists with it. The folder is hidden precisely because subfolders are
walked: a dot-directory is stepped over, so your playlists are never mistaken
for something to play.

    ~/Music/.simplmusik/playlists/main.json  a playlist
    ~/Music/.simplmusik/playlists/main.jpg   its cover art, if you gave it one
    ~/.config/simplmusik/config.json         which folder is yours

Only `config.json` stays behind, and it should: it holds this machine's
folder path, which is the one thing that shouldn't travel with your music.

Choose a different music folder and the playlists move with it. Put your music on a drive that isn't plugged in and
the playlists are on it too, so they're missing until it's back; nothing is
lost and nothing is rewritten in the meantime.

A playlist file is small and hand-editable, and names a song by its filename
plus the folder it was last seen in:

```json
{
  "name": "Road trip",
  "cover": "Road trip.jpg",
  "songs": [
    {"file": "Killer Queen - Queen.mp3", "dir": "/home/me/Music"},
    {"file": "Don't Stop Me Now - Queen.mp3", "dir": "/home/me/Music/rock"}
  ]
}
```

`name` is what you see and is yours to change; `cover` is a picture beside the
list, named on its own so it can only ever be one in that same folder. The
**filename is the identity**; `dir` is only a shortcut, so the usual case
is one `stat` rather than a search. Move a song - to another subfolder, or in
from somewhere else - and the next time anything reads the list, your music
folder is searched once and the entry is rewritten with where it turned up. So
a reorganised library fixes itself, and does it once rather than once per play.
A shortcut pointing *outside* your music folder is no shortcut at all and is
never followed, so changing folders can't leave a playlist quietly playing out
of the old one.

A song **not in** your music folder keeps its place in the list. It shows up
with a question mark where its cover would be and *Not found* under its name,
and playback simply passes over it. A drive you haven't plugged in yet is no
reason to quietly edit your playlist.

### Your music folder

```sh
simplmusik folder                   # where it is
simplmusik folder set /mnt/music    # ...point it somewhere else
simplmusik folder set               # ...or pick from your desktop
```

`folder set` with nothing after it opens your desktop's own folder dialog -
zenity on Mint, kdialog on KDE - and uses whatever you pick. That is what the
**Change...** button on the settings page does, so picking a folder and typing
one are the same single command, and closing the dialog without picking
changes nothing and says so. On a machine with no dialog to open - over SSH,
say - the button is a text field instead.

There is one folder and no way to have none: never having chosen means
`~/Music`. Choosing a different one never touches a file - your music stays
where it is, and only your playlists follow, since they live inside the folder.
It is also where new songs land: what `add` imports, and what `download`
fetches. The same filename in two subfolders is one song, so a filename means
exactly one thing everywhere.

In the window, the same command is the Settings page.

### Songs and playlists

```sh
simplmusik create 'Road trip'
simplmusik add 'Road trip' ~/Downloads/*.mp3            # imports, then lists them
simplmusik add 'Road trip' 'Killer Queen - Queen.mp3'   # already in the library
```

`remove PLAYLIST SONG` only edits that list and `delete PLAYLIST` only deletes
the list, so neither touches your music and neither stops to ask. `remove SONG`
- a song with no playlist beside it - is the one that does touch it: the file
goes, and every list naming it drops it. That one asks first in the UI, being
the only thing in the window that can't be undone. A song that's already
missing has no file to delete, so that same command just clears it out of the
lists still naming it. Deleting the song that is playing stops playback: mpv
holds the file open and would otherwise sound a song that is no longer in your
library right to the end.

A song that isn't in any playlist is still in your library, and `play` with
nothing to go on plays the whole thing. There is no "all songs" playlist to
name, either: a song on its own **means** the library, starting there - even
while a playlist is playing, so it never quietly scopes itself to whatever was
already on. That is the one command the All songs view uses.

In the window, a playlist carries an **Add songs** box under its own tracks.
Empty, it lists every song in your library that isn't in the playlist already;
type and it filters exactly as the top bar does, and the plus on a row adds it
there and then - no menu to pick a list from, because the playlist you're
looking at is the one it means. Each press is an ordinary `add`, so a terminal
sees precisely what the window did.

```sh
simplmusik play 'Killer Queen - Queen.mp3'          # the library, from there
simplmusik play main 'Killer Queen - Queen.mp3'     # that playlist, from there
simplmusik remove main 'Killer Queen - Queen.mp3'   # out of the list, file stays
simplmusik remove 'Killer Queen - Queen.mp3'        # gone, everywhere
```

### Naming a playlist, and giving it a picture

```sh
simplmusik rename 'Road trip' 'Long drive'    # the name you see
simplmusik cover 'Long drive' ~/Pictures/road.jpg
simplmusik cover 'Long drive'                 # where its picture is
simplmusik cover 'Long drive' --clear         # take it off again
simplmusik create 'Chill' --cover ~/Pictures/dusk.png
```

**Renaming changes the name and nothing else.** The file keeps the stem it was
made with, because that stem is what the player, the state file and the window
all call a playlist by - so a playlist renamed while it is playing carries on
playing, and the row lighting up in it stays the right row. Names have to be
distinct: a playlist can be found by its name, and two of them answering to
one name is a question with no answer. `rename` says so instead of guessing.

The picture is **copied in** beside the list, as
`.simplmusik/playlists/<name>.jpg`. So it travels with the folder you sync,
tidying up your Downloads folder can't take a cover art with it, and deleting a
playlist deletes the picture it was wearing rather than leaving it behind. What
counts as a picture is decided by reading the first bytes of the file, not the
name on it: JPEG, PNG, GIF or WebP, up to 8 MB.

In the window, both live on the playlist's own header. **The name is its own
button**: one click and the title becomes the box you type in, so the thing you
press is the thing you are editing. `Enter` or clicking away keeps it, `Esc`
puts it back. It lights up under the pointer to say so, and a name too long for
the room it has is cut off there rather than allowed to push the buttons beside
it out of reach - hovering shows it whole, and renaming it starts from the whole
thing. Over the artwork there is nowhere to put a pen that isn't on top of the
picture, so that one waits for the pointer, in the corner, with the picture
dimming to say the whole square is the button: clicking it opens a file picker,
and dropping an image on it skips even that.
A playlist wearing a cover gets a second button to take it off. A playlist with
no cover of its own borrows the artwork of the first song in it that has any,
exactly as it did before there was anything to give it.

The same picture is what the sidebar lists it by, shrunk to the size of the
icon it replaces - a shelf of covers rather than a column of identical marks, so
you find a playlist by the thing you gave it. Those thumbnails are kept between
redraws rather than rebuilt: the sidebar redraws on a timer and on every click,
and an image reloaded each time would blink its placeholder on every one.

### Coming from the old layout

Older versions kept a folder per playlist, each with its own copies of the
songs; playlists then moved to `~/Music/playlists`, and then to
`~/.config/simplmusik/playlists`. Every one of those is handled: the later
layouts move themselves into your music folder the first time you run
anything, and `./migrate` converts the oldest.

`./migrate` doesn't move a single song - a folder per playlist is just a
folder now, and your music folder is walked all the way down - it only reads each
`playlist.json` and writes the list out to its new home. `./migrate --dry-run`
shows what it would do first. Once it says *nothing in the old layout*, you can
delete the script.

## Getting songs from YouTube

Type in the search box and the library filters as you type, as it always has.
Underneath what it matched, a **Download** section shows what the same words
found on YouTube; the button on a row fetches it. The row says *Downloading...*
from the moment you press it, and that state lives on the result rather than on
the button, so the library reloading underneath can't redraw a download in
progress as though it had never been started.

The button becomes a turning ring, and the ring is also the progress bar: the
arc drawn on it is how much of the file has arrived, with the percentage spelt
out beside the title. Only the fetch has a percentage. The re-encode that
follows it is ffmpeg working through a file with no total to measure against,
so the row says *Converting...* and the arc goes back to a sliver rather than
showing a number that was invented to fill the gap.

The percentage comes from yt-dlp itself. Each download process writes its own
small file under `~/.local/state/simplmusik-downloads` and deletes it when it
finishes, so two downloads never share a file to race over, and one that is
killed halfway leaves an entry the UI ignores the moment it checks the pid -
the same trick the player's state file uses. The UI reads them on the poll it
was already making for the progress bar, so nothing new is asked of the network.

```sh
simplmusik search daft punk one more time    # id, title and length per result
simplmusik search daft punk --count 24       # a longer list, up to 40
simplmusik download FGBhQbmPwH8              # or a full youtube.com/youtu.be link
```

A download lands in your music folder and **joins no playlist** - it
becomes an ordinary library song like any file you copied in yourself, and
`add` is still the only thing that puts a song in a playlist. Which is what the
window does next when you download from inside one: the same **Download**
section sits under a playlist's Add songs box, and a row pressed there is a
`download` and then an `add`, so the song arrives in your library and in that
playlist. Pressed from the top bar, with no playlist on screen, it's the
download by itself. It arrives as an mp3 with its
title, artist and cover art written into the tags, which is exactly where the
UI reads all three from, so it looks like the rest of your library at once.

Downloading something you already have costs a couple of seconds and no
bandwidth: the filename is worked out before anything is fetched, and a name
already in the library stops there and says so. Search results don't know
what's in your library though, so a song you own can still appear under
Download - pressing it is harmless.

Both commands need **yt-dlp**, and a recent one: YouTube breaks older
extractors every few months, and a stale yt-dlp can still search while being
unable to download a thing. It's often installed twice on one machine - a
current zipapp in `~/.local/bin` next to an old copy from the distro - so
simplmusik looks at both and imports whichever is newer, and `download` says
so plainly if even that one is too old to work:

```sh
pip install --user -U yt-dlp     # what to run when it says that
```

It imports yt-dlp rather than running it as a program, which is the difference
between a search taking about two seconds and about ten. `ffmpeg` does the
conversion to mp3 and is already needed for playback.

Searching is a network round trip, so it waits for a pause in your typing -
the library filter above it stays instant regardless - and only the newest
search is allowed to land, since answers can come back out of order.

A search brings back eight. **See more** under the last row asks for eight
more, and is the same search run again for a longer list - all YouTube offers -
up to forty, past which the button stops appearing. The rows you already have
stay where they are while it goes; only the button says anything is happening.
Both search boxes work this way, the top bar's and a playlist's.

## How it fits together

    web/            the interface: playlists left, library and search right
    server.py       the backend
    simplmusik-ui  the desktop window
    install         menu entry and icons
    migrate         one-shot upgrade from the old folder-per-playlist layout
    simplmusik     the CLI - the only thing that touches playback, your
                    library or your settings

Every action the UI takes is a `simplmusik --json` call through `/api/cmd`,
which accepts a fixed list of commands and nothing else. The UI never assumes a
command worked: it re-reads `/api/state` twice a second, so the window and a
terminal running `simplmusik status` always agree.

A song's filename is its identity everywhere, whichever folder it turned out
to be in. The backend sends each song once and a playlist is a list of
filenames pointing into that, which is how the playing row is found from a
single comparison. It lights up in the list it is playing from and nowhere
else: the same song sitting in another playlist isn't the one being played, so
the list the player was started on - nothing at all, for the library - has to
match the list you're looking at. A playlist song that isn't in your music
folder is sent too, marked missing, so the row can say so instead of
vanishing.

The backend doesn't reimplement any of that: it **imports** the CLI. Where your
music folder is, what a playlist holds and where each song went are questions
with one right answer, and importing is what guarantees the window and a
terminal get the same one. Walking that folder is the only thing here that
touches the whole disk, so one walk is held for a few seconds and shared by the
covers on screen.

Playlists come back most recently changed first, which is the order both the
sidebar and the add-to-playlist menu show them in - the one you're working on
stays at the top. Recency is the playlist file's own timestamp, so adding a
song is what makes it recent and editing a file by hand counts too. Nothing is
stored anywhere to keep track of it.

The backend exists only for what a CLI can't hand over:

- **cover art** - artwork pulled from each song's tags, falling back to a
  coloured placeholder in the UI when a file hasn't any; and a playlist's own
  picture, when it has been given one.
- **tags** - title, artist, album and duration, cached per file until it changes.
- **the bytes of a picture**, the one thing that travels the other way. They
  have nowhere to sit on a JSON command line, so they go to a file and then
  straight back out through `cover` - which keeps the CLI the only thing that
  edits a playlist, and leaves it the CLI that decides whether those bytes are
  an image at all. A cover's address carries the picture's own timestamp, so a
  cover you just changed is a new address and no browser hands you back the one
  it was showing a second ago.
Where we are in the song isn't one of them: the player records that itself,
so the backend just adds two numbers out of the state file.

It listens on 127.0.0.1 only, and a name from the page is only ever looked up
among the songs the backend found itself - so it can't point anywhere else on
the disk.

## Settings

One page, reached from the bottom of the sidebar: your music folder (where it
is, how many songs are under it, and a button to choose another), whether songs
are levelled to an even loudness and where that loudness sits, whether the
window is light or dark, and a count of what's in your library. Every line on it
that changes your library is a CLI call - the folder row *is* `folder set`, the
switch *is* `levelling on` and `levelling off`, and the slider under it *is*
`target` - so the window and a terminal can't drift apart about any of it.

Theme is the one row that isn't, because it isn't about your library: see
[Light and dark](#light-and-dark).

The slider is only there while the switch is on: with levelling off there is no
gain for a target to be the target of, so a slider that changed nothing you
could hear would be a lie about what it does. Its two ends come from the
backend rather than the page, so it can't offer a setting the CLI would refuse.

## Playback

`play` starts one detached player process that owns the queue and drives one
long-lived **mpv**, handing it a song at a time over mpv's JSON IPC socket and
rewriting the state file at every song change - so the state file always names
the song actually sounding.

mpv is started with `--no-config`, so an `mpv.conf` of your own never quietly
becomes part of how this sounds. The levelling below is the only thing that
touches the volume.

It keeps two lists. **`songs`** is the pool it draws from, and **`order`** is
what it has actually played, grown one song at a time. So `order` is the
history, which is what `back` walks and what shuffle checks to avoid replaying
something you just heard - one list doing the work of three.

**Shuffle is a switch, not a jump.** `simplmusik shuffle` toggles it,
`shuffle on` / `shuffle off` set it outright, and the button in the window is
the same switch - it never starts anything playing. It lives in the config file
beside levelling, so it stays on until you turn it off: everything played from
then on, from either place, is shuffled. Throwing it does *not* interrupt the
song you're on - only what comes after it changes.

`simplmusik play --shuffle` turns it on and starts something in the one
breath: `play --shuffle "Road trip"` for a playlist, `play --shuffle` on its
own for your library, and naming a song still starts on that song and draws
from there on. With no song named, the opening song is a draw too, so a
shuffled playlist doesn't always open on the same track.

Each next song is picked at random from what you haven't heard lately: never
the current song, and never the last half a playlist-length of them. So a
10-song playlist won't repeat within 5, and a 100-song one won't within 50. It
runs on indefinitely rather than ending.

```sh
simplmusik shuffle                  # flip the switch
simplmusik shuffle on               # ...or set it outright
simplmusik play --shuffle           # on, and play your library from a draw
simplmusik play --shuffle 'Road trip'                            # a playlist
simplmusik play --shuffle 'Road trip' 'Killer Queen - Queen.mp3' # from there
```

**`back`** steps back through `order`, so under shuffle it retraces exactly
what you heard rather than picking something new. At the first track it
restarts that track instead of stopping.

**Seeking** moves the mpv that is already playing, so the song carries on from
the new point rather than starting again. `simplmusik seek 1:23` jumps to a
point, and `seek +30` / `seek -10` jump relative to where you are; in the UI,
clicking or dragging the progress bar is the same command. Nothing else shifts
- same player process, same mpv, same queue, same history.

How far into a song we are is mpv's own `time-pos`, asked for over the socket.
The socket is a file like any other, so anything can ask - `seek -10` here, the
UI's progress bar, `status` in another terminal - and there is no clock kept
anywhere to drift out of step. It stands still while paused without being told
to, so the position survives a pause exactly.

Stop and pause are signals, because they act on the process. Anything that
moves the queue - skip, back, shuffle, seek - is written to a control file the
player is nudged to read, since those carry a value and signals can't. A signal
handler never touches the socket itself: it leaves a note, and the player's own
loop carries it out, so nothing can cut in halfway through a command being
written.

**Every song plays at the same loudness**, unless you turn *Even loudness* off
under Playback in the settings - it starts on. Masterings differ wildly - about a
16 dB spread across an ordinary library, which is a volume knob you keep having
to touch - so each song is measured once and played through mpv's volume
filter. The measure is the mean of its squared samples, and the gain is
whatever brings that to the same target for every song.

Nothing is written to your music. The file is measured, not modified, and the
gain is worked out fresh from that measurement at every play.

Boosting a quiet song could clip it, though - quiet on average doesn't mean
quiet everywhere, and some songs already touch full scale on a peak. So the
same pass records the loudest single sample, and the gain is capped at whatever
leaves that sample just under full scale. Clipping isn't unlikely here, it's
impossible: a song that can't reach the target without clipping stays a shade
short of it instead, which at the default target is rare and inaudible when it
happens.

**The target is where all of them are aimed**, and `simplmusik target` moves
it: a number from -30 to -12, counted down in dB from the loudest a sample can
be, and -20 unless you say otherwise. That range is the whole of the trade-off.
Aim quieter and every song reaches it exactly; aim louder and the songs with
the least room left above their peak start falling short of the rest, which is
the one thing that puts them back out of step - so -20 is where nearly
everything can still land on the number.

Moving it swaps the filter under the song that is playing, the same way the
switch does, so the whole library shifts under you as you drag the slider.

Measuring costs about two seconds per song and happens the first time you play
it, so the results are cached in `~/.cache/simplmusik.json` - keyed by
filename, stamped with the file's size and mtime, and thrown away by simply
deleting the file. What is cached is the measurement, not the gain: the mean
and the peak are the same two numbers whatever you aim at, so moving the target
is arithmetic on numbers already in hand and re-measures nothing.

Turning it on or off mid-song restarts the song where it is - the same move a
seek makes - so you hear the difference straight away rather than at the next
track.

```sh
simplmusik levelling          # on or off?
simplmusik levelling off      # play songs exactly as they were mastered
simplmusik target             # where is it aiming?
simplmusik target -17         # louder, and a few songs now fall short of it
simplmusik target -24         # quieter, and every one of them lands on it
```

## Theming

The accent is one CSS variable, `--accent` in `web/style.css`, set to the
Mint-Y-Dark-Orange `#ff7139`. Everything tinted - the logo, buttons, the playing
row, the progress bar - reads from that one variable, so editing it there is the
whole job.

The logo (`web/logo.png`) is the note art as an alpha mask, so it's painted with
`--accent` rather than being a fixed-colour image. The menu icon is drawn from
the same mask, but a PNG on disk can't follow a CSS variable, so its colour is
baked in at install time - `./install --accent '#0c75de'` redraws it.

### Light and dark

There are two palettes and one set of names. Every rule below the top of
`web/style.css` paints with a name - `--bg`, `--surface`, `--text` - and never
with a colour, so light and dark are the same app with a different sheet of
paint: the dark one on `:root`, the light one on `:root[data-theme="light"]`.
The accent is not in either. It is the same orange both ways, which is what
Mint-Y does too.

Which one is on is up to **Settings → Appearance**, where the choice is
*System*, *Light* or *Dark*. System is the default and needs no maintenance: the
window wears whatever your desktop has been told to wear, and follows it while
it is open, so a desktop that goes dark in the evening takes the window along.
Light and dark pin it whatever the desktop says.

That choice is the one setting that isn't a CLI call. It belongs to this window
on this machine rather than to your library - `simplmusik` in a terminal has no
palette to set, and a music folder synced to another machine shouldn't drag this
machine's screen along with it - so it's kept in the browser, under
`simplmusik.theme`, and read by a few lines in `index.html` before the first
paint so a reopened window never starts in the wrong palette and corrects itself
in front of you.

The desktop window has to agree with the page it frames, or the titlebar ends up
the odd one out. `simplmusik-ui` reads the desktop's preference - through the
`org.freedesktop.appearance` portal, or from the name of the GTK theme where no
portal is running - and hands it to GTK, which is also how WebKit comes to
answer `prefers-color-scheme`. The page then posts back the palette it settled
on, your pinned choice included, and the window follows that.

## Keys

`Space` play/pause · `n` next · `p` previous · `s` shuffle on/off ·
`←` / `→` back / forward 5s · `/` search · `Esc` leave search

## Worth knowing

Clicking a track plays from there and **carries on** - through the playlist
you're in, or through the whole library if you clicked from All songs or from a
search result.

Seeking past the end of a song moves to the next one. The player has no idea
how long a song is, and mpv run off the end of a song simply ends it - which is
a fair reading of "seek to the end". The UI knows the length and clamps first,
so only a typed `simplmusik seek 99:00` can do it.
