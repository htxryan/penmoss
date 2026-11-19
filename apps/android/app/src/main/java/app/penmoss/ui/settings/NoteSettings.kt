package app.penmoss.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.DeviceGraph
import app.penmoss.engine.settings.SettingKeys
import app.penmoss.engine.settings.ThemeCatalogue
import app.penmoss.ui.common.roles
import kotlinx.serialization.json.JsonPrimitive

/*
 * Settings → Note on the phone (A1634): the Mac's Note page (`NoteSettings`), with what the
 * phone's note has. Note Width moved here from Appearance. The Mac's Note Panel, Title Bar Buttons,
 * Under the Title and In the Status Bar are not here: the phone's note draws its panel over the
 * note, its bar's buttons are fixed, and it has no details under its title or status bar.
 */

/** What the Settings list says of Note: its width. */
fun noteSummary(fullWidth: Boolean): String = if (fullWidth) "Full width" else "The theme’s width"

@Composable
internal fun NoteSettingsRoute(graph: DeviceGraph, onBack: () -> Unit) {
    val state by graph.settings.collectAsStateWithLifecycle()
    val appearance by graph.appearance.collectAsStateWithLifecycle()
    val settings = state.settings
    val resolved = ThemeCatalogue.bundled.resolve(settings)
    val width = (resolved.theme["editorWidth"] as? JsonPrimitive)?.content?.toDoubleOrNull()?.toInt() ?: 52
    val variant = if (appearance.isDark(isSystemInDarkTheme())) "dark" else "light"
    NoteSettingsScreen(
        fullWidth = settings.fullWidth,
        editorWidth = width,
        enabled = state.known,
        // Off is stored too, as the web stores it, so another device's copy never wins (A501).
        onFullWidth = { graph.changeSetting(SettingKeys.FULL_WIDTH, JsonPrimitive(it)) },
        onBack = onBack,
        noteFont = familyName(settings.noteFont),
        noteSize = settings.noteFontSize,
        // The note in the preview is the editor page itself, at the width chosen (A418, A1634).
        notePreview = { modifier -> ThemePreview(resolved.theme, variant, modifier, fullWidth = settings.fullWidth) },
    )
}

/**
 * Settings → Note (A1634): two tabs, as Appearance's and Home's (A1633). Settings holds Layout's
 * Note Width, the theme's width or the full width; Preview holds the note as the app draws it
 * ([notePreview], the editor page itself, inert) at that width, and a line naming its font and size.
 */
@Composable
fun NoteSettingsScreen(
    fullWidth: Boolean,
    /** The theme's width, in rem, which the theme's option says. */
    editorWidth: Int,
    enabled: Boolean,
    onFullWidth: (Boolean) -> Unit,
    onBack: () -> Unit,
    /** The Note Font's name and the Note Font Size, which the Preview tab names. */
    noteFont: String = "Theme Default",
    noteSize: Int = 16,
    /** The note in the preview: the editor page itself (ThemePreview, A418); none in tests. */
    notePreview: (@Composable (Modifier) -> Unit)? = null,
) {
    var previewing by rememberSaveable { mutableStateOf(false) }
    // The tabs hold still under the title and each tab's page scrolls under them, as Appearance's.
    SectionScreen("Note", onBack, notice = if (enabled) null else SETTINGS_WAIT, fill = true) {
        SettingsPreviewTabs(previewing, "note") { previewing = it }
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(top = 12.dp, bottom = 24.dp).testTag(if (previewing) "notePreviewPanel" else "noteSettingsPanel")) {
            if (previewing) {
                NotePreview(notePreview, noteFont, noteSize)
                return@Column
            }
            Help("How a note is laid out.")
            GroupTitle("Layout", deviceOnly = true)
            Text("Note Width", Modifier.settingRow("note-width").padding(horizontal = 16.dp, vertical = 4.dp), style = MaterialTheme.typography.bodyLarge)
            Segments(
                listOf("theme" to "The Theme’s Width", "full" to "Full Width"),
                if (fullWidth) "full" else "theme",
                enabled,
                "width",
                event = "settings.note.width",
            ) { onFullWidth(it == "full") }
            Help("The theme’s is $editorWidth rem. Kept on this phone. A phone already uses its whole width; this shows on a tablet or an unfolded phone. A hardware keyboard’s Toggle Full-Width Notes changes it too.")
        }
    }
}

/** The Preview tab's note: tall enough for the whole sample note at the default sizes, as Appearance's. */
private val PREVIEW_NOTE_HEIGHT = 548.dp

/** The note as the app draws it, inert (A1564), at its real size, then the line naming its text. */
@Composable
private fun NotePreview(note: (@Composable (Modifier) -> Unit)?, noteFont: String, noteSize: Int) {
    val colours = MaterialTheme.colorScheme
    Text(
        "A note as the app draws it, with these settings. Change them on Settings.",
        Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("notePreviewCaption"),
        style = MaterialTheme.roles.help,
        color = colours.onSurfaceVariant,
    )
    InertPreview(Modifier.padding(horizontal = 16.dp).fillMaxWidth().testTag("notePreviewApp"), "notePreviewShield") {
        Box(Modifier.fillMaxWidth().height(PREVIEW_NOTE_HEIGHT).border(1.dp, colours.outlineVariant).background(colours.surface)) {
            if (note != null) note(Modifier.fillMaxSize())
        }
    }
    Text(
        "Note · $noteFont · $noteSize px, at its real size. The fonts are on Appearance.",
        Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("notePreviewFont"),
        style = MaterialTheme.roles.help,
        color = colours.onSurfaceVariant,
    )
}
