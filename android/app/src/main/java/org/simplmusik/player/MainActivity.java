package org.simplmusik.player;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The window.
 *
 * <p>There is deliberately almost nothing here. The interface is the same
 * page the desktop shows - the same HTML, the same stylesheet, the same
 * script, served by the same server off the same disk - and this is the frame
 * it is shown in. Every button in the app is drawn by code that does not know
 * it is on a phone, which is the entire point of the exercise: a change to the
 * page is a change to both, because there is only one page.
 */
public class MainActivity extends AppCompatActivity {

    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private boolean loaded;
    private int tries;
    private boolean ready;          // the app's own page is up, script and all
    private String shared;          // shared to us, and not yet handed over
    private ValueCallback<Uri[]> choosing;  // the page's file input, waiting on a pick

    /**
     * Whatever came back from the system's own picker, handed to the page's
     * file input. Nothing picked is an answer too: the input has to be told,
     * or it never opens again.
     */
    private final ActivityResultLauncher<Intent> picker = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(), r -> {
                if (choosing == null) return;
                Uri got = r.getData() == null ? null : r.getData().getData();
                choosing.onReceiveValue(r.getResultCode() == RESULT_OK && got != null
                        ? new Uri[]{got} : null);
                choosing = null;
            });

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        web = new WebView(this);
        web.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // The page is ours and is served from this device. Nothing else may
        // be reached from inside it.
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                String host = u.getHost();
                if ("127.0.0.1".equals(host) || "localhost".equals(host)) return false;
                // A link out of the app opens in the browser, never in here.
                if ("http".equals(u.getScheme()) || "https".equals(u.getScheme())) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, u));
                    } catch (android.content.ActivityNotFoundException e) {
                        // no browser: nothing to hand it to
                    }
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
                ready = false;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                // Only the app's own page has a search box to put a share in.
                // The start-up complaint is a page too, and has nowhere to.
                ready = "127.0.0.1".equals(Uri.parse(url).getHost());
                deliver();
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                // The server is still starting: the first load can beat it.
                if (r.isForMainFrame()) main.postDelayed(MainActivity.this::show, 300);
            }
        });
        // A WebView ignores <input type=file> unless something here answers
        // it - which is why picking cover art did nothing. The page only ever
        // asks for a picture, so Android's own image picker is the answer.
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (choosing != null) choosing.onReceiveValue(null);
                choosing = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("image/*");
                try {
                    picker.launch(i);
                } catch (Exception e) {
                    choosing = null;
                    return false;       // no picker on this phone: the input is told no
                }
                return true;
            }
        });
        setContentView(web);

        ask();
        askForStorage();
        startForegroundService(new Intent(this, PlayerService.class));
        show();
        if (state == null) take(getIntent());
    }

    /**
     * Something shared to the app - a TikTok, from its share sheet.
     *
     * <p>Handed to the page, which puts it in the search box as though it had
     * been pasted there; working out the song is the page's business and the
     * CLI's, not this window's. Held until there is a page to hand it to,
     * because sharing is as likely to start the app as to find it running.
     */
    private void take(Intent i) {
        if (i == null || !Intent.ACTION_SEND.equals(i.getAction())) return;
        // Reopened from Recents, the app is handed the intent that first
        // started it - a share already dealt with, not a new one.
        if ((i.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        CharSequence text = i.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text == null || text.toString().trim().isEmpty()) return;
        shared = text.toString();
        deliver();
    }

    /** Give the page what was shared, once there is a page to give it to. */
    private void deliver() {
        if (!ready || shared == null) return;
        // Quoted as JSON, which is also a JavaScript string: the text is
        // somebody else's and must not be able to become part of the script.
        web.evaluateJavascript(
                "window.shared && window.shared(" + JSONObject.quote(shared) + ")", null);
        shared = null;
    }

    @Override
    protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        setIntent(i);
        take(i);
    }

    /**
     * Show the page as soon as there is one to show.
     *
     * <p>The backend is started on a thread and takes a moment - the
     * interpreter, then the library. Rather than a splash screen that has to
     * be dismissed, this simply asks again until the port is there.
     */
    private void show() {
        if (loaded) return;
        int port = PlayerService.port;
        if (port > 0) {
            loaded = true;
            web.loadUrl(Boot.url(port));
            return;
        }
        String failed = PlayerService.failure;
        if (failed != null) {
            loaded = true;
            complain(failed);
            return;
        }
        if (++tries * 150 > 40000) {        // forty seconds is not "starting"
            loaded = true;
            complain("The backend did not start, and did not say why.\n\n"
                    + "Nothing was written to " + PlayerService.class.getName()
                    + ".failure, so it is still running or it stopped without "
                    + "throwing.");
            return;
        }
        main.postDelayed(this::show, 150);
    }

    /**
     * Put a start-up failure on the screen.
     *
     * <p>Rendered rather than logged, because the person who needs it is
     * holding the phone and has no logcat. Written into the page as text, with
     * the markup characters taken out of it first: a stack trace is somebody
     * else's text and must not be able to become part of this page.
     */
    private void complain(String detail) {
        String safe = detail.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
        String html = "<!doctype html><meta name=viewport "
                + "content='width=device-width,initial-scale=1'>"
                + "<style>:root{color-scheme:light dark}"
                + "body{font:13px ui-monospace,monospace;margin:0;padding:18px;"
                + "background:#faf9f7;color:#16161a}"
                + "@media(prefers-color-scheme:dark){body{background:#16161a;color:#e8e6e3}}"
                + "h1{font:600 16px system-ui;margin:0 0 12px}"
                + "pre{white-space:pre-wrap;word-break:break-word;margin:0;opacity:.85}"
                + "</style><h1>simplmusik didn't start</h1><pre>" + safe + "</pre>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    /**
     * All-files access, which is a trip to Settings rather than a dialog.
     *
     * <p>Asked for the first time the app is opened without it, and not
     * pestered for afterwards: the app still reads the library without it,
     * and a person who said no once should be able to look around before
     * being asked again. What does not work without it is writing - playlists
     * and downloads - and the page says so when one is tried.
     */
    private void askForStorage() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return;
        if (Environment.isExternalStorageManager()) return;
        try {
            Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Exception e) {
            // Some builds have no such screen. The generic list is better
            // than nothing, and nothing is better than a crash.
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
            } catch (Exception ignored) {
            }
        }
    }

    /** The permissions the app is useless without, asked for once. */
    private void ask() {
        List<String> want = new ArrayList<>();
        String audio = Build.VERSION.SDK_INT >= 33
                ? Manifest.permission.READ_MEDIA_AUDIO
                : Manifest.permission.READ_EXTERNAL_STORAGE;
        if (ContextCompat.checkSelfPermission(this, audio) != PackageManager.PERMISSION_GRANTED)
            want.add(audio);
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED)
            want.add(Manifest.permission.POST_NOTIFICATIONS);
        if (!want.isEmpty())
            ActivityCompat.requestPermissions(this, want.toArray(new String[0]), 1);
    }

    @Override
    public void onRequestPermissionsResult(int code, @NonNull String[] perms,
                                           @NonNull int[] granted) {
        super.onRequestPermissionsResult(code, perms, granted);
        // The library is walked when the page asks, so a permission granted
        // after the page loaded needs the page to ask again.
        if (loaded) web.reload();
    }

    @Override
    public void onBackPressed() {
        // Back inside the page is the page's business - it has its own idea of
        // where it was. Only when it has nowhere to go back to does this leave.
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        // The service keeps playing; the window is only a viewer.
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
