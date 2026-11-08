---
title: Install on Mac
description: Download Penmoss for the Mac, install it and keep it up to date.
---

This page shows you how to download Penmoss for the Mac, install it and check the download.

Penmoss runs on macOS 12 or later, on Apple Silicon and Intel Macs. It is signed with a Developer ID and notarised by Apple.

## Download and install

1. Download [Penmoss.dmg](https://github.com/htxryan/penmoss/releases/latest/download/Penmoss.dmg) from the latest stable release on GitHub.
2. Open the downloaded file and drag **Penmoss** to **Applications**. If asked, replace the older copy.
3. Open Penmoss from Applications or Spotlight.

The first time it opens, Penmoss may ask to use the keychain item "Penmoss Safe Storage". That is where it keeps the key that protects your git tokens: choose **Always Allow**.

Penmoss then opens on **Welcome to Penmoss**. Go on to [Your first notebook](/docs/first-notebook/).

## Check the download

Every release lists the SHA-256 of each file in `SHA256SUMS.txt`. To check the dmg, download that file to the same folder and run:

```sh
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
```

It prints `Penmoss.dmg: OK` when the file matches.

## Updates

Penmoss can check for a newer release and offer it; you choose when to install it. Turn this on in **Settings → Updates → Auto-Update**, or press **Check Now** there at any time. See [Updates and the Alpha channel](/docs/help/updates/).

## Uninstall

Quit Penmoss and move it from Applications to the Trash. Your notes stay in your repositories. To remove this Mac's copies too, delete `~/Library/Application Support/Penmoss` and, if you used the CLI or agents, `~/.penmoss`.
