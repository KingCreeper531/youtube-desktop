package io.github.kingcreeper531.ranchweb;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Checks GitHub Releases for a newer APK. Nothing downloads until the user taps
 * the green Update button; Android then shows its own install confirmation.
 */
final class Updater {
    private static final long CHECK_EVERY_MS = 30L * 60 * 1000;        // every 30 minutes
    private static final long RESUME_CHECK_GAP_MS = 10L * 60 * 1000;   // and when you reopen the app
    private volatile long lastCheck;

    private final Activity activity;
    private final Runnable onChange;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    private volatile String status = "idle";   // idle, checking, latest, available, downloading, ready, error
    private volatile String version;
    private volatile String apkUrl;
    private volatile String error;
    private volatile int percent;
    private File apk;
    private boolean waitingForPermission;

    private final Runnable periodic = new Runnable() {
        @Override public void run() {
            check();
            main.postDelayed(this, CHECK_EVERY_MS);
        }
    };

    Updater(Activity activity, Runnable onChange) {
        this.activity = activity;
        this.onChange = onChange;
    }

    void start() {
        main.postDelayed(periodic, 5000);
    }

    void stop() {
        main.removeCallbacks(periodic);
        io.shutdownNow();
    }

    private void set(String newStatus) {
        status = newStatus;
        onChange.run();
    }

    void check() {
        if ("downloading".equals(status) || "ready".equals(status) || "available".equals(status)) return;
        lastCheck = System.currentTimeMillis();
        io.execute(() -> {
            set("checking");
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(
                        "https://api.github.com/repos/" + BuildConfig.GITHUB_REPO + "/releases/latest").openConnection();
                c.setRequestProperty("Accept", "application/vnd.github+json");
                c.setRequestProperty("User-Agent", "Ranch-" + BuildConfig.SITE_NAME + "-Android");
                c.setConnectTimeout(10000);
                c.setReadTimeout(10000);
                if (c.getResponseCode() != 200) throw new Exception("GitHub returned " + c.getResponseCode());
                JSONObject release = new JSONObject(MainActivity.read(c.getInputStream()));
                c.disconnect();

                String tag = release.optString("tag_name").replaceFirst("^v", "");
                String url = null;
                JSONArray assets = release.optJSONArray("assets");
                for (int i = 0; assets != null && i < assets.length(); i++) {
                    JSONObject a = assets.getJSONObject(i);
                    if (a.optString("name").toLowerCase().endsWith(".apk")) {
                        url = a.optString("browser_download_url");
                        break;
                    }
                }
                if (url != null && isNewer(tag, BuildConfig.VERSION_NAME)) {
                    version = tag;
                    apkUrl = url;
                    set("available");
                } else {
                    set("latest");
                }
            } catch (Exception e) {
                // A failed check isn't worth a button; just try again later.
                set(version != null ? "available" : "idle");
            }
        });
    }

    void install() {
        if ("ready".equals(status)) {
            installApk();
            return;
        }
        if (!"available".equals(status) && !("error".equals(status) && apkUrl != null)) return;
        percent = 0;
        set("downloading");
        io.execute(this::download);
    }

    private void download() {
        try {
            File dir = new File(activity.getCacheDir(), "updates");
            dir.mkdirs();
            File out = new File(dir, BuildConfig.SITE_NAME + "-" + version + ".apk");
            HttpURLConnection c = (HttpURLConnection) new URL(apkUrl).openConnection();
            c.setInstanceFollowRedirects(true);
            c.setRequestProperty("User-Agent", "Ranch-" + BuildConfig.SITE_NAME + "-Android");
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            if (c.getResponseCode() != 200) throw new Exception("Download failed (" + c.getResponseCode() + ")");
            long total = c.getContentLengthLong();
            try (InputStream in = c.getInputStream(); FileOutputStream fos = new FileOutputStream(out)) {
                byte[] buf = new byte[64 * 1024];
                long done = 0;
                int n;
                int lastPercent = -1;
                while ((n = in.read(buf)) > 0) {
                    fos.write(buf, 0, n);
                    done += n;
                    if (total > 0) {
                        percent = (int) (done * 100 / total);
                        if (percent != lastPercent) {
                            lastPercent = percent;
                            onChange.run();
                        }
                    }
                }
            }
            c.disconnect();
            apk = out;
            set("ready");
            main.post(this::installApk);
        } catch (Exception e) {
            error = e.getMessage();
            set("error");
        }
    }

    private void installApk() {
        if (apk == null || !apk.exists()) {
            set("available");
            return;
        }
        // Android requires the user to allow this app to install updates (once).
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            waitingForPermission = true;
            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName())));
            return;
        }
        Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".files", apk);
        Intent i = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.startActivity(i);
    }

    /** Called from the activity's onResume, e.g. after granting the install permission. */
    void onResume() {
        if (lastCheck > 0 && System.currentTimeMillis() - lastCheck > RESUME_CHECK_GAP_MS) check();
        if (waitingForPermission && activity.getPackageManager().canRequestPackageInstalls()) {
            waitingForPermission = false;
            installApk();
        }
    }

    String stateJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("status", status);
            o.put("current", BuildConfig.VERSION_NAME);
            if (version != null) o.put("version", version);
            o.put("percent", percent);
            if (error != null) o.put("error", error);
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    static boolean isNewer(String a, String b) {
        String[] x = a.split("\\.");
        String[] y = b.split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length ? parse(x[i]) : 0;
            int q = i < y.length ? parse(y[i]) : 0;
            if (p != q) return p > q;
        }
        return false;
    }

    private static int parse(String s) {
        try { return Integer.parseInt(s.replaceAll("\\D.*", "")); } catch (Exception e) { return 0; }
    }
}
