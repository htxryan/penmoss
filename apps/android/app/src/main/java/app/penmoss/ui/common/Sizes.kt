package app.penmoss.ui.common

import java.util.Locale

private val SIZE_UNITS = listOf("B", "KB", "MB", "GB", "TB")

/**
 * A size for people, in decimal units as Android's Files and Finder show it (1 KB is 1,000
 * bytes): "512 B", "1.5 KB", "20 MB", "1 GB". One decimal under 10, whole numbers from 10, the
 * number grouped as [counted] groups it. Core's `formatBytes` (`@penmoss/core/words`) writes the
 * same: `WordsContractTest` replays `contract/words-v1.json`.
 */
fun formatBytes(bytes: Long): String {
    var value = maxOf(0L, bytes).toDouble()
    var unit = 0
    while (value >= 1000 && unit < SIZE_UNITS.size - 1) {
        value /= 1000
        unit++
    }
    var shown = if (unit == 0 || value >= 10) Math.round(value).toDouble() else Math.round(value * 10) / 10.0
    // 999,999 bytes rounds to 1,000 KB: say "1 MB" instead.
    if (shown >= 1000 && unit < SIZE_UNITS.size - 1) {
        shown = 1.0
        unit++
    }
    val number = if (shown == Math.floor(shown)) String.format(Locale.US, "%,d", shown.toLong()) else String.format(Locale.US, "%.1f", shown)
    return "$number ${SIZE_UNITS[unit]}"
}
