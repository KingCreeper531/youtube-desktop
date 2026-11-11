package io.github.kingcreeper531.ranchweb;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Ranch web app for Android: the site in a WebView with the same page script as the
 * iPhone app (assets/inject.js), which talks to us through window.webkit.messageHandlers,
 * just like on iPhone. What's specific to the site comes from BuildConfig (app/build.gradle).
 */
public class MainActivity extends Activity {
    private static final int REQ_FILES = 7;
    private static final String[] SIGN_IN_HOSTS = {"accounts.google.com", "appleid.apple.com"};

    private BackgroundWebView web;
    private FrameLayout root;
    private Updater updater;
    private String pageScript;
    private boolean documentStartScript;
    private Set<String> hosts;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;
    private ValueCallback<Uri[]> fileCallback;
    private final ExecutorService io = Executors.newCachedThreadPool();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        hosts = new HashSet<>();
        for (String h : BuildConfig.SITE_HOSTS.split(",")) hosts.add(h.trim());

        int bg = Color.parseColor(BuildConfig.SITE_BACKGROUND);
        root = new FrameLayout(this);
        root.setBackgroundColor(bg);
        web = new BackgroundWebView(this);
        web.setBackgroundColor(bg);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(cleanUserAgent(s.getUserAgentString()));
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);
        // Don't announce "this is an app's WebView" to the site or Google sign-in
        if (WebViewFeature.isFeatureSupported(WebViewFeature.REQUESTED_WITH_HEADER_ALLOW_LIST)) {
            WebSettingsCompat.setRequestedWithHeaderOriginAllowList(s, Collections.emptySet());
        }

        updater = new Updater(this, () -> runOnUiThread(this::pushUpdateState));
        web.addJavascriptInterface(new Bridge(), "RanchAndroid");
        pageScript = SHIM + "\n" + readAsset("inject.js");
        documentStartScript = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT);
        if (documentStartScript) {
            Set<String> origins = new HashSet<>();
            for (String h : hosts) { origins.add("https://" + h); origins.add("https://*." + h); }
            WebViewCompat.addDocumentStartJavaScript(web, pageScript, origins);
        }
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(BuildConfig.SITE_HOME);
        updater.start();
    }

    /** The iPhone app's message API (window.webkit.messageHandlers.*.postMessage, returning a Promise). */
    private static final String SHIM =
            "(function(){if(window.webkit&&window.webkit.messageHandlers)return;var pending={},n=0;"
            + "window.__ranchReply=function(id,v){var p=pending[id];if(p){delete pending[id];p(v);}};"
            + "var h={postMessage:function(m){return new Promise(function(res){var id=++n;pending[id]=res;"
            + "try{RanchAndroid.post(id,JSON.stringify(m));}catch(e){delete pending[id];res(null);}});}};"
            + "window.webkit={messageHandlers:{rt:h,rw:h}};})();";

    // Strip the "; wv" / "Version/4.0" markers so the page sees regular Chrome for Android.
    static String cleanUserAgent(String ua) {
        return ua.replace("; wv)", ")").replaceAll("Version/\\d+(\\.\\d+)* ", "");
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            return read(in);
        } catch (Exception e) {
            return "";
        }
    }

    static String read(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toString(StandardCharsets.UTF_8.name());
    }

    void pushUpdateState() {
        String s = updater.stateJson();
        web.evaluateJavascript("window.__rtUpdate && window.__rtUpdate(" + s + ");"
                + "window.__rwUpdateState = " + s + "; window.__rwEmit && window.__rwEmit('tb:update', " + s + ");", null);
    }

    // ------------------------------------------------------------------ links

    boolean isInternal(Uri uri) {
        String h = uri.getHost();
        if (h == null) return false;
        h = h.toLowerCase();
        if (isRedirect(uri)) return false;
        for (String d : hosts) if (h.equals(d) || h.endsWith("." + d)) return true;
        for (String d : SIGN_IN_HOSTS) if (h.equals(d)) return true;
        return false;
    }

    /** Facebook's link redirect (l.facebook.com/l.php?u=…) leads to another site. */
    static boolean isRedirect(Uri uri) {
        String h = uri.getHost();
        return h != null && (h.equals("l.facebook.com") || h.equals("lm.facebook.com")) && "/l.php".equals(uri.getPath());
    }

    /** Opens a link in the phone's browser, without tracking redirects or codes. */
    void openOutside(Uri uri) {
        try {
            if (isRedirect(uri) && uri.getQueryParameter("u") != null) uri = Uri.parse(uri.getQueryParameter("u"));
            Uri.Builder b = uri.buildUpon().clearQuery();
            for (String k : uri.getQueryParameterNames()) {
                if (k.equals("fbclid") || k.equals("mibextid") || k.equals("si") || ((k.equals("s") || k.equals("t")) && isInternalTwitter(uri))) continue;
                for (String v : uri.getQueryParameters(k)) b.appendQueryParameter(k, v);
            }
            startActivity(new Intent(Intent.ACTION_VIEW, b.build()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception ignored) { }
    }

    private static boolean isInternalTwitter(Uri uri) {
        String h = uri.getHost();
        return h != null && (h.endsWith("x.com") || h.endsWith("twitter.com"));
    }

    // ------------------------------------------------------------------ messages from the page

    private class Bridge {
        @JavascriptInterface
        public void post(int id, String json) {
            io.execute(() -> {
                Object reply = null;
                try {
                    JSONObject m = new JSONObject(json);
                    String type = m.optString("type");
                    switch (type) {
                        case "segments": reply = segments(m.optString("id")); break;
                        case "votes": reply = votes(m.optString("id")); break;
                        case "update":
                        case "tb:update-install": runOnUiThread(updater::install); break;
                        case "rw:open-outside": {
                            String url = m.optString("arg");
                            if (url.startsWith("http")) runOnUiThread(() -> openOutside(Uri.parse(url)));
                            break;
                        }
                        default: break;
                    }
                } catch (Exception ignored) { }
                String value = reply == null ? "null" : reply.toString();
                runOnUiThread(() -> web.evaluateJavascript("window.__ranchReply && window.__ranchReply(" + id + "," + value + ")", null));
            });
        }
    }

    /** SponsorBlock: asks with only the first 4 characters of the video ID's hash. */
    private JSONArray segments(String videoId) {
        JSONArray out = new JSONArray();
        if (!videoId.matches("[A-Za-z0-9_-]{11}")) return out;
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            StringBuilder hex = new StringBuilder();
            for (byte b : md.digest(videoId.getBytes(StandardCharsets.UTF_8))) hex.append(String.format("%02x", b));
            String cats = Uri.encode("[\"sponsor\",\"selfpromo\",\"interaction\"]");
            JSONArray videos = new JSONArray(get("https://sponsor.ajay.app/api/skipSegments/" + hex.substring(0, 4) + "?categories=" + cats));
            for (int i = 0; i < videos.length(); i++) {
                JSONObject v = videos.getJSONObject(i);
                if (!videoId.equals(v.optString("videoID"))) continue;
                JSONArray segs = v.optJSONArray("segments");
                for (int j = 0; segs != null && j < segs.length(); j++) {
                    JSONObject s = segs.getJSONObject(j);
                    if (!"skip".equals(s.optString("actionType", "skip"))) continue;
                    JSONArray r = s.getJSONArray("segment");
                    out.put(new JSONObject().put("start", r.getDouble(0)).put("end", r.getDouble(1))
                            .put("category", s.optString("category")).put("uuid", s.optString("UUID")));
                }
            }
        } catch (Exception ignored) { }
        return out;
    }

    /** Return YouTube Dislike counts. */
    private JSONObject votes(String videoId) {
        if (!videoId.matches("[A-Za-z0-9_-]{11}")) return null;
        try {
            JSONObject d = new JSONObject(get("https://returnyoutubedislikeapi.com/votes?videoId=" + videoId));
            return new JSONObject().put("likes", d.optLong("likes")).put("dislikes", d.optLong("dislikes"));
        } catch (Exception e) {
            return null;
        }
    }

    static String get(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestProperty("User-Agent", "Ranch-" + BuildConfig.SITE_NAME + "-Android");
        c.setConnectTimeout(10000);
        c.setReadTimeout(10000);
        try (InputStream in = c.getInputStream()) {
            if (c.getResponseCode() != 200) throw new Exception("HTTP " + c.getResponseCode());
            return read(in);
        } finally {
            c.disconnect();
        }
    }

    // ------------------------------------------------------------------ WebView clients

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
            Uri uri = req.getUrl();
            String scheme = uri.getScheme();
            if (("https".equals(scheme) || "http".equals(scheme)) && isInternal(uri)) return false;
            if ("https".equals(scheme) || "http".equals(scheme)) openOutside(uri);
            else {
                try { startActivity(new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) { }
            }
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            if (AdFilter.isBlocked(req.getUrl())) {
                return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
            }
            return null;
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            // Older WebViews without document-start scripts: inject as early as we can
            if (!documentStartScript && url != null && isInternal(Uri.parse(url))) view.evaluateJavascript(pageScript, null);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pushUpdateState();
        }
    }

    private class Chrome extends WebChromeClient {
        // Full-screen video
        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (fullscreenView != null) { callback.onCustomViewHidden(); return; }
            fullscreenView = view;
            fullscreenCallback = callback;
            root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            web.setVisibility(View.GONE);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR);
        }

        @Override
        public void onHideCustomView() {
            if (fullscreenView == null) return;
            root.removeView(fullscreenView);
            fullscreenView = null;
            web.setVisibility(View.VISIBLE);
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
            fullscreenCallback = null;
        }

        // Picking photos and videos to post
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                startActivityForResult(params.createIntent(), REQ_FILES);
            } catch (Exception e) {
                fileCallback = null;
                return false;
            }
            return true;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILES || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                result = new Uri[data.getClipData().getItemCount()];
                for (int i = 0; i < result.length; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    // ------------------------------------------------------------------ lifecycle

    @Override
    protected void onResume() {
        super.onResume();
        updater.onResume();
    }

    // Deliberately no web.onPause(): videos and music keep playing in the background.

    @Override
    public void onBackPressed() {
        if (fullscreenView != null) new Chrome().onHideCustomView();
        else if (web.canGoBack()) web.goBack();
        else moveTaskToBack(true);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        updater.stop();
        io.shutdownNow();
        web.destroy();
        super.onDestroy();
    }
}
