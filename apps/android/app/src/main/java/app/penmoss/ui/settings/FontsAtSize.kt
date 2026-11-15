package app.penmoss.ui.settings

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.penmoss.engine.settings.FontSettings
import app.penmoss.ui.common.roles

/**
 * Appearance's fonts at their real size (A1582), under the preview: the interface's own text
 * roles (`TextRoles`, in the Interface Font the theme lays over them), each labelled with its
 * role, family and size, so a change of font shows at the size the app draws it. The note's
 * text is the preview's editor page above, already at its real size; its line names the Note
 * Font and Note Font Size it uses.
 */
@Composable
internal fun FontsAtSize(fonts: FontsUi, modifier: Modifier = Modifier) {
    val roles = MaterialTheme.roles
    val colours = MaterialTheme.colorScheme
    val ui = familyName(fonts.interfaceFont)
    Column(
        modifier.padding(horizontal = 16.dp, vertical = 4.dp).fillMaxWidth().border(1.dp, colours.outlineVariant).padding(12.dp).testTag("fontsAtSize"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("Fonts at Real Size", style = roles.listHead, color = colours.onSurfaceVariant)
        Sample("Page Title", "Appearance", roles.pageTitle, ui)
        Sample("Group", "Theme", roles.groupHead, ui)
        Sample("Setting", "Note Font Size", roles.rowLabel, ui)
        Sample("Help", "Syncs to your other devices.", roles.help, ui)
        Text(
            "Note · ${familyName(fonts.noteFont)} · ${fonts.noteSize} px: the note in the preview is at its real size.",
            Modifier.testTag("fontsAtSize-note"),
            style = roles.help,
            color = colours.onSurfaceVariant,
        )
    }
}

@Composable
private fun Sample(role: String, text: String, style: TextStyle, family: String) {
    val colours = MaterialTheme.colorScheme
    Column(Modifier.testTag("fontsAtSize-$role")) {
        Text(text, style = style, color = colours.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text("$role · $family · ${sizeOf(style)}", style = MaterialTheme.roles.meta, color = colours.onSurfaceVariant)
    }
}

/** A font choice as the panel names it, as Settings does: the preset's name or the family typed in. */
internal fun familyName(choice: String): String = FontSettings.label(choice)

/** A style's size as the panel prints it: "16 sp". */
internal fun sizeOf(style: TextStyle): String {
    val value = style.fontSize.value
    val rounded = Math.round(value * 10) / 10f
    return "${if (rounded % 1f == 0f) rounded.toInt().toString() else rounded.toString()} sp"
}
