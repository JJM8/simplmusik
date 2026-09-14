package org.simplmusik.player;

import android.content.Context;
import android.content.res.AssetManager;
import android.os.Environment;
import android.util.Log;

import com.chaquo.python.PyObject;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Getting the app that already exists onto the phone, and running it.
 *
 * <p>The CLI and the backend are not rewritten here and not imported as
 * modules either - they are laid out on the disk exactly as they sit in the
 * repository and read from there. That is deliberate: the CLI is called
 * {@code simplmusik} with no {@code .py} on the end, {@code server.py} finds
 * it by path, and the page is served off the disk beside them. Reproducing
 * that layout is what lets all of that go on being true unchanged.
 *
 * <p>Everything is extracted again whenever the installed package changes,
 * and not otherwise, so an upgrade cannot leave last version's page being
 * served by this version's server. What counts as a change is the moment the
 * package was last installed, not its version number: two builds of the same
 * version are the normal case while working on it, and keying this on the
 * version meant a reinstall quietly kept running the code it replaced.
 */
final class Boot {
    private static final String TAG = "simplmusik";
    private static final String[] TOP = {"simplmusik", "server.py"};

    private static Python python;
    private static int port = -1;

    private Boot() {}

    /** Where the app is laid out - the equivalent of a checkout on a desktop. */
    static File appDir(Context c) { return new File(c.getFilesDir(), "app"); }

    /** Where {@code ~} points once the CLI is running: config, state, cache. */
    static File homeDir(Context c) { return new File(c.getFilesDir(), "home"); }

    /**
     * The music folder: the first place on this phone we can actually write.
     *
     * <p>Shared storage first, and made if it is not there, because that is
     * the Music folder everything else on the phone means by it - songs put
     * there over USB or by another app are simply in your library, and songs
     * put there by this app outlive it being uninstalled.
     *
     * <p>But it is only writable with all-files access, which is granted in
     * Settings and may not have been granted yet, or at all. A library you
     * cannot write to is one you cannot download into, so rather than insist,
     * this falls back: the app's own folder on the shared card, which needs no
     * permission at all, and then internal storage, which cannot fail. Asked
     * again at every start-up, so granting the permission later moves it back
     * to the shared folder by itself.
     *
     * <p>Writability is tested by writing. Android has too many ways for a
     * directory to exist and refuse anyway - a permission not granted, a
     * volume mounted read-only, storage that is simply full - and asking is
     * one line where guessing is a list of cases that is never quite finished.
     */
    static File musicDir(Context c) {
        File shared = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC);
        if (writable(shared)) return shared;

        File own = c.getExternalFilesDir(Environment.DIRECTORY_MUSIC);
        if (writable(own)) {
            Log.i(TAG, "no shared Music folder to write to; using " + own);
            return own;
        }
        File last = new File(c.getFilesDir(), "Music");
        last.mkdirs();
        Log.i(TAG, "falling back to internal storage: " + last);
        return last;
    }

    /** Whether this is a folder we can put a song in - asked by trying it. */
    private static boolean writable(File d) {
        if (d == null) return false;
        if (!d.isDirectory() && !d.mkdirs()) return false;
        File probe = new File(d, ".simplmusik-write-test");
        try {
            if (probe.exists() && !probe.delete()) return false;
            if (!probe.createNewFile()) return false;
            return true;
        } catch (IOException | SecurityException e) {
            return false;
        } finally {
            probe.delete();
        }
    }

    /** Lay the app out, unless this install already did. */
    static synchronized void extract(Context c) throws IOException {
        File dir = appDir(c);
        File stamp = new File(dir, ".version");
        String want = version(c);
        if (dir.isDirectory() && want.equals(read(stamp))) return;

        // Cleared rather than written over. A file that this version no longer
        // ships would otherwise stay behind for good, and the one place that
        // would show up is somewhere confusing much later.
        if (dir.exists()) wipe(dir);
        AssetManager assets = c.getAssets();
        for (String name : TOP) copyAsset(assets, name, new File(dir, name));
        copyTree(assets, "web", new File(dir, "web"));
        // The CLI is run as a program on a desktop and imported by path here,
        // so this is not strictly needed - but a file that says it is a program
        // being one costs nothing and stops a surprise later.
        new File(dir, "simplmusik").setExecutable(true, false);
        write(stamp, want);
        Log.i(TAG, "laid out " + want + " in " + dir);
    }

    /**
     * Start the backend, and answer the port it is serving on.
     *
     * <p>Idempotent: the interpreter is started once for the life of the
     * process, and so is the server. A second call - the activity coming back
     * after the service already started things - is told the same port.
     */
    static synchronized int start(Context c) throws IOException {
        if (port > 0) return port;
        extract(c);
        if (python == null) {
            if (!Python.isStarted()) Python.start(new AndroidPlatform(c));
            python = Python.getInstance();
        }
        File music = musicDir(c);
        PyObject boot = python.getModule("android_boot");
        port = boot.callAttr("start",
                appDir(c).getAbsolutePath(),
                homeDir(c).getAbsolutePath(),
                music.getAbsolutePath()).toInt();
        Log.i(TAG, "backend on 127.0.0.1:" + port);
        return port;
    }

    static String url(int port) { return "http://127.0.0.1:" + port + "/"; }

    // ------------------------------------------------------------- the disk

    /**
     * What this install is, closely enough that a change to it means a change
     * to the files inside it.
     *
     * <p>`lastUpdateTime` is the load-bearing part. Version name and code stay
     * put across a rebuild - they are the same release, being worked on - so a
     * reinstall would look identical to what was already unpacked and the new
     * assets would never be laid down. The install time moves every time.
     */
    private static String version(Context c) {
        try {
            android.content.pm.PackageInfo p =
                    c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return p.versionName + "/" + p.versionCode + "/" + p.lastUpdateTime;
        } catch (Exception e) {
            return "unknown/" + System.currentTimeMillis();   // extract every time
        }
    }

    /** Take a folder and everything under it away. */
    private static void wipe(File f) {
        File[] kids = f.listFiles();
        if (kids != null) for (File kid : kids) wipe(kid);
        // A file that will not go is left; the copy over the top is still the
        // right thing to attempt, and it is what will report the real trouble.
        f.delete();
    }

    private static void copyTree(AssetManager assets, String path, File to) throws IOException {
        String[] kids = assets.list(path);
        if (kids == null || kids.length == 0) {     // a file, not a folder
            copyAsset(assets, path, to);
            return;
        }
        if (!to.isDirectory() && !to.mkdirs()) throw new IOException("cannot make " + to);
        for (String kid : kids) copyTree(assets, path + "/" + kid, new File(to, kid));
    }

    private static void copyAsset(AssetManager assets, String name, File to) throws IOException {
        File parent = to.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs())
            throw new IOException("cannot make " + parent);
        byte[] buf = new byte[65536];
        try (InputStream in = assets.open(name); OutputStream out = new FileOutputStream(to)) {
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        }
    }

    private static String read(File f) {
        try (InputStream in = new java.io.FileInputStream(f)) {
            return new String(in.readAllBytes(), "UTF-8").trim();
        } catch (IOException e) {
            return null;
        }
    }

    private static void write(File f, String s) throws IOException {
        try (OutputStream out = new FileOutputStream(f)) { out.write(s.getBytes("UTF-8")); }
    }
}
