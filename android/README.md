# BISCS "My Work" — the employee Android app

The same app twice, from one set of files:

* **A website** at `/app/` on your Netlify site — anyone can open it in Chrome
  and add it to their home screen, nothing to install.
* **An APK** — `app/build/outputs/apk/release/app-release.apk`, the same files
  wrapped in an Android shell you can hand round on WhatsApp.

Everything lives in `../modules/hrms/app/`. The APK copies those files into
`app/src/main/assets/` at build time, so there is one app, not two.

## Building it again

```bash
export ANDROID_HOME=/path/to/android-sdk
cp ../modules/hrms/app/* app/src/main/assets/     # pick up any web changes
gradle :app:assembleRelease
```

The APK lands in `app/build/outputs/apk/release/`.

## Installing it on a phone

Send the `.apk` file to the person (WhatsApp, email, a link). On the phone:
open it, allow "install unknown apps" for whatever they opened it from, install.
Android 7.0 and newer.

## The signing key

`biscs-release.jks` (password `biscsapp`, alias `biscs`) is a self-signed key
for handing the APK round yourselves. Two things follow from that:

* **Keep it.** Android will only install an update signed with the same key.
  Lose it and everyone has to uninstall and reinstall, losing their saved
  session.
* **It is not a Play Store key.** Publishing on Google Play needs a key you
  generate and keep private, and the password must not sit in a repository the
  way this one does.

## Why the pages are served over https inside the app

The shell serves the bundled files from `https://appassets.androidplatform.net/`
rather than `file://`. A `file://` page is an opaque origin: `localStorage` is
unreliable there, and geolocation is refused outright. That would mean the
sign-in session forgotten on every launch and punches that could never carry
coordinates. Served this way the page behaves exactly as it does in a browser,
while still working with no network at all.

## What was and was not tested

The web app was driven end to end in a phone-sized browser — sign-in, sliding
to clock in and out, the calendar, leave, on-duty, forgotten punches, the
profile, and a manager approving a request. The APK builds, is signed (v2), and
its assets load correctly from the exact URL the shell uses.

**The APK itself has never been launched.** There is no Android device or
emulator in the environment it was built in. Install it on one phone and check
it opens before sending it to everybody.
