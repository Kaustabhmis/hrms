package in.dynamicengineers.biscs;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.webkit.GeolocationPermissions;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import android.app.Activity;
import androidx.webkit.WebViewAssetLoader;

/**
 * A shell around the employee app.
 *
 * The web files are bundled in the APK and served over
 * https://appassets.androidplatform.net/ rather than file://. That matters more
 * than it looks: file:// is an opaque origin, where localStorage is unreliable
 * and geolocation is refused outright -- so the sign-in session would be
 * forgotten on every launch and a punch could never carry coordinates. Served
 * this way the page runs on a real secure origin and behaves exactly as it does
 * in a browser, while still working with no network at all.
 */
public class MainActivity extends Activity {

    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // the punch queue and the session live here
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setAllowFileAccess(false);           // nothing needs it; not having it is safer
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSupportZoom(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                return loader.shouldInterceptRequest(req.getUrl());
            }
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri u = req.getUrl();
                // Our own pages stay inside. Anything else is somebody else's
                // site and belongs in a browser, not in this window.
                return !(ORIGIN.equals(u.getScheme() + "://" + u.getHost()));
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin,
                    GeolocationPermissions.Callback cb) {
                boolean granted = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                        == PackageManager.PERMISSION_GRANTED;
                cb.invoke(origin, granted, false);
            }
        });

        askForLocationOnce();
        web.loadUrl(ORIGIN + "/assets/index.html");
    }

    // Back goes back through the app's own history, and only leaves once there
    // is nothing behind it.
    @Override public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    // Asked once, at the start, so the first punch of the day is not the moment
    // somebody meets a permission dialog.
    private void askForLocationOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION }, 1);
        }
    }

    @Override protected void onDestroy() {
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }
}
