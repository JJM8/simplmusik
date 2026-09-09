/* simplmusik UI.

   Every action is a call to the CLI through /api/cmd; the UI never assumes it
   knows the result. Truth comes back from /api/state, polled twice a second,
   so the interface agrees with `simplmusik status` in a terminal at all times.

   The library is flat, so a song's filename is its identity everywhere. The
   backend sends every song once in `lib.songs`; a playlist is just a list of
   filenames pointing into it - so a row is the playing one when its file and
   the list it sits in are both what the player was started on.
*/

const $  = s => document.querySelector(s);
const el = (t, c, x) => { const n = document.createElement(t);
                          if (c) n.className = c;
                          if (x !== undefined) n.textContent = x;
                          return n; };

const svg = icon => { const n = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                      n.innerHTML = `<use href="#${icon}"/>`;
                      return n; };

const api  = p => fetch(p).then(r => r.json());
const call = (...args) => fetch('/api/cmd', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ args })
}).then(r => r.json());

/* Ask the server to look a song up before anyone plays it. Fire and forget:
   nothing here waits on the answer, and if it doesn't work the stream that
   follows looks the song up itself, exactly as it did before. */
const prefetch = id => fetch('/api/prefetch?id=' + encodeURIComponent(id))
                         .catch(() => {});

/* view: a playlist's file stem, null for the whole library, or SETTINGS.
   A symbol, so no playlist can ever be named the same thing by accident. */
const SETTINGS = Symbol('settings');
const STATS = Symbol('stats');

const state = { lib: { playlists: [], songs: [], root: '' }, byFile: {},
                view: null, query: '', addQuery: '', now: {},
                stats: null, statsWhy: null, statsStep: 'day' };

const MIN_FIND = 2;      // a query shorter than this isn't worth a search
const FIND_N = 8;        // what a search brings back - the CLI's own default
const FIND_MORE = 8;     // ...and how many more each 'See more' asks for

/* ------------------------------------------------------------ searching YouTube */
/* One engine, made twice: the top bar has one, and a playlist's add box has
   another. Each keeps its own results, so what one box finds can never turn up
   in the other. Filtering the library is instant and local; this is a network
   round trip, so it waits for a pause in the typing, only the newest answer is
   allowed to land - they can come back out of order - and 'See more' is the
   same search again for a longer list, which is all YouTube offers. */

function ytSearch(paint) {
  const s = { query: '', found: [], finding: false, error: null,
              n: FIND_N, more: false };
  let timer = null, seq = 0;

  async function ask(n) {
    const mine = ++seq;
    const r = await call('search', '--yt', ...s.query.split(/\s+/), '--count', String(n));
    if (mine !== seq) return;             // a later search has replaced this one
    s.n = n;
    s.finding = false;
    s.found = r.ok && Array.isArray(r.data) ? r.data : [];
    // Code 2 is 'nothing found', which the empty list already says by itself.
    s.error = r.ok || r.code === 2 ? null : (r.error || 'the search didn\'t work');
    paint();
    // The first result is looked up now, while you are still reading the list.
    // Looking a song up is the whole of what makes a stream slow to start, and
    // this is the second or two in which nothing else is happening - so by the
    // time you press play, there is nothing left to ask.
    //
    // Only the first. Eight at once contend with each other badly enough that
    // the one you actually wanted arrives later than if nothing had been
    // looked up at all.
    if (s.found.length) prefetch(s.found[0].id);
  }

  /* The query changed - including back to nothing, which is how a search in
     flight is called off. */
  s.typed = q => {
    s.query = q;
    clearTimeout(timer);
    seq++;                                // whatever is in flight is now stale
    s.found = []; s.error = null; s.n = FIND_N; s.more = false;
    s.finding = q.length >= MIN_FIND;
    if (s.finding) timer = setTimeout(() => ask(FIND_N), 350);
  };

  // Asking for more keeps the rows you have on screen while it goes: only the
  // button says anything is happening, so the list doesn't blink away.
  s.showMore = async () => {
    if (s.more) return;
    s.more = true;
    paint();
    await ask(s.n + FIND_MORE);
    s.more = false;
    paint();
  };
  return s;
}

/* Painting the top bar's results is a whole redraw; the add box repaints its
   own rows instead, so it never rebuilds the field you are typing into. */
const find      = ytSearch(() => render());
const adderFind = ytSearch(() => repaintAdder?.());

/* The row that asks for the next handful. Shown while YouTube filled the last
   request completely, which is the only sign there is more to come. */
function moreRow(s) {
  const box = el('div', 'more');
  const b = el('button', '', s.more ? 'Looking\u2026' : 'See more');
  b.disabled = s.more;
  b.onclick = () => s.showMore();
  box.append(b);
  return box;
}

function foundRows(box, s, pl) {
  const h = el('div', 'found-head');
  // One heading either way: what is happening, or what these rows are.
  h.append(el('strong', '', s.finding ? 'Searching YouTube\u2026'
                                      : 'Add from YouTube'));
  box.append(h);
  if (s.finding) return;
  // A search that failed says so. Reporting it as 'nothing found' would send
  // you off rewording a query when yt-dlp simply isn't installed.
  if (s.error)          return void box.append(el('div', 'none', s.error));
  if (!s.found.length)  return void box.append(el('div', 'none', 'Nothing on YouTube.'));
  s.found.forEach(r => box.append(foundRow(r, pl)));
  if (s.found.length >= s.n) box.append(moreRow(s));
}

/* ---------------------------------------------------------------- helpers */

const time = s => {
  if (s === null || s === undefined) return '--:--';
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const longTime = s => {
  if (!s) return '';
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} hr ${m % 60} min` : `${m} min`;
};

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/* A cover element: real artwork if the backend has some, otherwise a stable
   coloured placeholder derived from the name - never a broken image. */
function cover(song, letterSize) {
  const box = el('div');
  box.style.cssText = 'width:100%;height:100%';
  const seed = (song.artist || song.title || song.file || '?');
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) % 360;
  // A song we can't find gets a question mark instead of its initial: the row
  // is still there, it just can't tell you any more than the name it holds.
  const ph = el('div', 'ph' + (song.missing ? ' miss' : ''),
                song.missing ? '?' : (song.title || song.file || '?').trim()[0].toUpperCase());
  ph.style.setProperty('--h', h);
  ph.style.fontSize = (letterSize || 14) + 'px';
  box.append(ph);

  if (song.rel && !song.missing) {
    const img = new Image();
    img.className = 'cover';
    img.onload = () => box.replaceChildren(img);
    img.src = '/api/cover?rel=' + encodeURIComponent(song.rel);
  }
  return box;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* Run a CLI command, surface any complaint, then refresh at once. */
async function run(...args) {
  const r = await call(...args);
  if (!r.ok) toast(r.error || 'that didn\'t work');
  poll();
  return r;
}

/* ------------------------------------------------------------- sidebar */

/* `lead` is either the name of an icon or a ready-made element to put in the
   icon's place - which is how a playlist wears its cover here instead. */
function navButton(lead, name, count, active, onclick) {
  const b = el('button', 'pl');
  b.classList.toggle('active', active);
  if (typeof lead === 'string') {
    const ico = svg(lead);
    ico.setAttribute('class', 'ico');
    lead = ico;
  }
  b.append(lead, el('span', 'name', name), el('span', 'count', count));
  b.onclick = onclick;
  return b;
}

/* The sidebar shows the same picture the header does, shrunk. Rebuilding it on
   every render would re-decode the image and flash the placeholder underneath
   each time - the sidebar redraws on a 15s timer and on every click - so the
   built element is kept and handed back until the playlist's art changes. */
const thumbs = new Map();

function playlistThumb(pl) {
  const key = [pl.file, pl.cover || '', pl.songs?.[0] || ''].join('|');
  let t = thumbs.get(key);
  if (!t) {
    t = el('div', 'thumb');
    t.append(playlistArt(pl, playlistSongs(pl), pl.name, 10));
    thumbs.set(key, t);
  }
  return t;
}

function renderPlaylists() {
  const showing = f => state.view === f && !state.query;

  $('#settings-btn').classList.toggle('on', showing(SETTINGS));
  $('#stats-btn').classList.toggle('on', showing(STATS));
  $('#lib-nav').replaceChildren(
    navButton('i-note', 'All songs', state.lib.songs.length, showing(null),
              () => openPlaylist(null)));

  const box = $('#playlists');
  box.replaceChildren();
  if (!state.lib.playlists.length) {
    const e = el('div', 'empty');
    e.append(el('strong', '', 'No playlists yet'));
    e.style.padding = '22px 10px';
    box.append(e);
    return;
  }
  for (const p of state.lib.playlists)
    box.append(navButton(playlistThumb(p), p.name, p.count, showing(p.file),
                         () => openPlaylist(p.file)));

  // Covers for playlists that are gone, or have been re-covered, aren't coming
  // back - don't let the cache grow for the life of the window.
  const live = new Set(state.lib.playlists.map(
    p => [p.file, p.cover || '', p.songs?.[0] || ''].join('|')));
  for (const k of thumbs.keys()) if (!live.has(k)) thumbs.delete(k);
}

/* ---------------------------------------------------------------- views */

function openPlaylist(file) {
  $('#q').value = '';
  state.query = '';
  state.addQuery = '';
  adderFind.typed('');          // whatever it was looking for, it isn't now
  $('#clear-q').hidden = true;
  state.view = file;
  renderPlaylists();
  render();
  // A new view starts at its top. #list keeps its scroll offset across a
  // replaceChildren, so without this you arrive in a playlist already partway
  // down it - at a row you never chose, in a list you haven't seen the start
  // of. Done after the render, so the box is measured against what is now in
  // it rather than what was.
  $('#list').scrollTop = 0;
}

/* Up and down walk the sidebar, from anywhere in the window - the one bit of
   navigation you never have to click into first. The list they walk is the
   sidebar exactly as it reads: All songs, then the playlists in their order.

   Moving opens as it goes, rather than dragging a separate highlight around
   for Enter to confirm. That is affordable because opening a playlist is a
   local re-render and nothing more, and it means the orange chip is both
   'where you are' and 'where the keyboard is' - one thing to follow instead
   of two. It also means each step is one key rather than two.

   Settings is not on the walk. It isn't a view of songs, so stepping onto it
   would be stepping out of the library entirely; while it is open the arrows
   do nothing at all, and you leave it the way you came in. */

const sidebarViews = () => [null, ...state.lib.playlists.map(p => p.file)];

/* The scroll only ever needs doing inside #playlists - All songs sits above
   it in its own strip, and getting back to it means the list is at the top. */
function revealView(i) {
  const box = $('#playlists');
  if (i === 0) box.scrollTop = 0;
  else box.children[i - 1]?.scrollIntoView({ block: 'nearest' });
}

function stepSidebar(d) {
  if (state.view === SETTINGS || state.view === STATS) return;
  const views = sidebarViews();
  // A search spans the whole library, so it sits on no row and there is
  // nothing to step from: the first arrow enters the list from the end it is
  // travelling away from, the way a cursor lands when it arrives.
  const at = state.query ? -1 : views.indexOf(state.view);
  const to = at < 0 ? (d > 0 ? 0 : views.length - 1)
                    : Math.min(views.length - 1, Math.max(0, at + d));
  // Stopping at the ends rather than wrapping: a list you can fall off the
  // bottom of and reappear at the top of is a list you have to re-read.
  if (to === at) return;
  openPlaylist(views[to]);
  revealView(to);
}

/* What a search box looks at. Both of them use this one, so the results
   under a playlist match what the top bar would have found. */
const matches = (s, q) =>
  (s.title + ' ' + s.artist + ' ' + s.album + ' ' + s.file).toLowerCase().includes(q);

function currentSongs() {
  if (state.query) {
    const q = state.query.toLowerCase();
    return state.lib.songs.filter(s => matches(s, q));
  }
  if (!state.view || state.view === SETTINGS || state.view === STATS)
    return state.lib.songs;
  const pl = state.lib.playlists.find(p => p.file === state.view);
  return pl ? playlistSongs(pl) : [];
}

// A playlist stores filenames; the details live in the one songs list.
const playlistSongs = pl => (pl.songs || []).map(f => state.byFile[f]).filter(Boolean);

function button(label, cls, icon, onclick) {
  const b = el('button', 'btn ' + cls);
  b.append(svg(icon), el('span', '', label));
  b.onclick = onclick;
  return b;
}

/* --------------------------------------------------- a playlist's own art */
/* Given one, a playlist wears the picture you gave it; given none, it borrows
   the first of its songs that has any - which is what it did before there was
   anything to give. Either way the placeholder is built first and the picture
   swapped in when it loads, so nothing ever flashes as a broken image. */

function playlistArt(pl, songs, name, letterSize) {
  const fallback = () =>
    cover(songs.find(s => !s.missing) || songs[0] || { title: name, rel: '' },
          letterSize || 26);
  if (!pl?.cover) return fallback();
  const box = el('div');
  box.style.cssText = 'width:100%;height:100%';
  box.append(fallback());
  const img = new Image();
  img.className = 'cover';
  img.onload = () => box.replaceChildren(img);
  img.src = pl.cover;
  return box;
}

/* The art in the header, and - for a playlist - the way you change it. The pen
   sits in the corner on hover, the picture takes a drop, and a playlist that is
   already wearing one gets a second button to take it off again. */
function headArt(pl, songs, name) {
  const art = el('div', 'art');
  // The library is not a playlist and has no cover of its own to wear. Borrowing
  // the top song's art would make it look like one album out of all of them, so
  // it shows the same note the sidebar gives it.
  if (!pl) {
    art.classList.add('note');
    art.append(svg('i-note'));
    return art;
  }
  art.append(playlistArt(pl, songs, name));

  art.classList.add('editable');
  art.title = 'Change cover art';
  art.onclick = () => pickCover(pl);

  const pen = el('button', 'art-btn pen');
  pen.title = 'Change cover art';
  pen.append(svg('i-pen'));
  art.append(pen);                  // its click is the art's own

  if (pl.cover) {
    const off = el('button', 'art-btn off');
    off.title = 'Remove cover art';
    off.append(svg('i-trash'));
    off.onclick = e => { e.stopPropagation(); clearCover(pl); };
    art.append(off);
  }

  // Dropping a picture on it is the same thing as picking one, without the
  // detour through a file dialog.
  art.ondragover = e => { e.preventDefault(); art.classList.add('dropping'); };
  art.ondragleave = () => art.classList.remove('dropping');
  art.ondrop = e => {
    e.preventDefault();
    art.classList.remove('dropping');
    setCover(pl, e.dataTransfer?.files?.[0]);
  };
  return art;
}

/* ---------------------------------------------------- naming and covering */

const picker = $('#cover-file');

function pickCover(pl) {
  picker.value = '';                // the same file twice still counts as a change
  picker.onchange = () => setCover(pl, picker.files[0]);
  picker.click();
}

/* The picture goes to the backend as bytes and comes back through the CLI's
   own `cover` command, so what the window does here a terminal could do too. */
async function setCover(pl, file) {
  if (!file) return;
  if (!/^image\//.test(file.type)) return toast('That isn\'t an image');
  // The ceiling is the CLI's, sent with the library: turning a picture away
  // here only saves the trip, it isn't this side's rule to make.
  const max = state.lib.cover_max || 8 << 20;
  if (file.size > max) return toast(`That image is bigger than ${max >> 20} MB`);
  toast('Setting cover art\u2026');
  let r;
  try {
    r = await fetch('/api/playlist-cover?pl=' + encodeURIComponent(pl.file),
                    { method: 'POST', body: file }).then(x => x.json());
  } catch (e) { r = { ok: false }; }
  if (!r.ok) return toast(r.error || 'that image didn\'t work');
  await loadLibrary();
  toast('Cover art set');
}

async function clearCover(pl) {
  const r = await run('cover', pl.file, '--clear');
  if (r.ok) { await loadLibrary(); toast('Cover art removed'); }
}

/* Renaming happens in place: the title becomes the field you type in, which is
   as close as an edit gets to being the thing it edits. Enter and clicking away
   both keep it, Escape puts it back. Only the name changes - the file keeps its
   stem, which is what everything else here calls a playlist by. */
function startRename(pl) {
  const row = $('#title-row');
  if (!row) return;
  const inp = el('input');
  inp.id = 'rename-input';
  inp.type = 'text';
  inp.className = 'rename';
  inp.value = pl.name;
  inp.maxLength = 120;

  let done = false;                 // clicking away saves too, so once is once
  const finish = async keep => {
    if (done) return;
    done = true;
    inp.blur();                     // a reload won't redraw a field being typed
    const name = inp.value.trim();  // into, and this one has just stopped being one
    if (!keep || !name || name === pl.name) return render();
    const r = await run('rename', pl.file, name);
    if (r.ok) { await loadLibrary(); toast('Renamed to “' + name + '”'); }
    else render();                  // it wouldn't take: put the old name back
  };
  inp.onkeydown = e => {
    if (e.key === 'Enter')       { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  inp.onblur = () => finish(true);

  row.replaceChildren(inp);
  inp.focus();
  inp.select();
}

function renderHead() {
  const head = $('#head');
  head.replaceChildren();
  const songs = currentSongs();

  if (state.query) {
    const t = el('div');
    t.append(el('h1', '', 'Search'),
             el('div', 'sub', `${plural(songs.length, 'result')} for “${state.query}”`));
    head.append(t);
    if (songs.length) {
      const acts = el('div', 'acts');
      acts.append(button('Play first', 'primary', 'i-play', () => play(songs[0])));
      head.append(acts);
    }
    return;
  }

  const pl = state.view && state.lib.playlists.find(p => p.file === state.view);
  if (state.view && !pl) return;

  const name = pl ? pl.name : 'All songs';
  const count = pl ? pl.count : state.lib.songs.length;
  const secs = pl ? pl.duration : state.lib.duration;

  // The first song we can actually show art for: a playlist with no cover of
  // its own shouldn't wear a question mark just because the song at the top of
  // it has gone walkabout.
  const art = headArt(pl, songs, name);

  const t = el('div', 'titles');
  const row = el('div', 'title-row');
  row.id = 'title-row';
  const h = el('h1', '', name);
  // A name too long for the room it has is still readable here - and for a
  // playlist the tooltip is where the click says what it does, since a title
  // that lit up with no word for it would leave you guessing.
  h.title = pl ? 'Rename \u201c' + name + '\u201d' : name;
  row.append(h);
  if (pl) {
    // One click on the name is the whole gesture: the title is the field you
    // type in, so the thing you press is the thing you are editing.
    h.className = 'editable';
    h.tabIndex = 0;               // reachable without a mouse, like a button
    h.onclick = () => startRename(pl);
    h.onkeydown = e => { if (e.key === 'Enter') startRename(pl); };
  }
  t.append(row,
           el('div', 'sub', plural(count, 'song') + (secs ? ' · ' + longTime(secs) : '')));

  const acts = el('div', 'acts');
  if (count) acts.append(button('Play', 'primary', 'i-play', playAll));
  if (pl) acts.append(button('Delete', 'danger', 'i-trash', () => askDelete(pl)));
  head.append(art, t, acts);
}

/* In a playlist, a click plays from there and carries on through it. In the
   library or in search results there is no playlist to stay inside, so the
   bare `play <song>` form starts the whole library at that song. A caller
   looking at a playlist while offering a song from outside it says so by
   naming the list itself - null, meaning the library. */
/* The playlist on screen, or null when it's the library. Searching spans the
   whole library, so a search is never inside a playlist. */
const inPlaylist = () => (!state.query && state.view && state.view !== SETTINGS)
  ? state.view : null;

function play(song, inside = inPlaylist()) {
  if (song.missing) return toast('“' + song.title + '” isn’t in your music folder');
  // The window always says which list it is playing from: a playlist by name,
  // All songs and a search by `--library`. Never silence - the CLI reads a
  // song with no list named as a song typed in a terminal, where there is no
  // list on screen to mean, and works one out from what is playing instead.
  // Naming a song still names it under shuffle: it starts there and draws on.
  run('play', ...(inside ? [inside] : ['--library']), song.file);
}

/* Start what is on screen, with no song in mind - the Play button at the top
   and the one in the bar. Either way the CLI picks the song it opens on,
   shuffled or not: a playlist goes by name, and the library by `--library`,
   which is what says 'the library' rather than 'carry on with the playlist
   that is playing'. Naming a song here would be the window choosing, and a
   song the window chose is a song you chose - it wouldn't count as a play,
   and the shuffle would be free to come straight back to it. */
function playAll() {
  const inside = inPlaylist();
  run('play', ...(inside ? [inside] : ['--library']));
}

/* The minus button. Inside a playlist it only edits that list, which is
   harmless and immediate. In the library there is no list to leave the song
   in, so the song itself goes - and that is the one irreversible thing in the
   window, so it asks first. */
/* ---------------------------------------------------------- deleting */
/* A delete is shown before it is sent. The row goes, and every count that
   named it goes at the same moment, so the page never sits through a round
   trip to admit that something you just deleted is gone.

   What is in flight is kept here, because for that moment the library the
   server reports still has it - a reload landing in the window would put the
   row back. Each one is a function that takes the thing out of the page's own
   copy, run again after any reload until the server agrees, and safe to run
   twice because every one of them filters rather than subtracts.

   Waiting only for the command to answer isn't enough: the server holds its
   walk of the disk for a few seconds, so the very reload that follows a delete
   can still be carrying the song. So each one holds a second question - has
   this landed? - asked of every library that arrives, and is let go the moment
   the answer is yes.

   SETTLE is the backstop, and the reason this can't strand a song. A delete
   that quietly failed, or a song downloaded again under the same name, would
   otherwise be hidden for the life of the window; after this long the page
   stops arguing and shows whatever the server says is there. */
const pending = new Set();
const SETTLE = 10000;

async function optimistic(apply, send, said, agreed) {
  const held = { apply, agreed, until: 0 };
  apply();
  pending.add(held);
  renderPlaylists();
  render();
  if (said) toast(said);
  try {
    await send();             // `run` says so itself if this goes wrong
  } finally {
    // The clock starts when the CLI answers, not when it was asked: a slow
    // delete shouldn't spend its patience waiting to be carried out.
    held.until = Date.now() + SETTLE;
    loadLibrary();            // and then what really happened wins, either way
  }
}

/* Out of one playlist. A song taken off a list is still a song, so this is
   the smaller half: the list loses a name, a count, and that much time. */
function dropFromList(p, file, song) {
  if (!p || !(p.songs || []).includes(file)) return;
  p.songs = p.songs.filter(f => f !== file);
  p.count = Math.max(0, (p.count || 1) - 1);
  if (song?.duration) p.duration = Math.max(0, (p.duration || 0) - song.duration);
}

/* Out of everything. The file itself is going, so it leaves the library and
   every list that named it, and both totals come down with it. */
function forgetSong(file) {
  const song = state.byFile[file];
  state.lib.songs = state.lib.songs.filter(s => s.file !== file);
  delete state.byFile[file];
  if (song?.duration)
    state.lib.duration = Math.max(0, (state.lib.duration || 0) - song.duration);
  for (const p of state.lib.playlists) dropFromList(p, file, song);
}

/* A whole playlist. Its songs stay in the library, so only the list goes -
   and the page with it, if that was the list you were looking at. */
function forgetList(stem) {
  state.lib.playlists = state.lib.playlists.filter(p => p.file !== stem);
  if (state.view === stem) state.view = null;
}

async function removeSong(song) {
  const stem = inPlaylist();
  if (!stem) return askDeleteSong(song);
  // Looked up inside, not captured: a reload swaps the whole playlist array
  // for a fresh one, and the object caught out here would not be in it.
  return optimistic(
    () => dropFromList(state.lib.playlists.find(p => p.file === stem), song.file, song),
    () => run('remove', stem, song.file),
    'Removed from this playlist',
    // A playlist that has gone entirely is a playlist no longer naming it.
    lib => !(lib.playlists.find(p => p.file === stem)?.songs || []).includes(song.file));
}

/* The number column, and the play arrow that covers it on hover. A YouTube
   row has no number - it is in no list to be the nth of - but it keeps the
   column, so the arrow sits where it sits on every other row. Both kinds are
   built here because the playing bars replace this and have to put back
   exactly what they found. */
function trackNumber(row, i) {
  const num = el('div', 'num');
  num.append(el('span', 'n', row.classList.contains('yt') ? '' : i + 1));
  const p = svg('i-play');
  p.setAttribute('class', 'play');
  num.append(p);
  return num;
}

/* A row is a dozen elements, three parsed icons and an <img> that has to be
   fetched and decoded - and a render rebuilds the entire list, so building
   them is the whole cost of one. They are kept and handed back instead, keyed
   by everything a row draws: the same song gets the same row, re-parented
   rather than remade. Change anything about the song and the key changes with
   it, so the stale row is simply not found and a fresh one is built.

   This is what makes a delete look immediate: taking one song out leaves the
   other thousand to be moved, not rebuilt. It is also what stops every cover
   in the library being re-fetched on the 15s reload. */
const trackRows = new Map();

const rowKey = s => [s.file, s.rel || '', s.title, s.artist, s.album,
                     s.duration, s.missing ? 1 : 0].join('|');

function trackRow(s) {
  const row = el('div', 'track');
  row.dataset.rel = s.rel;

  const art = el('div', 'art');
  art.append(cover(s));

  row.classList.toggle('gone', !!s.missing);

  const t = el('div', 't');
  t.append(el('div', 'title', s.title),
           el('div', 'artist', s.missing ? 'Not found' : (s.artist || '—')));

  // The row itself plays on click, so both buttons have to keep their own.
  const keep = b => { b.ondblclick = ev => ev.stopPropagation(); return b; };

  const add = keep(el('button', 'add'));
  add.append(svg('i-plus'));
  add.title = 'Add to a playlist';
  add.onclick = ev => { ev.stopPropagation(); openAddMenu(s, add); };

  const rm = keep(el('button', 'add rm'));
  rm.append(svg('i-minus'));
  rm.onclick = ev => { ev.stopPropagation(); removeSong(s); };

  const acts = el('div', 'row-acts');
  acts.append(add, rm);

  row.append(trackNumber(row, 0), art, t,
             el('div', 'album', s.album || ''),
             el('div', 'dur', time(s.duration)), acts);
  // Both of these ask where they are when they are clicked, not when they are
  // built, so a kept row means the same thing in a playlist as in the library.
  row.ondblclick = () => play(s);
  row.onclick = ev => { if (ev.detail === 1) play(s); };
  return row;
}

/* The two things about a row that aren't the song: where in the list it sits,
   and what the minus does there. Set on the way out, so one kept row serves
   every position and both views.

   Inside a playlist the minus only edits that list. In the library there is no
   list to leave the song in, so it is the song itself that goes - which is
   worth a question first, being the one thing here that can't be undone. */
function songRow(s, i) {
  const key = rowKey(s);
  let row = trackRows.get(key);
  if (!row) trackRows.set(key, row = trackRow(s));

  // No number while this is the playing row: the bars standing in its place
  // are markNowPlaying's, and it puts the number back when the song moves on.
  const n = row.querySelector('.num .n');
  if (n) n.textContent = i + 1;
  row.querySelector('.rm').title =
    inPlaylist() ? 'Remove from this playlist' : 'Delete from your library';
  return row;
}

/* An empty library is the one moment somebody needs to know where their music
   comes from, so it is the one place the question is really asked - a folder
   full of music never shows this at all. The folder we are looking in is named
   rather than assumed, because "no songs" and "no songs *there*" are different
   things to be told, and choosing another one is a button under it rather than
   a setting to go and find. */

function emptyLibrary(e) {
  const root = state.lib.root || '~/Music';
  const gone = state.lib.root_exists === false;
  e.append(el('strong', '', 'No songs yet'),
           el('div', '', gone ? 'There is no folder at ' + root
                              : 'Nothing in ' + root));
  const act = el('div', 'act');
  act.append(...folderPicker('Choose your music folder'));
  e.append(act);
  if (!gone)
    e.append(el('div', 'also', 'or copy some music files in there'));
}

function renderList() {
  const list = $('#list');
  closeMenu();          // the button it hangs off is about to be replaced
  list.replaceChildren();
  const songs = currentSongs();

  // A search always has something to say underneath - what YouTube found, or
  // that it is still looking - so the empty state is only for an empty library
  // or an empty playlist.
  if (!songs.length && !state.query) {
    const e = el('div', 'empty');
    if (state.view) {
      e.append(el('strong', '', 'This playlist is empty'),
               el('div', '', 'Add songs below'));
    } else {
      emptyLibrary(e);
    }
    list.append(e);
    renderAdder(list);
    return;
  }

  if (!songs.length) {
    list.append(el('div', 'none', 'Nothing matched.'));
    renderFound(list);
    return;
  }

  const head = el('div', 'head-row');
  head.append(el('span', '', '#'), el('span', ''),
              el('span', '', 'Title'), el('span', '', 'Album'),
              el('span', 'r', 'Time'), el('span', ''));

  // Existing rows are re-parented by this, not rebuilt: one append, and the
  // ones that were already on screen never touch the DOM's builder at all.
  list.append(head, ...songs.map(songRow));

  // Rows for songs that have gone, or changed, aren't coming back - don't let
  // the map grow for the life of the window. Kept against the whole library
  // rather than what is on screen, or opening a playlist would throw away
  // every row you are about to come back to.
  const live = new Set(state.lib.songs.map(rowKey));
  for (const k of trackRows.keys()) if (!live.has(k)) trackRows.delete(k);

  renderAdder(list);
  renderFound(list);
  markNowPlaying();
}

/* --------------------------------------------------- adding from the library */
/* Under a playlist's own songs: the rest of your library, and under that what
   YouTube has - the same two halves the top bar's search shows, with the same
   box above them. The plus has no menu to open here, because the playlist on
   screen is the one it adds to; a song already in that playlist is left out
   rather than offered twice, so the list is always things you can add. */

/* Set while an add box is on screen, cleared by the next render: how a search
   that comes back late finds the rows it belongs to, if they are still there. */
let repaintAdder = null;

async function addTo(pl, file) {
  const r = await run('add', pl.file, file);
  if (r.ok) { await loadLibrary(); toast('Added to \u201c' + pl.name + '\u201d'); }
  return r.ok;
}

function adderRow(song, pl) {
  const row = el('div', 'track pick');
  row.classList.toggle('gone', !!song.missing);

  // Play sits where it sits on every other row - the left-hand column, shown
  // when the pointer is over the row, in place of the number these rows
  // haven't got. What is offered here is already a library song, so it is
  // played exactly as it is played upstairs, and the two feel like one thing.
  const num = el('div', 'num');
  num.append(el('span', 'n', ''));
  const p = svg('i-play');
  p.setAttribute('class', 'play');
  num.append(p);

  const art = el('div', 'art');
  art.append(cover(song));

  const t = el('div', 't');
  t.append(el('div', 'title', song.title),
           el('div', 'artist', song.missing ? 'Not found' : (song.artist || '\u2014')));

  const add = el('button', 'add');
  add.append(svg('i-plus'));
  add.title = 'Add to \u201c' + pl.name + '\u201d';
  add.onclick = ev => { ev.stopPropagation(); addTo(pl, song.file); };
  // The row plays on a double click, so the button keeps its own: a second
  // click on it is someone adding twice, not asking for the song.
  add.ondblclick = ev => ev.stopPropagation();

  const acts = el('div', 'row-acts');
  acts.append(add);
  row.append(num, art, t, el('div', 'album', song.album || ''),
             el('div', 'dur', time(song.duration)), acts);
  // The adder only ever offers songs the playlist hasn't got, so there is no
  // list here to play this one inside: it plays from the library, which is
  // what a found song already downloaded does from these same rows.
  row.ondblclick = () => play(song, null);
  row.onclick = ev => { if (ev.detail === 1) play(song, null); };
  return row;
}

function renderAdder(list) {
  const file = inPlaylist();                  // never during a top-bar search
  const pl = file && state.lib.playlists.find(p => p.file === file);
  if (!pl) return;

  const sec = el('div', 'found adder');
  const head = el('div', 'found-head');
  head.append(el('strong', '', 'Add songs'));

  const box = el('label', 'search');
  const inp = el('input');
  inp.type = 'text';               // not 'search': see the note in style.css
  inp.id = 'add-q';                 // named so a reload mid-typing leaves it be
  inp.placeholder = 'Search songs';
  inp.autocomplete = 'off';
  inp.spellcheck = false;
  inp.value = state.addQuery;
  const clear = el('button', 'clear', '\u00d7');
  clear.hidden = !state.addQuery;
  box.append(svg('i-search'), inp, clear);
  const bar = el('div', 'adder-search');
  bar.append(box);

  const rows = el('div');
  const yt = el('div', 'yt-part');

  const paint = () => {
    const q = state.addQuery.toLowerCase();
    const options = state.lib.songs.filter(s => !pl.songs.includes(s.file) && matches(s, q));
    rows.replaceChildren();
    if (options.length) options.forEach(s => rows.append(adderRow(s, pl)));
    else rows.append(el('div', 'none',
      state.addQuery          ? 'Nothing matched.'
      : state.lib.songs.length ? 'Every song is already here.'
                               : 'No songs yet.'));

    // ...and under that, what YouTube has, exactly as the top bar shows it -
    // the difference being that these land in this playlist.
    yt.replaceChildren();
    if (state.addQuery.length >= MIN_FIND) foundRows(yt, adderFind, pl);
  };
  repaintAdder = paint;

  // Only the rows are redrawn as you type: rebuilding the box you are typing
  // into would take the keyboard away from you between letters.
  inp.oninput = () => {
    state.addQuery = inp.value.trim();
    clear.hidden = !state.addQuery;
    adderFind.typed(state.addQuery);
    paint();
  };
  clear.onclick = () => { inp.value = ''; inp.oninput(); inp.focus(); };
  paint();

  sec.append(head, bar, rows, yt);
  list.append(sec);
}

function render() {
  repaintAdder = null;          // whatever is on screen is about to be replaced
  // Typing in the search box leaves settings for the results, and clearing it
  // comes back - so the box works from here too, without a way out to find.
  if (state.view === SETTINGS && !state.query) return renderSettings();
  if (state.view === STATS && !state.query) return renderStats();
  renderHead();
  renderList();
}

/* ------------------------------------------------------------------ theme */
/* Light or dark - and by default neither, because the desktop has already been
   asked that question and the window's job is to agree with the answer. A
   choice made here is this machine's own: it is kept in the config file beside
   `shuffle` and `volume`, since `simplmusik` in a terminal has no palette to
   set and a music folder carried to another machine shouldn't carry this
   machine's screen along with it. It is not kept in the browser, because the
   window is served on a free port picked fresh at every launch and a browser
   files what a page saved under the address it came from - so a choice left
   there would be looked for at an address that no longer exists, and every
   launch would start over at 'system'. The server writes the saved choice into
   index.html, which puts it on the element before the first paint and is where
   it is read back from here, so a reopened window starts in the right palette
   instead of correcting itself in front of you. */

const SYS_DARK = matchMedia('(prefers-color-scheme: dark)');

// What was chosen, held here as well as on disk: the window follows the click
// at once, and goes on working as you left it if the write never lands.
let themeWant = (() => {
  const v = document.documentElement.dataset.themeWant;
  return v === 'light' || v === 'dark' ? v : 'system';
})();

const themePick = () => themeWant;

function paintTheme() {
  const now = themeWant === 'system' ? (SYS_DARK.matches ? 'dark' : 'light')
                                     : themeWant;
  document.documentElement.dataset.theme = now;
  document.documentElement.dataset.themeWant = themeWant;
  // The desktop window is listening for this, so the titlebar around the page
  // wears what the page wears - a pinned choice is the page's to tell it, and
  // nothing else knows. In a browser tab there is nobody on the other end.
  try { window.webkit.messageHandlers.theme.postMessage(now); } catch (e) {}
}

function setTheme(pick) {
  themeWant = pick;
  paintTheme();           // the window changes on the click, not on the answer
  // ...and the choice goes to the config file, which is where the next launch
  // looks for it. Nothing waits on this and nothing is put back if it fails:
  // the palette you clicked for is the one you are looking at either way.
  fetch('/api/theme', { method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ theme: pick }) })
    .catch(() => {});
}

/* Following the desktop means following it while the window is open, not only
   at startup - a desktop that turns dark in the evening takes the window with
   it, with nothing to click. */
SYS_DARK.addEventListener('change', () => { if (themeWant === 'system') paintTheme(); });

paintTheme();

/* --------------------------------------------------------------- settings */
/* One page, and every line on it that changes anything is a CLI call - the
   music folder is `folder set` - so the window and a terminal can't drift
   apart on where your music is. */

/* Choosing your music folder, wherever you are standing when you need to.

   `folder set` with nothing after it opens the desktop's own folder dialog,
   so picking one is the same single CLI call that typing a path would be -
   and this is built once because two places offer it: the settings page, and
   an empty library, which is where somebody actually is the first time the
   question comes up. The text field is only for a machine with no dialog to
   open. What comes back is a list of nodes, so each caller can lay them out
   the way its own row wants. */

function typedFolder() { return state.lib.picker === false; }

function folderPicker(cta) {
  const chose = async (r, dir) => {
    if (!r.ok || (r.data && !r.data.changed)) return;
    await loadLibrary();
    toast('Music folder is now ' + ((r.data && r.data.folder) || dir));
  };
  if (!typedFolder()) {
    const pick = el('button', 'btn primary small', cta || 'Choose\u2026');
    pick.onclick = async () => chose(await run('folder', 'set'));
    return [pick];
  }
  const path = el('input');
  path.type = 'text'; path.id = 'set-folder'; path.placeholder = '/home/you/Music';
  path.autocomplete = 'off';
  const set = el('button', 'btn primary small', 'Use this folder');
  const go = async () => {
    const dir = path.value.trim();
    if (dir) chose(await run('folder', 'set', dir), dir);
  };
  path.onkeydown = e => { if (e.key === 'Enter') go(); };
  set.onclick = go;
  return [path, set];
}

function setRow(...kids) {
  const row = el('div', 'set-row');
  row.append(...kids);
  return row;
}

function label(name, sub) {
  const box = el('div', 'lbl');
  box.append(el('div', 'name', name));
  if (sub) box.append(el('div', 'sub', sub));
  return box;
}

/* Mint puts a switch on a settings row that is simply on or off, so this is
   one. It flips the moment you click it rather than after the round trip, and
   puts itself back if the CLI refuses - the window never shows a setting your
   library doesn't have. */

function toggle(on, change) {
  const t = el('button', 'tog');
  t.setAttribute('role', 'switch');
  const paint = v => { t.classList.toggle('on', v);
                       t.setAttribute('aria-checked', String(v)); };
  paint(on);
  t.onclick = async () => {
    const want = !t.classList.contains('on');
    paint(want);
    t.disabled = true;
    const ok = await change(want);
    t.disabled = false;
    if (!ok) paint(!want);
  };
  return t;
}

/* The settings row that is one of a few named choices rather than simply on or
   off. Every choice is on show and clicking one is the whole interaction -
   there is nothing to confirm, and nothing here that a round trip could
   refuse, so it paints and it is done. */

function segment(choices, now, change) {
  const wrap = el('div', 'seg');
  wrap.setAttribute('role', 'radiogroup');
  const btns = choices.map(([val, name]) => {
    const b = el('button', '', name);
    b.setAttribute('role', 'radio');
    b.dataset.val = val;
    b.onclick = () => { paint(val); change(val); };
    return b;
  });
  const paint = v => btns.forEach(b => {
    const on = b.dataset.val === v;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  paint(now);
  wrap.append(...btns);
  return wrap;
}

/* The settings row that is a number on a range rather than a switch. The
   readout follows the handle at once and the CLI is told at a throttle, so
   dragging it is something you hear moving rather than a call per pixel; the
   position you let go on always lands, whatever the throttle was in the middle
   of. It keeps the focus after a drag on purpose - the arrow keys are then its
   own, and a focused slider is what stops the library timer redrawing the page
   out from under your hand. */

const SLIDE_EVERY = 200;

function slider(id, lo, hi, step, now, unit, change) {
  const wrap = el('div', 'slide');
  const inp = el('input');
  inp.type = 'range';
  inp.id = id;
  // The id is for the focus guard below; off is so no browser ever restores an
  // old position into it, which would be a setting nobody asked for.
  inp.autocomplete = 'off';
  inp.min = lo; inp.max = hi; inp.step = step; inp.value = now;
  const out = el('div', 'val', inp.value + unit);
  let sent = 0, timer = null;
  const go = v => { clearTimeout(timer); timer = null; sent = Date.now();
                    return change(v); };
  inp.oninput = () => {
    out.textContent = inp.value + unit;
    clearTimeout(timer);
    const v = inp.value, wait = SLIDE_EVERY - (Date.now() - sent);
    if (wait <= 0) go(v); else timer = setTimeout(() => go(v), wait);
  };
  inp.onchange = () => go(inp.value);   // the one that must land, throttle or no
  wrap.append(inp, out);
  return wrap;
}

/* Where levelling aims. Only ever shown under a levelling switch that is on:
   with it off there is no gain for a target to be the target of, and a slider
   that changed nothing you could hear would be a lie about what it does. */

function targetRow() {
  const range = state.lib.target_range || [-30, -12];
  const now = state.lib.target === undefined ? -20 : state.lib.target;
  return setRow(
    label('Target loudness'),
    slider('set-target', range[0], range[1], 1, now, ' dB',
           v => run('target', String(v))));
}

function renderSettings() {
  closeMenu();
  const head = $('#head');
  head.replaceChildren();
  head.append(el('h1', '', 'Settings'));

  const page = el('div', 'settings');
  const root = state.lib.root || '';
  // Every song we found is somewhere under the folder, so the count on the
  // row is simply the library - subfolders came with it.
  const here = state.lib.songs.filter(s => !s.missing).length;

  page.append(el('div', 'set-sec', 'Music folder'));
  const box = el('div', 'panel');
  const ico = svg('i-folder');
  ico.setAttribute('class', 'ico');
  box.append(setRow(ico, label(root, plural(here, 'song'))));

  // There is one folder, so the only thing to do is point it somewhere else.
  if (typedFolder()) {
    box.append(setRow(...folderPicker()));
  } else {
    box.append(setRow(label('Use a different folder'),
                      ...folderPicker('Change\u2026')));
  }
  page.append(box, el('div', 'hint',
    'Subfolders count too. Downloads and playlists land here. Changing the '
    + 'folder moves your playlists across; no song is touched.'));

  page.append(el('div', 'set-sec', 'Playback'));
  const sound = el('div', 'panel');
  const levelled = state.lib.levelling !== false;
  // Appended and removed rather than hidden, so the row above it is really the
  // last one when the switch is off and wears no border under it.
  const aim = targetRow();
  const show = on => on ? sound.append(aim) : aim.remove();
  sound.append(setRow(
    label('Even loudness', 'Play every song at the same volume'),
    toggle(levelled, async on => {
      show(on);                 // follow the switch at once, not the round trip
      const r = await run('levelling', on ? 'on' : 'off');
      if (r.ok) await loadLibrary();
      else show(levelled);      // the switch went back, and so does the row
      return r.ok;
    })));
  show(levelled);
  page.append(sound, el('div', 'hint',
    'Songs are measured the first time you play them. Your files are never '
    + 'changed, and nothing is ever turned up loud enough to distort.'));

  page.append(el('div', 'set-sec', 'Appearance'));
  const look = el('div', 'panel');
  look.append(setRow(
    label('Theme'),
    segment([['system', 'System'], ['light', 'Light'], ['dark', 'Dark']],
            themePick(), setTheme)));
  page.append(look, el('div', 'hint',
    'System follows your desktop. This is a setting of this window on this '
    + 'machine only.'));

  page.append(el('div', 'set-sec', 'Library'));
  const info = el('div', 'panel');
  const missing = state.lib.songs.filter(s => s.missing).length;
  info.append(setRow(label('Songs'),
                     el('div', 'val', String(state.lib.songs.length - missing))),
              setRow(label('Playlists'),
                     el('div', 'val', String(state.lib.playlists.length))),
              setRow(label('Not found',
                           missing ? 'In a playlist, not in your folder' : ''),
                     el('div', 'val', String(missing))),
              setRow(label('Playlists folder'),
                     el('div', 'val', state.lib.playlists_dir || '')));
  page.append(info);
  page.append(el('div', 'hint',
    'simplmusik - A JJM8 Production.'));
  $('#list').replaceChildren(page);
}

/* ------------------------------------------------------------------ stats */
/* One question, drawn: how long you listened, and when. `simplmusik stats`
   works the buckets out from the play log and hands over all three sizes at
   once, so switching between them is instant and the window does no
   arithmetic of its own.

   Hours per day is the default because that is the shape of a listening
   habit. Hourly is the same series zoomed into the last two days, weekly the
   same one pulled back to half a year - a zoom rather than a new question. */

const STEPS = [['hour', 'Hourly'], ['day', 'Daily'], ['week', 'Weekly']];
const STEP_SUB = { hour: 'the last 48 hours', day: 'the last 30 days',
                   week: 'the last 26 weeks' };

/* Seconds as somebody would say them - the same wording the CLI prints, so
   one evening is never described two ways. */
const spellSecs = s => {
  s = Math.round(s || 0);
  if (s < 90) return `${s} sec`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.floor(m / 60)} hr ${m % 60} min`;
};

/* Read afresh every time the page is opened, and held while you are on it: the
   log only grows when a song ends, so nothing changes under you while you read
   and the sidebar's own timer should not cost a round trip. */
async function loadStats() {
  const r = await call('stats');
  state.stats = r.ok ? (r.data || null) : null;
  // The CLI refuses with a sentence when there is nothing logged yet, which is
  // the right thing to put on an empty page, so it is kept rather than
  // replaced with one of our own.
  state.statsWhy = r.ok ? null : (r.error || 'couldn’t read the play log');
}

/* ---------------------------------------------------------- the chart */

const SVGNS = 'http://www.w3.org/2000/svg';
const node = (t, attrs) => {
  const n = document.createElementNS(SVGNS, t);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
};

/* A column: square where it stands on the baseline, rounded at the end the
   data reaches. The radius gives way on a short bar rather than swelling it,
   so a quiet hour still reads as smaller than a busy one. */
function column(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${x} ${y + h}V${y + r}a${r} ${r} 0 0 1 ${r} ${-r}h${w - 2 * r}`
       + `a${r} ${r} 0 0 1 ${r} ${r}V${y + h}Z`;
}

const tickText = s => !s ? '0'
  : s >= 3600 ? (((s / 3600) % 1) ? (s / 3600).toFixed(1) : s / 3600) + 'h'
  : Math.round(s / 60) + 'm';

/* Where the axis stops and what it counts in. Clean numbers only - the ticks
   carry every value that isn't labelled on the chart, so they have to be
   numbers you can read off rather than whatever the tallest bar happened to
   be. Four gaps at most, which is as many lines as can cross a plot this
   size without becoming the thing you look at. */
function scaleFor(top) {
  const unit = top >= 3600 ? 3600 : 60;
  const steps = unit === 3600 ? [0.25, 0.5, 1, 2, 3, 4, 6, 12, 24]
                              : [1, 2, 5, 10, 15, 30];
  const want = top / unit || 1;
  const step = steps.find(s => want / s <= 4) || steps[steps.length - 1];
  const high = Math.max(step, Math.ceil(want / step) * step);
  const ticks = [];
  for (let v = 0; v <= high + 1e-9; v += step) ticks.push(v * unit);
  return { high: high * unit, ticks };
}

/* Drawn at the size it is actually being shown at rather than scaled into a
   viewBox: a chart stretched to fit would take its type and its 4px corners
   along with it, and both are meant to be the same size on every screen. */
function drawChart(box, rows) {
  const W = Math.max(320, Math.round(box.clientWidth));
  const H = 260, padL = 46, padR = 14, padT = 14, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const svg = node('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`,
                            class: 'chart', role: 'img' });
  const top = Math.max(...rows.map(r => r.heard), 0);
  const { high, ticks } = scaleFor(top);
  const y = v => padT + plotH - (v / high) * plotH;

  svg.setAttribute('aria-label',
    `Listening time per bucket. Highest ${spellSecs(top)}.`);

  // The grid, one step off the surface and hairline: it is there to be
  // measured against, not to be looked at.
  for (const t of ticks) {
    svg.append(node('line', { class: 'grid', x1: padL, x2: W - padR,
                              y1: y(t) + .5, y2: y(t) + .5 }));
    const lab = node('text', { class: 'tick', x: padL - 9, y: y(t) + 4,
                               'text-anchor': 'end' });
    lab.textContent = tickText(t);
    svg.append(lab);
  }

  const band = plotW / rows.length;
  const barW = Math.max(2, Math.min(24, band - 2));   // the 2px gap is the gap
  // Enough labels to place the chart in time, and no more - they collide long
  // before the bars do. Counted back from the newest, so 'now' is always one.
  const every = Math.max(1, Math.ceil(rows.length / 7));

  // The highlight goes down before the bars, so it lights the column the bar
  // stands in rather than painting over the bar you are pointing at.
  const mark = node('rect', { class: 'band', y: padT, height: plotH,
                              width: band, opacity: 0 });
  svg.append(mark);

  rows.forEach((r, i) => {
    const x = padL + i * band + (band - barW) / 2;
    if (r.heard > 0) {
      const h = Math.max(2, (r.heard / high) * plotH);
      svg.append(node('path', { class: 'bar', d: column(x, padT + plotH - h, barW, h) }));
    }
    if ((rows.length - 1 - i) % every === 0) {
      const lab = node('text', { class: 'tick', x: x + barW / 2,
                                 y: H - padB + 17, 'text-anchor': 'middle' });
      lab.textContent = r.label;
      svg.append(lab);
    }
  });

  // Every hit target last, so all of them are above every bar. Interleaved
  // with the bars, a tall bar drawn after its neighbour's target would take
  // the pointer itself and the column next to it would go dead.
  rows.forEach((r, i) => {
    // The target is the whole column of air, not the bar: an empty Tuesday has
    // nothing to point at and is still worth being told about.
    const hit = node('rect', { class: 'hit', x: padL + i * band, y: padT,
                               width: band, height: plotH });
    const why = node('title');
    why.textContent = `${r.full} — ${r.heard ? spellSecs(r.heard) : 'nothing'}`;
    hit.append(why);
    hit.dataset.i = i;
    svg.append(hit);
  });

  const tip = el('div', 'chart-tip');
  tip.hidden = true;

  svg.onmousemove = e => {
    const at = e.target.closest?.('.hit');
    if (!at) return;
    const i = +at.dataset.i, r = rows[i];
    mark.setAttribute('x', padL + i * band);
    mark.setAttribute('opacity', '1');
    tip.replaceChildren(el('div', 'k', r.full),
                        el('div', 'v', r.heard ? spellSecs(r.heard) : 'nothing'));
    tip.hidden = false;
    // Kept inside the box: near the right-hand edge it flips to the other
    // side of the column rather than hanging off the chart.
    const mid = padL + i * band + band / 2;
    tip.style.left = Math.min(Math.max(mid, 60), W - 60) + 'px';
    tip.style.top = Math.max(6, y(r.heard) - 52) + 'px';
  };
  svg.onmouseleave = () => { tip.hidden = true; mark.setAttribute('opacity', '0'); };

  box.replaceChildren(svg, tip);
}

// One observer for the page, reconnected each render: the chart is drawn at
// the width it has, so it has to be drawn again when that changes.
let chartWatch = null;

function renderStats() {
  closeMenu();
  const head = $('#head');
  head.replaceChildren();
  head.append(el('h1', '', 'Stats'));

  const page = el('div', 'settings');
  const s = state.stats;
  if (!s) {
    const e = el('div', 'empty');
    e.append(el('strong', '', state.statsWhy ? 'Nothing to show yet' : 'Reading…'));
    if (state.statsWhy) e.append(el('div', '', state.statsWhy));
    e.style.padding = '40px 10px';
    page.append(e);
    return void $('#list').replaceChildren(page);
  }

  const step = state.statsStep || 'day';
  const rows = (s.series || {})[step] || [];
  const total = rows.reduce((n, r) => n + r.heard, 0);

  // The filter sits over the chart, and the total beside it is of what the
  // chart is showing - change the step and the number changes with it.
  const top = el('div', 'chart-head');
  const fig = el('div', 'fig');
  fig.append(el('div', 'hero', spellSecs(total)),
             el('div', 'sub', 'listening in ' + STEP_SUB[step]));
  top.append(fig, segment(STEPS, step, v => {
    state.statsStep = v;
    renderStats();
  }));
  page.append(top);

  const panel = el('div', 'panel chart-panel');
  const box = el('div', 'chart-wrap');
  panel.append(box);
  page.append(panel);

  page.append(el('div', 'hint',
    'Time your ears actually did: a song paused is not counted, and a song you '
    + 'played twice over is counted twice. Read out of the play log in your '
    + 'music folder — `simplmusik stats` says the same in a terminal.'));

  $('#list').replaceChildren(page);

  // Drawn once the box is in the document and has a width to be drawn at.
  drawChart(box, rows);
  chartWatch?.disconnect();
  chartWatch = new ResizeObserver(() => drawChart(box, rows));
  chartWatch.observe(box);
}

/* ------------------------------------------------------------- downloads */
/* What the search turned up on YouTube, listed under whatever the library
   matched. Downloading writes one file into ~/Music and does nothing else -
   the song joins no playlist - so what it leaves behind is an ordinary
   library song, and the list above is where it appears. */

function renderFound(list) {
  if (state.query.length < MIN_FIND) return;    // too short to have searched
  const sec = el('div', 'found');
  foundRows(sec, find);
  list.append(sec);
}

/* The download indicator: a ring that turns while the bytes come in. The
   turning is the part that says 'something is happening' - the arc inside it
   is how much of the file has landed, when yt-dlp knows the total. When it
   doesn't, or when the fetch is done and ffmpeg is re-encoding, the arc stays
   a short sliver and only the spin remains, rather than a made-up number. */

const ARC = 39;                     // circumference of an r=6.2 circle, near enough

function ring() {
  const n = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  n.setAttribute('class', 'ring');
  n.setAttribute('viewBox', '0 0 16 16');
  n.innerHTML = '<circle class="rail" cx="8" cy="8" r="6.2"/>'
              + '<circle class="arc" cx="8" cy="8" r="6.2"/>';
  return n;
}

/* How far along a download is, or undefined until the CLI has said anything.
   Both of these read the same entry, so the ring and the words can't disagree. */
const fraction = d => (d && d.stage === 'downloading' && d.percent !== null
                       && d.percent !== undefined) ? d.percent / 100 : null;

const progressWord = d => d && d.stage === 'failed' ? 'Download failed'
                        : d && d.stage === 'converting' ? 'Converting\u2026'
                        : fraction(d) !== null ? 'Downloading\u2026 ' + Math.round(d.percent) + '%'
                        : 'Downloading\u2026';

/* Paint one row's ring and caption from the latest state. Done in place, never
   by redrawing the row: the list is rebuilt on a timer, and a ring that
   restarted its animation twice a second would stutter. */
function paintDownload(row, d) {
  // A failed fetch stops turning: a ring still going round is the one thing
  // that would say it is still coming when it isn't.
  row.classList.toggle('dl-failed', !!d && d.stage === 'failed');
  const arc = row.querySelector('.arc');
  if (arc) {
    const f = fraction(d);
    arc.style.strokeDashoffset = (f === null ? ARC * 0.72 : ARC * (1 - f)).toFixed(2);
  }
  const sub = row.querySelector('.artist');
  if (sub) sub.textContent = progressWord(d);
}

function markDownloads() {
  const all = state.now.downloads || {};
  document.querySelectorAll('.track.yt.dl-on').forEach(
    row => paintDownload(row, all[row.dataset.yt]));
}

/* Play it now, without waiting for it. The song starts from YouTube's own
   audio URL, and a copy is fetched into the cache behind it - quietly, and
   saying nothing, because playing a song is playing a song and nobody asked
   to watch a download. What it buys is the next thing: pressing download
   after this is a rename, not a fetch. */
async function stream(r, pl) {
  const res = await call('stream', r.id);
  if (!res.ok) return void toast(res.error || 'couldn\'t play that');
  const d = res.data || {};
  render();
  poll();                           // the bar should say what is playing at once
  // Asked for from inside a playlist, it joins that playlist once it is a real
  // song - which is the same promise the download button makes.
  if (pl && d.song && !d.streaming) addTo(pl, d.song);
}

/* `pl` is the playlist the row is being offered from, or nothing when this is
   the top bar's search. It changes what the button on the right promises: in a
   playlist, downloading is only half the job, so the row goes on to add the
   song - and one already in the library needs no download at all, just the
   plus. */
/* Playing a found row. A song already downloaded is played from the disk -
   the same call the row upstairs makes, so it is the same song played the
   same way, and no time goes on asking YouTube about a file we already have.
   Only a song we haven't got is streamed. */
function playFound(r, pl) {
  const have = r.song && state.byFile[r.song];
  if (!have) return stream(r, pl);
  // Downloaded, but not in the playlist on screen: there is no list to play it
  // in, so it plays from the library instead of from a list it isn't in.
  if (pl && !pl.songs.includes(r.song)) return run('play', '--library', r.song);
  return play(have);
}

function foundRow(r, pl) {
  const row = el('div', 'track yt');
  row.dataset.yt = r.id;
  // A download this page started, or one it found already running - a reload
  // loses the flag but not the download. Caching behind a played song is not
  // reported at all, so it never reaches this.
  const dl = state.now.downloads?.[r.id];
  const busy = !!r.downloading || !!dl;
  row.classList.toggle('dl-on', busy);

  // The file this result has turned out to be, once it is one. It is how the
  // row knows itself in what the player reports after a stream has landed and
  // the song is being played from the disk like any other.
  if (r.song) row.dataset.song = r.song;

  // Play sits where it sits on every other row - the left-hand column, under
  // the number, shown when the pointer is over the row. A found song is
  // played the same way a library song is, so it is asked for the same way.
  const num = trackNumber(row, 0);

  const art = el('div', 'art');
  art.append(cover({ title: r.title, artist: r.channel }));

  const t = el('div', 't');
  t.append(el('div', 'title', r.title),
           el('div', 'artist', busy ? progressWord(dl) : (r.channel || '\u2014')));

  // All three states live on the result rather than on the button, because the
  // library reloads on a timer and would otherwise redraw a download in
  // progress as though it had never been started.
  let act;
  if (busy) {
    act = el('div', 'dling');
    act.append(ring());
    act.title = 'Downloading\u2026';
  } else if (r.song && (!pl || pl.songs.includes(r.song))) {
    act = el('div', 'got');                 // it's a real song upstairs now
    act.append(svg('i-check'));
    act.title = pl ? 'In this playlist' : 'In your library';
  } else {
    // One button, and it always asks where. A song already downloaded goes
    // through the ordinary menu, which knows the playlists it is in already
    // and leaves those out; one that isn't goes through the menu that has to
    // offer everything, and adds it to the library on the way.
    act = el('button', 'add');
    act.append(svg('i-plus'));
    act.title = 'Add to\u2026';
    act.onclick = ev => {
      ev.stopPropagation();
      if (r.song) openAddMenu({ file: r.song }, act);
      else openFoundMenu(r, act);
    };
    // The row plays on a double click, so the button keeps its own: a second
    // click on it is someone shutting the menu, not asking for the song.
    act.ondblclick = ev => ev.stopPropagation();
  }

  const acts = el('div', 'row-acts');
  acts.append(act);
  row.append(num, art, t, el('div', 'album', ''),
             el('div', 'dur', time(r.duration)), acts);
  row.title = r.song ? 'Play' : 'Play without downloading';
  row.ondblclick = () => playFound(r, pl);
  row.onclick = ev => { if (ev.detail === 1) playFound(r, pl); };
  // A row built mid-download starts where the download actually is, so a
  // rebuild never rewinds the ring to nothing.
  if (busy) paintDownload(row, dl);
  return row;
}

/* A row spins while either of two things says it is downloading: this flag,
   set the moment it is asked for, and the CLI's own report, which the poll
   copies into `state.now.downloads`. The call coming back settles the first
   but not the second, and the two disagree for as long as half a second - the
   poll's tick. That is long enough to matter when there is nothing to fetch:
   a song already in the library answers in about the time it takes to ask
   YouTube what the file would be called, and the CLI has said 'starting' by
   then, so a poll can land in the gap. The render that follows would rebuild
   the row from that stale entry as still downloading, and `markDownloads`
   goes on turning a ring for an entry it can no longer find - so it would sit
   there saying 'Downloading...' until the 15s library reload redrew it.

   So the answer is the end of it: this fetch is over, whatever the last poll
   thought, and the entry goes with it. The next poll re-reads the truth from
   disk, so a download still genuinely running comes straight back. */
function downloadOver(r) {
  r.downloading = false;
  if (state.now.downloads) delete state.now.downloads[r.id];
}

async function download(r, pl) {
  if (r.downloading) return;
  r.downloading = true;
  render();                         // say so now, not when the bytes land
  const res = await call('download', r.id);
  downloadOver(r);
  if (!res.ok) {
    render();
    toast(res.error || 'the download didn\'t work');
    return;
  }
  const d = res.data || {};
  r.song = d.song;
  render();                         // the ring stops here, not at the next poll
  // Downloaded from inside a playlist, the song joins it: half a job otherwise,
  // since that is the list you were looking at when you asked for it.
  if (pl && d.song) return void addTo(pl, d.song);
  toast(!d.downloaded ? 'Already in your library'
        : (d.cached ? 'Added \u201c' : 'Downloaded \u201c') + d.song + '\u201d');
  loadLibrary();                    // it is a library song now: let it show up as one
}

/* ------------------------------------------------------- add to playlist */
/* Offers only the playlists a song isn't already in, in the order the sidebar
   shows them - most recently changed first, so the list you just built is at
   the top, which is nearly always the one you want again. That order is the
   playlist file's own timestamp and is settled by the backend, so adding a
   song is what makes it recent and there's no extra state to keep in step. */

let menu = null;

function closeMenu() {
  if (!menu) return;
  document.querySelectorAll('.add.open').forEach(b => b.classList.remove('open'));
  menu.remove();
  menu = null;
}

function openAddMenu(song, btn) {
  const reopening = btn.classList.contains('open');
  closeMenu();
  if (reopening) return;              // a second click on the same + closes it

  btn.classList.add('open');
  menu = el('div', 'menu');
  menu.append(el('div', 'mt', 'Add to playlist'));

  const options = state.lib.playlists.filter(p => !p.songs.includes(song.file));

  if (!options.length) {
    menu.append(el('div', 'none', state.lib.playlists.length
      ? 'Already in every playlist.'
      : 'No playlists yet - make one in the sidebar.'));
  } else {
    for (const p of options) {
      const b = el('button');
      const ico = svg('i-list');
      ico.setAttribute('class', 'ico');
      b.append(ico, el('span', 'name', p.name), el('span', 'count', p.count));
      b.onclick = async ev => {
        ev.stopPropagation();
        closeMenu();
        const r = await run('add', p.file, song.file);
        if (r.ok) { await loadLibrary(); toast(`Added to \u201c${p.name}\u201d`); }
      };
      menu.append(b);
    }
  }

  placeMenu(btn);
}

/* Measure it where it lands, then pull it back inside the window if it would
   spill off the right or bottom - rows near either edge are common. */
function placeMenu(btn) {
  document.body.append(menu);
  const r = btn.getBoundingClientRect(), m = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(r.right - m.width,
                                         innerWidth - m.width - 8)) + 'px';
  menu.style.top = (r.bottom + m.height > innerHeight - 8
                    ? Math.max(8, r.top - m.height - 4)
                    : r.bottom + 4) + 'px';
}

/* The same menu again, for a song that isn't in the library yet. It offers
   your library as well as your playlists: from the general search "add it"
   most often means "keep this", and there is no playlist implied there to
   stand in for that.

   Unlike the library's menu it can't grey out the playlists a song is already
   in. A search result is an id and a title, and which file it would become is
   only settled once it has been fetched - so this offers everything, and the
   backend passes over a name a playlist already has. The cost of not knowing
   is a menu a little longer than it needed to be. */
function openFoundMenu(r, btn) {
  const reopening = btn.classList.contains('open');
  closeMenu();
  if (reopening) return;              // a second click on the same one closes it

  btn.classList.add('open');
  menu = el('div', 'menu');
  menu.append(el('div', 'mt', 'Add to'));

  const pick = (target, label, icon, count) => {
    const b = el('button');
    const ico = svg(icon);
    ico.setAttribute('class', 'ico');
    b.append(ico, el('span', 'name', label), el('span', 'count', count));
    b.onclick = ev => { ev.stopPropagation(); closeMenu(); download(r, target); };
    menu.append(b);
  };

  pick(null, 'All songs', 'i-note', state.lib.songs.length);
  for (const p of state.lib.playlists) pick(p, p.name, 'i-list', p.count);
  placeMenu(btn);
}

document.addEventListener('click', e => {
  if (menu && !menu.contains(e.target)) closeMenu();
});
document.addEventListener('scroll', closeMenu, true);   // true: the list scrolls
addEventListener('resize', closeMenu);

/* ------------------------------------------------------------- now playing */

/* The bars belong to the list the song is playing from, and to no other.
   The same song sitting in a second playlist is not the one being played, so
   it stays an ordinary row there. `playlist` is the stem the player was
   started with and null for the library, which is what the view is too - so
   'is this the list it's playing from' is still a single comparison.

   A YouTube row is in no list, so that question never reaches it and it asks
   the plainer one: is the player on this? Which is true while it is streaming
   this very result, and true again once the result has become a file and that
   file is what is playing. Those two are the before and after of a stream
   landing, and nothing has to be told when it happens - the id leaves the
   player's answer as the filename arrives, so the bars move themselves, on
   the same tick every other song change moves on. */
function markNowPlaying() {
  const n = state.now;
  const here = !!n.playing && (n.playlist || null) === inPlaylist();
  document.querySelectorAll('.track').forEach(row => {
    const { yt, song, rel } = row.dataset;
    const on = yt ? !!n.playing && (yt === n.vid || song === n.rel)
                  : here && rel === n.rel;
    row.classList.toggle('now', on);
    row.classList.toggle('paused', on && n.paused);
    const num = row.querySelector('.num');
    const had = !!num.querySelector('.eq');
    if (on && !had) {
      const eq = el('div', 'eq');
      eq.innerHTML = '<i></i><i></i><i></i>';
      num.replaceChildren(eq);
    } else if (!on && had) {
      const i = [...row.parentNode.querySelectorAll('.track')].indexOf(row);
      num.replaceChildren(...trackNumber(row, i).childNodes);
    }
  });
}

let lastRel = null;
function renderPlayer() {
  const n = state.now;
  const playing = !!n.playing;

  const stem = (n.song || '').replace(/\.[^.]+$/, '');
  $('#now-title').textContent  = playing ? (n.meta?.title || stem) : 'Nothing playing';
  $('#now-artist').textContent = playing ? (n.meta?.artist || n.playlist || 'All songs')
                                         : 'Pick a song to start';

  if (n.rel !== lastRel) {                  // only rebuild the art on a change
    lastRel = n.rel;
    scrub = null;                           // a new song: nothing pending
    const art = $('#now-art');
    art.replaceChildren();
    if (playing) art.append(cover({ rel: n.rel, title: n.meta?.title || n.song,
                                   artist: n.meta?.artist }, 18));
  }

  $('#c-play').firstElementChild.innerHTML =
    `<use href="#${playing && !n.paused ? 'i-pause' : 'i-play'}"/>`;
  $('#c-play').title = playing && !n.paused ? 'Pause (Space)' : 'Play (Space)';
  $('#c-shuffle').classList.toggle('on', !!n.shuffle);
  $('#c-shuffle').title = 'Shuffle: ' + (n.shuffle ? 'on' : 'off') + ' (s)';
  for (const id of ['#c-skip', '#c-back', '#c-stop']) $(id).disabled = !playing;

  renderVolume(n);

  const dur = n.duration || 0;
  settled(n);
  const at = scrub !== null ? scrub : n.elapsed;   // pending seek wins
  bar.classList.toggle('live', playing && dur > 0);
  $('#t-now').textContent = playing ? time(at) : '0:00';
  $('#t-end').textContent = playing && dur ? time(dur) : '0:00';
  $('#t-fill').style.width = (playing && dur
    ? Math.min(100, (at / dur) * 100) : 0) + '%';

  markNowPlaying();
}

/* ------------------------------------------------------------------ data */

async function loadLibrary() {
  state.lib = await api('/api/library');
  state.byFile = Object.fromEntries(state.lib.songs.map(s => [s.file, s]));
  // A delete still in flight is still deleted, as far as the page is
  // concerned: the server's answer simply hasn't caught up, and a row
  // flickering back for a tenth of a second is worse than never seeing it go.
  for (const held of pending) {
    if (!held.until) { held.apply(); continue; }   // not even asked yet
    // Asked and answered, and this library agrees: nothing left to hide.
    if (held.agreed(state.lib)) { pending.delete(held); continue; }
    // It still disagrees. Believe the page, until SETTLE says believe the server.
    if (Date.now() > held.until) { pending.delete(held); continue; }
    held.apply();
  }
  // The pages that are not playlists are not in this list and never will be,
  // so they are asked about first: without that the reload every 15s decides
  // the page you are reading has been deleted and puts you back in the library.
  if (state.view && state.view !== SETTINGS && state.view !== STATS
      && !state.lib.playlists.some(p => p.file === state.view))
    state.view = null;                      // it went away: fall back to all songs
  renderPlaylists();
  // The library reloads on a timer; don't yank the page out from under someone
  // half way through typing into it - a folder, or a song to add.
  if (/^(set-folder|add-q|rename-input|set-target)$/.test(document.activeElement?.id || '')) return;
  render();
}

async function poll() {
  try {
    state.now = await api('/api/state');
    renderPlayer();
    markDownloads();
  } catch (e) { /* server restarting: the next tick will catch up */ }
}

/* --------------------------------------------------------------- controls */

/* The transport as functions, with the buttons as one caller of them and the
   keyboard as another. A shortcut that reached for .click() would be taking
   the bar's word for what is possible - and the bar disables skip, back and
   stop while nothing is playing, which is a statement about a button being
   worth pressing, not about what the key should do.

   So the keys ask the same question the buttons do and get their own answer:
   asked for the next song with nothing playing, there is still a view on
   screen and starting it is what 'next' means there. */

function playPause() {
  const n = state.now;
  if (!n.playing) return playAll();
  run(n.paused ? 'resume' : 'pause');
}
const nextTrack = () => state.now.playing ? run('skip') : playAll();
const prevTrack = () => state.now.playing ? run('back') : playAll();

$('#c-play').onclick = playPause;
$('#c-skip').onclick = nextTrack;
$('#c-back').onclick = prevTrack;
$('#c-stop').onclick = () => run('stop');

/* A switch, not a jump: it never starts anything. On, everything played from
   then on is shuffled - including whatever is playing right now, which keeps
   the song it is on and only draws differently after it. */
$('#c-shuffle').onclick = () => run('shuffle');

/* volume ----------------------------------------------------------------- */
/* A setting rather than a property of what is playing, so the slider works
   with nothing on and stays where you left it - the same kind of switch as
   shuffle. It multiplies whatever levelling decided, and stops at 100,
   because above that a song could clip.

   The number goes straight through as it is: mpv's volume scale is cubic, so
   the useful settings are spread along the slider evenly instead of crowding
   into the bottom of it, and putting a curve of our own on top would only
   fight that.

   Like a seek, the paint gets ahead of the truth - `vol` holds what you asked
   for until the server reports it back. Unlike a seek it sends *while* you
   drag, throttled: hearing it move is the whole point of a volume slider, but
   a CLI call per pixel is still too many. */

const vbar = $('#vol-bar'), VOL_EVERY = 150;
let vol = null, sliding = false, vsent = 0, vtimer = null;

function volAt(e) {
  const r = vbar.getBoundingClientRect();
  return Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 100);
}

function sendVol(v, now) {
  clearTimeout(vtimer);
  const go = () => { vsent = Date.now(); return run('volume', String(v)); };
  const wait = VOL_EVERY - (Date.now() - vsent);
  if (now || wait <= 0) return go();
  vtimer = setTimeout(go, wait);       // the last move in a quiet moment wins
  return Promise.resolve();
}

function setVol(v, now) {
  vol = Math.min(100, Math.max(0, v));
  renderVolume(state.now);
  return sendVol(vol, now);
}

function renderVolume(n) {
  const v = vol !== null ? vol : (n.volume === undefined ? 100 : n.volume);
  $('#vol-fill').style.width = v + '%';
  $('#vol-icon').innerHTML = `<use href="#i-vol${v === 0 ? '-off' : ''}"/>`;
  vbar.setAttribute('aria-valuenow', String(v));
  $('#vol').title = 'Volume ' + v;
}

vbar.onpointerdown = e => {
  sliding = true;
  vbar.classList.add('sliding');
  vbar.setPointerCapture(e.pointerId);
  setVol(volAt(e));
};
vbar.onpointermove = e => { if (sliding) setVol(volAt(e)); };
vbar.onpointerup = async e => {
  if (!sliding) return;
  sliding = false;
  vbar.classList.remove('sliding');
  vbar.releasePointerCapture(e.pointerId);
  await setVol(volAt(e), true);   // the one that must land, whatever the throttle
  vol = null;                     // back to whatever the server reports
};
/* Arrows on the slider are its own, or they would seek the song instead. */
vbar.onkeydown = e => {
  const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 5
             : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -5 : 0;
  if (!step) return;
  e.preventDefault();
  e.stopPropagation();
  const now = vol !== null ? vol : (state.now.volume === undefined ? 100
                                    : state.now.volume);
  setVol(now + step, true);
};

/* seek ------------------------------------------------------------------- */
/* The one control that has to get ahead of the truth: a seek is a CLI call
   and /api/state won't agree for a moment, so the bar paints where you asked
   for straight away and `scrub` holds that until the server catches up. A
   drag only sends on release - a seek is cheap now that mpv moves the song
   it is already playing, but a CLI call per pixel is not. */

const bar = $('#t-bar');
let scrub = null, scrubbing = false, asked = 0;

function settled(n) {
  /* Drop the pending position once the server reports one near it, or after
     two seconds, so a seek that never landed can't freeze the bar. */
  if (scrub === null || scrubbing) return;
  if (Math.abs((n.elapsed || 0) - scrub) < 1.5 || Date.now() - asked > 2000)
    scrub = null;
}

function barTime(e) {
  const r = bar.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
         * (state.now.duration || 0);
}

function seekTo(secs) {
  // Held here as well as in `scrub`, because renderPlayer is entitled to drop
  // the pending position while it paints - a new song clears it, and so does
  // one that lands near where the server already says we are. That is the
  // right call about the bar and the wrong one about the command: what was
  // asked for still has to be sent, and reading it back off `scrub` meant a
  // seek onto the playhead, or the first one after a track change, threw and
  // went nowhere.
  const to = Math.max(0, secs);
  scrub = to;
  asked = Date.now();
  renderPlayer();
  run('seek', to.toFixed(1));
}

bar.onpointerdown = e => {
  if (!state.now.playing || !state.now.duration) return;
  scrubbing = true;
  bar.classList.add('scrubbing');
  bar.setPointerCapture(e.pointerId);
  scrub = barTime(e);
  renderPlayer();
};
bar.onpointermove = e => {
  if (!scrubbing) return;
  scrub = barTime(e);
  renderPlayer();
};
bar.onpointerup = e => {
  if (!scrubbing) return;
  scrubbing = false;
  bar.classList.remove('scrubbing');
  seekTo(barTime(e));
};
bar.onpointercancel = () => {           // dropped mid-drag: forget the whole
  scrubbing = false;                    // thing rather than leave it stuck
  scrub = null;
  bar.classList.remove('scrubbing');
  renderPlayer();
};

/* search ----------------------------------------------------------------- */

const q = $('#q');

q.oninput = () => {
  state.query = q.value.trim();
  $('#clear-q').hidden = !state.query;
  renderPlaylists();
  find.typed(state.query);
  render();
};
$('#clear-q').onclick = () => { q.value = ''; q.oninput(); q.focus(); };

/* new playlist ----------------------------------------------------------- */

const dlg = $('#dlg');
$('#new-pl').onclick     = () => { $('#dlg-name').value = ''; dlg.showModal(); $('#dlg-name').focus(); };
$('#dlg-cancel').onclick = () => dlg.close();
$('#dlg-ok').onclick     = async () => {
  const name = $('#dlg-name').value.trim();
  if (!name) return;
  dlg.close();
  const r = await run('create', name);
  if (r.ok) { await loadLibrary(); openPlaylist(r.data?.created || name);
              toast('Created “' + name + '”'); }
};
dlg.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); $('#dlg-ok').click(); } };

/* delete playlist -------------------------------------------------------- */

const del = $('#dlg-del');
let pendingDelete = null;

/* Both deletions share the one dialog: what differs is the wording and what
   happens if you say yes. */
function confirmDelete(title, msg, go) {
  pendingDelete = go;
  $('#del-title').textContent = title;
  $('#del-msg').textContent = msg;
  del.showModal();
}

function askDelete(pl) {
  confirmDelete('Delete playlist?',
    `“${pl.name}” will be deleted. Its ${plural(pl.count, 'song')} stay in your library.`,
    () => optimistic(() => forgetList(pl.file),
                     () => run('delete', pl.file),
                     'Deleted “' + pl.name + '”',
                     lib => !lib.playlists.some(p => p.file === pl.file)));
}

function askDeleteSong(song) {
  const held = state.lib.playlists.filter(p => (p.songs || []).includes(song.file));
  const also = held.length ? ` It leaves ${plural(held.length, 'playlist')} as well.` : '';
  // Nothing to delete when the file is already gone: that one only clears the
  // lists still naming it, so it doesn't carry the warning about being final.
  confirmDelete(song.missing ? 'Remove missing song?' : 'Delete song?',
    song.missing
      ? `“${song.title}” isn't in your music folder. Take it out of `
        + `${held.length ? plural(held.length, 'playlist') : 'your library'}?`
      : `“${song.title}” will be deleted from your library.${also} `
        + `The file goes with it, so this can't be undone.`,
    () => optimistic(() => forgetSong(song.file),
                     () => run('remove', song.file),
                     'Deleted “' + song.title + '”',
                     lib => !lib.songs.some(s => s.file === song.file)));
}

$('#del-cancel').onclick = () => del.close();
$('#del-ok').onclick = () => {
  const go = pendingDelete;
  del.close();
  pendingDelete = null;
  if (go) go();
};

/* keyboard --------------------------------------------------------------- */

document.onkeydown = e => {
  const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
  const modal = dlg.open || del.open;
  if (e.key === 'Escape' && menu) { closeMenu(); return; }
  if (e.key === '/' && !typing) { e.preventDefault(); q.focus(); }
  else if (e.key === 'Escape' && typing) {
    e.target.blur();
    if (e.target === q && q.value) $('#clear-q').click();
  }
  else if (typing || modal) return;
  else if (e.key === ' ') { e.preventDefault(); playPause(); }
  else if (e.key === 'n') nextTrack();
  else if (e.key === 'p') prevTrack();
  else if (e.key === 's') run('shuffle');
  // Up and down are the sidebar's wherever you are standing. They are taken
  // before the page can scroll on them, which is the default they replace.
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    stepSidebar(e.key === 'ArrowDown' ? 1 : -1);
  }
  else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && state.now.playing) {
    e.preventDefault();
    seekTo((state.now.elapsed || 0) + (e.key === 'ArrowRight' ? 5 : -5));
  }
};

/* ------------------------------------------------------------------ start */

$('#settings-btn').onclick = () => openPlaylist(SETTINGS);
$('#stats-btn').onclick    = async () => {
  state.stats = state.statsWhy = null;
  openPlaylist(STATS);
  await loadStats();
  if (state.view === STATS) render();   // ...unless you already left
};

loadLibrary();
poll();
setInterval(poll, 500);
setInterval(loadLibrary, 15000);   // pick up changes made from the terminal
