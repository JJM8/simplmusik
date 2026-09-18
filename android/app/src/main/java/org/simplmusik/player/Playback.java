package org.simplmusik.player;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;
import androidx.media3.session.MediaSession;

import com.chaquo.python.PyObject;

/**
 * What plays the songs, standing exactly where mpv stands on a desktop.
 *
 * <p>Public, all of it, and that is load-bearing rather than tidiness:
 * Python reaches Java through reflection, and reflection is shown only what
 * is public. Package-private is the natural spelling for a class only its own
 * package uses, and it is what made the first build of this start up to a
 * blank screen - the bridge could not see a single method here.
 *
 * <p>The player loop in the CLI was not changed for this. It hands a song, a
 * gain and a volume to something and then waits to be told how the song
 * ended - "eof" if it played out, "stop" if it was cut short - and those two
 * words are the whole of the vocabulary. So this reports them, in the same
 * shape mpv pushes down its socket, and the loop cannot tell the difference.
 *
 * <p>Everything here happens on the main thread, because that is where a
 * {@link Player} may be touched, and every call in is from Python on some
 * other one. The reporting goes the other way through a Python callback, and
 * that callback does nothing but write a line into a socket - so the audio
 * thread is never waiting on an interpreter.
 */
public final class Playback {

    private static final String TAG = "simplmusik";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final GainProcessor gain = new GainProcessor();
    private final ExoPlayer player;
    private PyObject onEvent;               // told how each song ended
    private volatile PyObject onControl;    // told what a button outside asked for

    // What the notification, the lock screen and a headset talk to. They are
    // shown `front` rather than the player itself, and that is the point of it:
    // see `Front`.
    private final MediaSession session;
    private volatile Bitmap art;

    // Buttons are handed to Python off the main thread. The CLI answers them
    // over a socket, which is no business of the thread the player lives on.
    private final java.util.concurrent.ExecutorService buttons =
            java.util.concurrent.Executors.newSingleThreadExecutor();

    /** True between a song being asked for and that song being accounted for. */
    private boolean live;

    // Where we are in the song, published by the thread that owns the player
    // rather than fetched by the thread that wants it.
    //
    // A player may only be asked from the thread it was made on, so reading
    // the position from Python used to mean posting to that thread and waiting
    // for the answer - twice a second, from a socket the page is holding open,
    // with a timeout for when the answer did not come back in time. It never
    // came back in time, and a progress bar that read zero for the whole song
    // was the result. So the traffic is reversed: the main thread writes these
    // as it goes, and anyone may read them whenever they like.
    private volatile long posMs;
    private volatile long durMs;
    private volatile boolean isPaused = true;

    /** Keeps the two numbers above true while there is a song to be in. */
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            posMs = Math.max(0, player.getCurrentPosition());
            long d = player.getDuration();
            durMs = d == C.TIME_UNSET ? 0 : d;
            isPaused = !player.getPlayWhenReady();
            // Four times a second: enough for a bar that moves smoothly, and
            // little enough to be nothing on a battery.
            main.postDelayed(this, 250);
        }
    };

    public Playback(Context context) {
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(context) {
            @Override
            protected AudioSink buildAudioSink(Context c, boolean enableFloatOutput,
                                               boolean enableAudioTrackPlaybackParams) {
                return new DefaultAudioSink.Builder(c)
                        .setAudioProcessors(new AudioProcessor[]{gain})
                        .build();
            }
        };
        player = new ExoPlayer.Builder(context, renderers).build();
        player.setAudioAttributes(
                new AudioAttributes.Builder()
                        .setUsage(C.USAGE_MEDIA)
                        .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                        .build(),
                /* handleAudioFocus= */ true);
        // A song ending is the loop's business, not this player's: it is given
        // one song at a time and told what comes next, the same way mpv is.
        player.setRepeatMode(Player.REPEAT_MODE_OFF);
        main.post(tick);
        session = new MediaSession.Builder(context, new Front(player))
                .setId("simplmusik")
                .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                Log.i(TAG, "player state=" + state
                        + " (1 idle, 2 buffering, 3 ready, 4 ended)"
                        + " playWhenReady=" + player.getPlayWhenReady()
                        + " pos=" + player.getCurrentPosition()
                        + " dur=" + player.getDuration());
                if (state == Player.STATE_ENDED) ended("eof");
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                Log.i(TAG, "isPlaying=" + isPlaying);
            }

            @Override
            public void onPlayerError(PlaybackException e) {
                Log.e(TAG, "player error", e);
                // A song that will not play is a song that has ended, as far
                // as the loop is concerned - it moves on either way, and the
                // log is what wanted to know the difference.
                ended("error");
            }
        });
    }

    /** Where the "how did it end" answers are sent. */
    public void listen(PyObject cb) { onEvent = cb; }

    /**
     * Where the buttons outside the window are sent: "play", "pause", "skip",
     * "back", or "seek" with a position in seconds.
     */
    public void controls(PyObject cb) { onControl = cb; }

    /** A button with no position to it, pressed somewhere Java can see. */
    public void press(String op) { control(op, 0); }

    private void control(String op, double value) {
        buttons.execute(() -> {
            PyObject cb = onControl;
            if (cb == null) return;
            try {
                cb.call(op, value);
            } catch (Throwable t) {
                Log.w(TAG, "the " + op + " button went nowhere", t);
            }
        });
    }

    /**
     * The player as everything outside the window sees it.
     *
     * <p>The queue is the CLI's, and so is whether we are paused - the page
     * reads both from there. A pause button that paused this player directly
     * would leave the page showing a song as playing that isn't, and there is
     * no "next" here at all: this player only ever holds the one song. So the
     * buttons are passed on to the CLI, exactly as if they had been pressed in
     * the window, and what the player then does comes back through `load`,
     * `pause` and `seek` like any other order.
     */
    private final class Front extends ForwardingPlayer {
        Front(Player p) { super(p); }

        @Override
        public Commands getAvailableCommands() {
            return super.getAvailableCommands().buildUpon()
                    .addAll(COMMAND_PLAY_PAUSE,
                            COMMAND_SEEK_TO_NEXT, COMMAND_SEEK_TO_NEXT_MEDIA_ITEM,
                            COMMAND_SEEK_TO_PREVIOUS, COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM,
                            COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
                    .removeAll(COMMAND_SEEK_BACK, COMMAND_SEEK_FORWARD)
                    .build();
        }

        @Override
        public boolean isCommandAvailable(int command) {
            return getAvailableCommands().contains(command);
        }

        @Override public boolean hasNextMediaItem() { return true; }
        @Override public boolean hasPreviousMediaItem() { return true; }

        @Override public void play() { control("play", 0); }
        @Override public void pause() { control("pause", 0); }
        @Override public void setPlayWhenReady(boolean play) { control(play ? "play" : "pause", 0); }
        @Override public void stop() { control("pause", 0); }
        @Override public void seekToNext() { control("skip", 0); }
        @Override public void seekToNextMediaItem() { control("skip", 0); }
        @Override public void seekToPrevious() { control("back", 0); }
        @Override public void seekToPreviousMediaItem() { control("back", 0); }
        @Override public void seekTo(long ms) { control("seek", ms / 1000.0); }
        @Override public void seekTo(int index, long ms) { control("seek", ms / 1000.0); }
    }

    /** The session, for the notification to be built around. */
    public MediaSession session() { return session; }

    /** The song's cover, sized for a notification, or null. */
    public Bitmap artwork() { return art; }

    /** Hear about the song or its state changing, on the main thread. */
    public void watch(Player.Listener l) { main.post(() -> player.addListener(l)); }

    /**
     * Say what the song `source` is: its tags and its cover, any of them null.
     *
     * <p>Told after the song has started rather than with it, because reading
     * a cover off the disk is not something a song should wait to begin for.
     * If another song has started in the meantime, this one's description is
     * dropped rather than put on the wrong song.
     */
    public void describe(String source, String title, String artist, String album, byte[] cover) {
        Bitmap bmp = cover == null ? null : shrink(cover, 720);
        byte[] small = null;
        if (bmp != null) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 90, out);
            small = out.toByteArray();
        }
        final byte[] artData = small;
        main.post(() -> {
            MediaItem item = player.getCurrentMediaItem();
            if (item == null || item.localConfiguration == null
                    || !item.localConfiguration.uri.equals(uri(source))) {
                return;
            }
            MediaMetadata.Builder md = new MediaMetadata.Builder()
                    .setTitle(title)
                    .setArtist(artist)
                    .setAlbumTitle(album);
            if (artData != null) {
                md.setArtworkData(artData, MediaMetadata.PICTURE_TYPE_FRONT_COVER);
            }
            art = bmp;
            // The same address, so the player carries on with the song it
            // has rather than starting it again.
            player.replaceMediaItem(player.getCurrentMediaItemIndex(),
                    item.buildUpon().setMediaMetadata(md.build()).build());
        });
    }

    /** A cover no bigger than `edge` on its long side, or null if it isn't a picture. */
    private static Bitmap shrink(byte[] data, int edge) {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(data, 0, data.length, o);
        if (o.outWidth <= 0 || o.outHeight <= 0) return null;
        int sample = 1;
        while (Math.max(o.outWidth, o.outHeight) / (sample * 2) >= edge) sample *= 2;
        o = new BitmapFactory.Options();
        o.inSampleSize = sample;
        Bitmap b = BitmapFactory.decodeByteArray(data, 0, data.length, o);
        if (b == null) return null;
        int big = Math.max(b.getWidth(), b.getHeight());
        if (big <= edge) return b;
        float k = (float) edge / big;
        return Bitmap.createScaledBitmap(b, Math.round(b.getWidth() * k),
                Math.round(b.getHeight() * k), true);
    }

    private void ended(String reason) {
        if (!live) return;              // already accounted for
        live = false;
        PyObject cb = onEvent;
        if (cb != null) cb.call(reason);
    }

    // --------------------------------------------------- called from Python

    /** Start a song: a path or a URL, a gain in dB, a volume 0-100. */
    public void load(String source, double db, int volume, double startSeconds) {
        Log.i(TAG, "load " + source + " gain=" + db + "dB vol=" + volume
                + " from=" + startSeconds);
        main.post(() -> {
            live = true;
            posMs = durMs = 0;      // the last song's numbers are not this one's
            art = null;             // nor its cover
            gain.setGainDb(db);
            player.setVolume(cubic(volume));
            // The file's name, until `describe` says better - which for a song
            // in your folder is usually a fraction of a second later.
            MediaMetadata named = new MediaMetadata.Builder()
                    .setTitle(source.contains("://") ? null
                            : new java.io.File(source).getName().replaceFirst("\\.[^.]+$", ""))
                    .build();
            player.setMediaItem(new MediaItem.Builder()
                    .setUri(uri(source))
                    .setMediaMetadata(named)
                    .build());
            player.prepare();
            if (startSeconds > 0) player.seekTo((long) (startSeconds * 1000));
            player.setPlayWhenReady(true);
        });
    }

    public void pause(boolean paused) { main.post(() -> player.setPlayWhenReady(!paused)); }

    public void volume(int v) { main.post(() -> player.setVolume(cubic(v))); }

    public void gainDb(double db) { main.post(() -> gain.setGainDb(db)); }

    public void seek(double seconds) { main.post(() -> player.seekTo((long) (seconds * 1000))); }

    /**
     * A song's mean square and peak in dBFS, for the CLI to work its gain out
     * from - or null if it can't be decoded. Decodes the whole file, so it
     * runs on the caller's thread, which is the CLI's background measuring and
     * never the player's.
     */
    public double[] measure(String path) {
        try {
            return Decoder.levels(path);
        } catch (Exception e) {
            Log.w(TAG, "could not measure " + path, e);
            return null;
        }
    }

    /**
     * Take the song away, and say that it went.
     *
     * <p>Saying so is the whole of it. mpv answers a `stop` with an end-file
     * whose reason is "stop", and the player loop is sitting waiting for
     * exactly that - it is how a skip becomes the next song, and how a stop
     * gets written down as a song you cut short rather than one you heard out.
     * Taking the song away silently leaves that loop waiting for a song that
     * has already gone, which is a skip button that does nothing at all.
     */
    public void stop() {
        main.post(() -> {
            posMs = durMs = 0;
            player.stop();
            player.clearMediaItems();
            ended("stop");
        });
    }

    public void release() {
        main.post(() -> {
            session.release();
            player.release();
        });
    }

    /** Where we are in the song, in seconds. Asked for constantly; free. */
    public double position() { return posMs / 1000.0; }

    /** How long the song is, or 0 while that is still unknown. */
    public double duration() { return durMs / 1000.0; }

    public boolean paused() { return isPaused; }

    // ------------------------------------------------------------- plumbing

    /**
     * mpv's volume scale is cubic - 50 is a quarter of the way up, not half -
     * and the CLI's numbers, the settings it stores and everything a person
     * has got used to are on that scale. So it is kept, rather than quietly
     * becoming linear because this player's fader happens to be.
     */
    private static float cubic(int v) {
        double x = Math.max(0, Math.min(100, v)) / 100.0;
        return (float) (x * x * x);
    }

    private static Uri uri(String source) {
        return source.contains("://") ? Uri.parse(source) : Uri.fromFile(new java.io.File(source));
    }

}
