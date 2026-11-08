---
title: Install on Android
description: Sideload Penmoss on an Android phone, check its signing certificate and update it.
---

This page shows you how to install Penmoss on an Android phone from GitHub, and how to check that the app is the one we signed.

Penmoss runs on Android 17 or later. It is not in Google Play yet: you install the APK yourself (sideloading).

## Download and install

1. On the phone, download [Penmoss.apk](https://github.com/htxryan/penmoss/releases/latest/download/Penmoss.apk) from the latest stable release on GitHub.
2. Open the downloaded file. The first time, Android asks you to allow your browser to install apps: allow it, then go back and open the file again.
3. Google Play Protect may warn that it does not know the developer. Choose **Install anyway**.
4. Open **Penmoss** from the app drawer.

The app opens on a screen that says Penmoss keeps your notes in git notebooks, with a form to add one. See [Add a notebook on Android](/docs/more-devices/#android).

You can also put the APK where the phone can reach it (a cloud drive, or an email to yourself) and open it there, or install it from a computer with `adb install Penmoss.apk`.

## Check the signing certificate

Every release of Penmoss for Android is signed with the same certificate. Android itself checks this when you update: it refuses an update signed with a different certificate, so once you have a genuine copy, later updates must come from us too.

To check a download before you install it, use `apksigner` from the Android SDK build tools on a computer:

```sh
apksigner verify --print-certs Penmoss.apk
```

It prints the certificate's SHA-256 digest. Compare it with the digest of a copy you already trust, for example one installed earlier, or one downloaded from a different network.

To check the file itself, every release lists the SHA-256 of each file in `SHA256SUMS.txt`:

```sh
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

## Updates

The Android app does not update itself. To update, download `Penmoss.apk` from the latest release again and open it: it installs over the copy you have and keeps your notebooks.

Builds from the Alpha channel use the same app and certificate, so an Alpha build installs over a stable one, and the next stable release installs over it again once its version is higher. See [Updates and the Alpha channel](/docs/help/updates/).

## Uninstall

Uninstall Penmoss as you would any app. Your notes stay in your repositories; the phone's copies, tokens and signing key go with the app.
