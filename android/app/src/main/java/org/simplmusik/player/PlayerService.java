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
        startForeground(NOTE, note(getString(R.string.starting)));
        new Thread(() -> {
            try {
                port = Boot.start(this);
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
        // Restarted after being killed, the app comes back to a library and a
        // stopped player, which is the honest state: what was playing was in
        // the process that went away.
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    /** Update what the notification says is playing. */
    static void showing(Context c, String text) {
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm != null) nm.notify(NOTE, note(c, text));
    }

    private Notification note(String text) { return note(this, text); }

    private static Notification note(Context c, String text) {
        Intent open = new Intent(c, MainActivity.class);
        PendingIntent tap = PendingIntent.getActivity(
                c, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new NotificationCompat.Builder(c, CHANNEL)
                .setContentTitle(c.getString(R.string.app_name))
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(tap)
                .setOngoing(true)
                .setSilent(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
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
