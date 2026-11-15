package app.penmoss.engine.settings

/**
 * The open source notices (A1580): the web's own `third-party-notices.txt`, copied into this
 * module's resources at build, which holds Lucide's licence and the Characters' notice
 * (emojibase-data's and Unicode's licences, as `characters-NOTICE.txt` beside their file has it).
 * Settings → What's New shows it behind Open Source Notices.
 */
object Notices {
    val text: String by lazy {
        Notices::class.java.getResourceAsStream("/third-party-notices.txt")
            ?.bufferedReader(Charsets.UTF_8)
            ?.use { it.readText() }
            ?: error("third-party-notices.txt is missing from the engine's resources")
    }
}
