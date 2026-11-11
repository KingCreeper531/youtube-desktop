package io.github.kingcreeper531.ranchweb;

import android.content.Context;
import android.view.View;
import android.webkit.WebView;

/**
 * A WebView that keeps playing media when the app is in the background.
 * Android's WebView pauses video elements once its window becomes invisible;
 * so report "visible" and let videos and music keep playing.
 */
public class BackgroundWebView extends WebView {
    public BackgroundWebView(Context context) {
        super(context);
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        if (visibility != View.GONE) super.onWindowVisibilityChanged(View.VISIBLE);
    }
}
