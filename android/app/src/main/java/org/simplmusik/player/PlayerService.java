package org.simplmusik.player;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaStyleNotificationHelper;

/**
 * What keeps the music going when the window is not on screen.
 *
 * <p>This is the one piece with no counterpart on a desktop, and it exists
 * because Android will stop a process that has nothing visible. It holds the
 * interpreter, the backend and the player; the window is a viewer that comes
 * and goes in front of it. Which is very close to what already happens on a
 * desktop, where the player outlives the window on purpose - so the shape is
 * familiar even though the reason for it is the platform's.
 */
public class PlayerService extends Service {

    private static final String TAG = "simplmusik";
    private static final String CHANNEL = "playing";
    private static final int NOTE = 1;

    /** The port the page is served on, once there is one. 0 until then. */
    public static volatile int port = 0;

    /**
     * Why there is no port, if there isn't going to be one.
     *
     * <p>A start-up that fails used to do it in silence: the window waited for
     * a port that was never coming and showed its own background for as long
     * as anyone cared to look at it. The error existed only in logcat, which
     * is no use to somebody holding a phone. So it is kept here and the window
     * puts it on the screen.
     */
    public static volatile String failure = null;

    private static volatile Playback playback;

    /**
     * The player the CLI drives. Made on demand, and only ever one.
     *
     * <p>Public because Python calls it, and built on the main thread because
     * the player it builds may only be touched from one thread and that is the
     * thread it will be touched from ever after. The call comes in on the
     * start-up thread, so this waits for the main one rather than building it
     * where it stands.
     */
    public static Playback playback(Context c) {
        final Context app = c.getApplicationContext();
        synchronized (PlayerService.class) {
            if (playback != null) return playback;
        }
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return make(app);
        }
        final java.util.concurrent.CountDownLatch done = new java.util.concurrent.CountDownLatch(1);
        new Handler(Looper.getMainLooper()).post(() -> {
            try { make(app); } finally { done.countDown(); }
        });
        try {
            done.await(10, java.util.concurrent.TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        synchronized (PlayerService.class) {
            if (playback == null) throw new IllegalStateException("the player would not start");
            return playback;
        }
    }

    private static synchronized Playback make(Context app) {
        if (playback == null) playback = new Playback(app);
        return playback;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        channel();
        // Made here, before the backend asks for it, so there is a session for
        // the notification to be about from the very first one. This is the
        // main thread, which is where the player was always going to be made.
        Playback p = playback(this);
        p.session().setSessionActivity(tap(this));
        p.watch(new Player.Listener() {
            @Override
            public void onEvents(Player player, Player.Events events) {
                if (events.containsAny(Player.EVENT_PLAY_WHEN_READY_CHANGED,
                        Player.EVENT_MEDIA_METADATA_CHANGED,
                        Player.EVENT_MEDIA_ITEM_TRANSITION,
                        Player.EVENT_PLAYBACK_STATE_CHANGED)) {
                    refresh(PlayerService.this);
                }
            }
        });
        startForeground(NOTE, note(this));
        new Thread(() -> {
            try {
                port = Boot.start(this);
                new Handler(Looper.getMainLooper()).post(() -> refresh(this));
            } catch (Throwable t) {
                Log.e(TAG, "the backend would not start", t);
                java.io.StringWriter w = new java.io.StringWriter();
                t.printStackTrace(new java.io.PrintWriter(w));
                failure = w.toString();
            }
        }, "simplmusik-boot").start();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // A button on the notification, on the Androids that draw them from
        // the notification rather than from the session.
        String op = intent == null ? null : intent.getAction();
        if (op != null && playback != null) playback.press(op);
        // Restarted after being killed, the app comes back to a library and a
        // stopped player, which is the honest state: what was playing was in
        // the process that went away.
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    /** Put the notification back in step with the player. Main thread only. */
    static void refresh(Context c) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTE, note(c));
    }

    private static PendingIntent tap(Context c) {
        Intent open = new Intent(c, MainActivity.class);
        return PendingIntent.getActivity(
                c, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static NotificationCompat.Action button(Context c, int icon, String label, String op) {
        Intent i = new Intent(c, PlayerService.class).setAction(op);
        PendingIntent pi = PendingIntent.getService(c, op.hashCode(), i,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Action(icon, label, pi);
    }

    /**
     * The notification, drawn around the media session.
     *
     * <p>From Android 13 the system draws a media notification itself, out of
     * the session - title, artist, cover, a progress bar and the buttons -
     * and what is set here is mostly ignored. Before 13 this is what shows,
     * so it says the same things by hand.
     */
    private static Notification note(Context c) {
        Playback p = playback;
        MediaSession session = p == null ? null : p.session();
        Player player = session == null ? null : session.getPlayer();
        boolean loaded = player != null && player.getCurrentMediaItem() != null;

        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(tap(c))
                .setShowWhen(false)
                .setOngoing(true)
                .setSilent(true)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
                .setPriority(NotificationCompat.PRIORITY_LOW);

        if (!loaded) {
            b.setContentTitle(c.getString(R.string.app_name))
             .setContentText(c.getString(port == 0 ? R.string.starting : R.string.nothing_playing));
        } else {
            MediaMetadata md = player.getMediaMetadata();
            boolean playing = player.getPlayWhenReady();
            b.setContentTitle(md.title != null ? md.title : c.getString(R.string.app_name))
             .setContentText(md.artist)
             .setSubText(md.albumTitle)
             .setLargeIcon(p.artwork())
             .addAction(button(c, android.R.drawable.ic_media_previous, "Previous", "back"))
             .addAction(playing
                     ? button(c, android.R.drawable.ic_media_pause, "Pause", "pause")
                     : button(c, android.R.drawable.ic_media_play, "Play", "play"))
             .addAction(button(c, android.R.drawable.ic_media_next, "Next", "skip"));
        }
        if (session != null) {
            MediaStyleNotificationHelper.MediaStyle style =
                    new MediaStyleNotificationHelper.MediaStyle(session);
            if (loaded) style.setShowActionsInCompactView(0, 1, 2);
            b.setStyle(style);
        }
        return b.build();
    }

    private void channel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL, getString(R.string.channel_name), NotificationManager.IMPORTANCE_LOW);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }
}
