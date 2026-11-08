package app.penmoss.ui.keys

import android.view.KeyCharacterMap
import android.view.KeyEvent

/**
 * Physical keyboard layouts as Android's `.kcm` files map the keys these tests press (T40 P9
 * review B1), for [KeyChars]: Robolectric's own `KeyCharacterMap` knows only a US layout. A
 * `ralt:` character is typed with the right Alt (AltGr) alone, an `alt:` one with either Alt;
 * Ctrl gives none, and a key with no modifier types its letter or digit.
 */
class Layout(private val ralt: Map<Int, Int> = emptyMap(), private val alt: Map<Int, Int> = emptyMap()) : KeyChars {
    override fun of(event: KeyEvent): Int {
        if (event.isCtrlPressed || event.isMetaPressed) return 0
        val right = event.metaState and KeyEvent.META_ALT_RIGHT_ON != 0
        if (event.isAltPressed) return (if (right) ralt[event.keyCode] else null) ?: alt[event.keyCode] ?: 0
        return when (event.keyCode) {
            in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> 'a'.code + event.keyCode - KeyEvent.KEYCODE_A
            in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> '0'.code + event.keyCode - KeyEvent.KEYCODE_0
            KeyEvent.KEYCODE_SPACE -> ' '.code
            else -> 0
        }
    }

    companion object {
        /** `keyboard_layout_english_us.kcm`: no Alt characters. */
        val US = Layout()

        /** `keyboard_layout_polish.kcm` (programmer's): AltGr+N ń, +C ć, +A ą, +E ę. */
        val POLISH = Layout(
            ralt = mapOf(
                KeyEvent.KEYCODE_N to 'ń'.code,
                KeyEvent.KEYCODE_C to 'ć'.code,
                KeyEvent.KEYCODE_A to 'ą'.code,
                KeyEvent.KEYCODE_E to 'ę'.code,
            ),
        )

        /** `keyboard_layout_german.kcm`: AltGr+Q @, +7 {, +8 [, +E €. */
        val GERMAN = Layout(
            ralt = mapOf(
                KeyEvent.KEYCODE_Q to '@'.code,
                KeyEvent.KEYCODE_7 to '{'.code,
                KeyEvent.KEYCODE_8 to '['.code,
                KeyEvent.KEYCODE_E to '€'.code,
            ),
        )

        /**
         * `Generic.kcm`: Alt+N, +E, +U, +I and +` are dead accents (Alt+N then n is ñ); Alt+C
         * types ç and Alt+S ß (review N8).
         */
        val GENERIC = Layout(
            alt = mapOf(
                KeyEvent.KEYCODE_N to (KeyCharacterMap.COMBINING_ACCENT or 0x0303),
                KeyEvent.KEYCODE_E to (KeyCharacterMap.COMBINING_ACCENT or 0x0301),
                KeyEvent.KEYCODE_U to (KeyCharacterMap.COMBINING_ACCENT or 0x0308),
                KeyEvent.KEYCODE_C to 'ç'.code,
                KeyEvent.KEYCODE_S to 'ß'.code,
            ),
        )
    }
}
