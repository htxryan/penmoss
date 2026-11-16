package app.penmoss.engine.settings

/**
 * The settings each platform keeps its own copy of (PEN-156, A1605): every phone shares one set,
 * every Mac another. The phone's engine page keeps them apart (`mobile/<key>` in the primary
 * notebook, the shared `device/<key>` showing while the phones have none), so the phone only
 * needs to know which they are, to mark them with the phone in Settings. Core's
 * `isPlatformSetting`, held to it by `contract/platform-settings-v1.json`.
 */
object PlatformSettings {
    /** The keys, by name: the theme and its mode, the fonts and size, and Home's layout. */
    val KEYS: List<String> = listOf(
        SettingKeys.THEME,
        SettingKeys.MODE,
        SettingKeys.INTERFACE_FONT,
        SettingKeys.NOTE_FONT,
        SettingKeys.NOTE_FONT_SIZE,
    ) + DisplayKeys.ALL + DisplayKeys.PHONE + listOf(
        SettingKeys.SECTION_ORDER,
        SettingKeys.HIDDEN_SECTIONS,
        SettingKeys.RECENT_COUNT,
        SettingKeys.QUICK_ACCESS_NOTEBOOK,
    )

    /** The keys, by prefix: the keyboard shortcuts (`keys.<command>`). */
    val PREFIXES: List<String> = listOf("keys.")

    /** Whether [key] is kept for the phones alone, not shared with the Macs. */
    fun isPlatform(key: String): Boolean = key in KEYS || PREFIXES.any { key.startsWith(it) }
}
