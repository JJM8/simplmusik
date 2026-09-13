package org.simplmusik.player;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;

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
            gain.setGainDb(db);
            player.setVolume(cubic(volume));
            player.setMediaItem(MediaItem.fromUri(uri(source)));
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

    public void release() { main.post(player::release); }

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
