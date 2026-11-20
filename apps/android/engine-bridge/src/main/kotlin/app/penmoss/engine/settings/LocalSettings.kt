package app.penmoss.engine.settings

/**
 * The look and layout this phone keeps alone (Ryan, 18 Nov 2026, A1626): Appearance's theme, mode,
 * fonts and text size, Home's shortcuts and sections, Quick Access's display, and the note's width
 * and bars, which the phone ignores. Written only to this phone's database, never to a notebook,
 * so a theme picked on another device never reaches it. Core's `isLocalSetting`, held to it by
 * `contract/platform-settings-v1.json`'s `local`.
 */
object LocalSettings {
    /** The keys, by name. */
    val KEYS: List<String> = listOf(
        SettingKeys.THEME,
        SettingKeys.MODE,
        SettingKeys.INTERFACE_FONT,
        SettingKeys.NOTE_FONT,
        SettingKeys.NOTE_FONT_SIZE,
        "tooltip.delay",
        "home.dadJokes",
    ) + DisplayKeys.ALL + DisplayKeys.PHONE + listOf(
        SettingKeys.SECTION_ORDER,
        SettingKeys.HIDDEN_SECTIONS,
        SettingKeys.RECENT_COUNT,
        SettingKeys.QUICK_ACCESS_NOTEBOOK,
        SettingKeys.QUICK_ACCESS_IN_DRAWER,
        SettingKeys.FULL_WIDTH,
        "metadata.underTitle",
        "metadata.statusBar",
        // AI Descriptions' provider (PEN-161): each device chooses its own.
        "ai.provider",
    )

    /** The keys, by prefix: the note's title-bar buttons. */
    val PREFIXES: List<String> = listOf("noteBar.")

    /** Whether [key] is kept on this phone alone. */
    fun isLocal(key: String): Boolean = key in KEYS || PREFIXES.any { key.startsWith(it) }
}
