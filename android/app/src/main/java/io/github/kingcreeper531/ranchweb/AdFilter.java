package io.github.kingcreeper531.ranchweb;

import android.net.Uri;

/** Blocks requests to ad and tracking servers. */
final class AdFilter {
    private static final String[] HOSTS = {
            "doubleclick.net",
            "googlesyndication.com",
            "googleadservices.com",
            "googletagservices.com",
            "google-analytics.com",
            "googletagmanager.com",
            "adservice.google.com",
            "imasdk.googleapis.com",
            "ads-twitter.com",
            "ads-api.twitter.com",
            "analytics.twitter.com",
    };

    private static final String[] YOUTUBE_PATHS = {
            "/pagead/",
            "/api/stats/ads",
            "/ptracking",
            "/get_midroll_info",
            "/youtubei/v1/log_event",
    };

    private AdFilter() { }

    static boolean isBlocked(Uri uri) {
        String host = uri.getHost();
        if (host == null) return false;
        for (String h : HOSTS) {
            if (host.equals(h) || host.endsWith("." + h)) return true;
        }
        if (host.endsWith("youtube.com")) {
            String path = uri.getPath();
            if (path != null) {
                for (String p : YOUTUBE_PATHS) if (path.startsWith(p)) return true;
            }
        }
        return false;
    }
}
