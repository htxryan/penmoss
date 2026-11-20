package app.penmoss.ui.settings

import app.penmoss.ui.keys.CommandRoutes

/**
 * Settings → Search Settings on the phone (PEN-146): every setting a person can look for, by its
 * label, its help or another word for it ("dark", "token", "hotkey"), and the screen it is on.
 * The ids are the rows' labels in kebab case, as the Mac's `data-setting` ids are: the row with
 * `Modifier.settingRow(id)` is the one a result scrolls to and marks (PEN-148).
 */
data class SettingEntry(
    val id: String,
    val label: String,
    /** The screen's name, as its row in Settings says it. */
    val section: String,
    val route: String,
    val help: String? = null,
    val aliases: List<String> = emptyList(),
)

/** A row's id from its label, in kebab case as the Mac's `data-setting`: "Copy Settings…" → copy-settings. */
fun settingId(label: String): String = label.lowercase().replace('’', '-').replace(Regex("[^a-z0-9]+"), "-").trim('-')

private fun entry(label: String, section: String, route: String, help: String? = null, vararg aliases: String) =
    SettingEntry(settingId(label), label, section, route, help, aliases.toList())

/** Every setting on the phone's Settings, screen by screen in the list's order. */
val SETTINGS_INDEX: List<SettingEntry> = listOf(
    entry("Mode", "Appearance", SettingsRoutes.APPEARANCE, "Light, dark or the phone’s own", "dark", "light", "night", "system"),
    entry("Theme", "Appearance", SettingsRoutes.APPEARANCE, "Penmoss, Paper, Slate, Nord and your own", "colours", "colors", "palette"),
    entry("Customize Theme", "Appearance", SettingsRoutes.APPEARANCE, "Your own copy of a theme, its colours and fonts", "theme editor", "custom theme", "duplicate"),
    entry("Interface Font", "Appearance", SettingsRoutes.APPEARANCE, "The app’s own text", "typeface"),
    entry("Note Font", "Appearance", SettingsRoutes.APPEARANCE, "Your notes’ text", "typeface"),
    entry("Note Font Size", "Appearance", SettingsRoutes.APPEARANCE, "12 to 28 px", "text size", "bigger", "smaller"),
    entry("Shortcuts on Home", "Home", SettingsRoutes.DISPLAY, "Tags, Today, This Week, Graph and Commands", "hide", "sidebar", "buttons"),
    entry("Sections", "Home", SettingsRoutes.DISPLAY, "Quick Access, Recent Notes and Notebooks, in your order", "reorder", "sidebar"),
    entry("Show Notebook Names", "Home", SettingsRoutes.DISPLAY, "In Quick Access", "quick access"),
    entry("Notes in the Sidebar", "Home", SettingsRoutes.DISPLAY, "Quick Access's notes, one tap each", "quick access", "drawer", "menu", "pinned"),
    entry("Recent Notes", "Home", SettingsRoutes.DISPLAY, "How many Home lists", "recent count"),
    entry("Note Width", "Note", SettingsRoutes.NOTE, "The theme’s width or the full width", "full width", "wide", "layout"),
    entry("Description Under the Title", "Note", SettingsRoutes.NOTE, "The note’s description under its title", "description", "under the title", "metadata", "ai"),
    entry("Symbols", "Symbols", SettingsRoutes.SYMBOLS, "Mark a line with a symbol at its start", "line symbols", "glyph", "emoji", "star"),
    entry("Restore Default Symbols", "Symbols", SettingsRoutes.SYMBOLS, null, "reset symbols"),
    entry("Time Zone", "Daily Notes", SettingsRoutes.DAILY, "Which day today is", "timezone", "zone", "clock"),
    entry("Daily Template", "Daily Notes", SettingsRoutes.DAILY, "What a new daily note starts with", "journal", "today"),
    entry("Weekly Template", "Daily Notes", SettingsRoutes.DAILY, "What a new weekly note starts with", "journal", "week"),
    entry("Saves To", "Quick Capture", SettingsRoutes.CAPTURE, "Today’s note or a new note in Inbox", "capture", "inbox", "share", "widget", "tile"),
    entry("Describe Notes", "AI Descriptions", SettingsRoutes.AI, "AI writes a short description of each note for agents", "ai", "claude", "anthropic", "summary", "description"),
    entry("Describe a Note", "AI Descriptions", SettingsRoutes.AI, "After a pause, or at sync", "ai", "when", "pause"),
    entry("AI Provider", "AI Descriptions", SettingsRoutes.AI, "Anthropic with an API key, or Not Set Up", "ai", "anthropic", "api key", "claude"),
    entry("Prompt", "AI Descriptions", SettingsRoutes.AI, "What is sent for each note", "ai", "tokens", "template"),
    entry("Keyboard Shortcuts", "Keyboard Shortcuts", CommandRoutes.SHORTCUTS, "For a hardware keyboard", "keys", "hotkey", "keybindings"),
    entry("All Notebooks", "All Notebooks", CommandRoutes.GIT_NOTEBOOKS, "The notebooks on this phone", "git", "repository", "repo"),
    entry("Add Notebook", "All Notebooks", CommandRoutes.GIT_NOTEBOOKS, "From a private GitHub repository", "new notebook", "clone", "repository"),
    entry("Primary Notebook", "All Notebooks", CommandRoutes.GIT_NOTEBOOKS, "Holds your journal, Inbox and these settings", "journal notebook", "default notebook"),
    entry("Keep Settings in Step", "All Notebooks", CommandRoutes.GIT_NOTEBOOKS, "The primary notebook’s changes go to the others", "between notebooks", "sync settings", "same settings"),
    entry("Copy Tags When Copying Notes", "All Notebooks", CommandRoutes.GIT_NOTEBOOKS, "Copy to Notebook’s starting choice", "between notebooks"),
    entry("Copy Settings…", "All Notebooks", CommandRoutes.GIT_NOTEBOOKS, "From one notebook to another, once", "between notebooks", "same settings", "duplicate settings"),
    entry("Commits from This Phone", "All Notebooks", CommandRoutes.GIT_NOTEBOOKS, "Your commit name, email and signing key", "git identity", "author", "email", "signing key", "ssh"),
    entry("Background Sync", "All Notebooks", CommandRoutes.GIT_NOTEBOOKS, "About every 15 minutes while the app is closed", "battery", "doze"),
    entry("Agent Activity", "Agent Activity", SettingsRoutes.AGENT_ACTIVITY, "What agents changed, with Undo", "agents", "undo", "mcp", "cli"),
    entry("Files and Pictures in Notes", "Storage", SettingsRoutes.STORAGE, "The space they take on this phone", "attachments", "space", "disk"),
    entry("Pictures from the Web", "Storage", SettingsRoutes.STORAGE, "Kept to show again; Clear empties them", "cache", "images"),
    entry("Load Pictures from the Web", "Storage", SettingsRoutes.STORAGE, "Always, On Wi-Fi or Never", "privacy", "images", "mobile data", "wifi"),
    entry("GitHub", "GitHub", SettingsRoutes.GITHUB, "Your GitHub account on this phone", "account", "sign in", "sign out", "login"),
    entry("GitHub Token", "GitHub", SettingsRoutes.GITHUB, "Use a token instead of signing in, or add an account with one", "token", "personal access token", "pat"),
    entry("Send Feedback", "GitHub", SettingsRoutes.GITHUB, "Files an issue with your GitHub account", "bug", "report", "feature request", "outbox"),
    entry("What’s New", "What’s New", SettingsRoutes.WHATS_NEW, "This version and earlier ones", "version", "release notes", "changelog", "update"),
    entry("Open Source Notices", "What’s New", SettingsRoutes.WHATS_NEW, "The licences of the open source software Penmoss includes", "licences", "licenses", "third-party notices", "credits", "about", "lucide"),
    // Settings → Privacy (PEN-137): the Mac's data-setting ids and aliases, "Privacy" or "Privacy › Advanced".
    entry("Share Usage Data", PRIVACY, SettingsRoutes.PRIVACY, "Sends the record to Penmoss’s developer", "analytics", "telemetry", "tracking", "usage", "usage data", "statistics", "opt out", "consent"),
    entry("View Analytics Data", PRIVACY, SettingsRoutes.PRIVACY, "What Penmoss recorded on this phone", "analytics", "telemetry", "tracking", "events", "what is recorded", "usage"),
    entry("Analytics ID", PRIVACY, SettingsRoutes.PRIVACY, "A random ID you can reset", "analytics", "telemetry", "install id", "identifier"),
    entry("Reset My Analytics ID", PRIVACY, SettingsRoutes.PRIVACY, "A new ID; events not yet sent stay on this phone", "analytics", "telemetry", "new id", "reset"),
    entry("Delete My Shared Data", PRIVACY, SettingsRoutes.PRIVACY, "Penmoss’s server deletes what this phone shared", "analytics", "telemetry", "tracking", "forget", "erase", "gdpr", "delete data"),
    entry("Logs", PRIVACY, SettingsRoutes.PRIVACY, "Share Log File", "logs", "log file", "diagnostics", "debug", "crash", "share logs"),
    entry("Advanced", PRIVACY, SettingsRoutes.PRIVACY, "How much Penmoss keeps on this phone", "analytics", "telemetry", "limits", "storage", "retention", "diagnostics"),
    entry("Keep Events For", PRIVACY_ADVANCED, SettingsRoutes.PRIVACY, "1–360 days", "analytics", "telemetry", "usage", "retention", "history", "limit"),
    entry("Keep at Most", PRIVACY_ADVANCED, SettingsRoutes.PRIVACY, "500–800,000 events", "analytics", "telemetry", "usage", "retention", "history", "limit"),
    entry("Log File Size", PRIVACY_ADVANCED, SettingsRoutes.PRIVACY, "256–81,920 KB", "logs", "diagnostics", "disk space", "retention"),
    entry("Log Files Kept", PRIVACY_ADVANCED, SettingsRoutes.PRIVACY, "1–5 files", "logs", "diagnostics", "disk space", "retention"),
    entry("Keep Log Lines For", PRIVACY_ADVANCED, SettingsRoutes.PRIVACY, "1–360 days", "logs", "diagnostics", "disk space", "retention"),
    entry("Attach Logs from the Last", PRIVACY_ADVANCED, SettingsRoutes.PRIVACY, "1–168 hours of logs in a bug report", "logs", "diagnostics", "bug report", "feedback"),
    SettingEntry("report-at-most-lines", "At Most", PRIVACY_ADVANCED, SettingsRoutes.PRIVACY, "50–2,000 lines in a bug report", listOf("logs", "diagnostics", "bug report", "feedback")),
    SettingEntry("report-at-most-kb", "At Most", PRIVACY_ADVANCED, SettingsRoutes.PRIVACY, "4–40 KB of logs in a bug report", listOf("logs", "diagnostics", "bug report", "feedback")),
)

/** Where Privacy's rows are, as a result says it. */
private const val PRIVACY = "Privacy"
private const val PRIVACY_ADVANCED = "Privacy › Advanced"

/**
 * What a search finds (PEN-146): every word typed must be in the label, the help, the screen's
 * name or another word for it. A label's matches come first, then the rest in the list's order.
 */
fun searchSettings(index: List<SettingEntry>, query: String): List<SettingEntry> {
    val words = query.trim().lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (words.isEmpty()) return emptyList()
    fun haystack(entry: SettingEntry) = (listOf(entry.label, entry.section, entry.help.orEmpty()) + entry.aliases).joinToString(" ").lowercase().replace('’', '\'')
    val found = index.filter { entry -> val text = haystack(entry); words.all { it.replace('’', '\'') in text } }
    val (labelled, rest) = found.partition { entry -> words.all { it in entry.label.lowercase() } }
    return labelled + rest
}
