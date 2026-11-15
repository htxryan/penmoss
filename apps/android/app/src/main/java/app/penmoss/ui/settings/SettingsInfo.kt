package app.penmoss.ui.settings

import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.unit.em
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.DeviceGraph
import app.penmoss.ui.common.roles

/** The primary notebook's name, which Settings' (i) names (A1560); null with no notebook yet. */
val LocalPrimaryNotebookName = compositionLocalOf<String?> { null }

/** The primary notebook's name now, from the phone's notebooks and its choice of primary. */
@Composable
internal fun rememberPrimaryName(device: DeviceGraph): String? {
    val hub = device.gitIfAny ?: return null
    val list by hub.list.collectAsStateWithLifecycle()
    val pick by hub.journalPick.collectAsStateWithLifecycle()
    return remember(list, pick) {
        val id = hub.journal()
        (list.firstOrNull { it.localId == id } ?: list.firstOrNull())?.name
    }
}

/** What the (i) says, as the Mac's does (A1560); the laptop is drawn where [LAPTOP] stands. */
internal fun settingsInfoText(name: String?): String =
    "Settings are synced through your primary notebook${name?.let { ", $it" } ?: ""}. Those marked $LAPTOP stay on this phone only."

private const val LAPTOP = "⁠laptop⁠"

/**
 * Settings' (i) in a screen's top app bar (A1560): where settings are kept and what the laptop
 * marks (A1559). A tap opens the words in a small dialog, a long press names the button.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsInfoButton() {
    var open by rememberSaveable { mutableStateOf(false) }
    val name = LocalPrimaryNotebookName.current
    TooltipBox(
        positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Below),
        tooltip = { PlainTooltip { Text("About Settings") } },
        state = rememberTooltipState(),
    ) {
        IconButton(onClick = { open = true }, modifier = Modifier.testTag("settingsInfo")) {
            Icon(SettingsIcons.Info, contentDescription = "About Settings", tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    if (open) {
        val (before, after) = settingsInfoText(name).split(LAPTOP)
        val words = buildAnnotatedString {
            append(before)
            appendInlineContent("laptop", "[laptop]")
            append(after)
        }
        val laptop = mapOf(
            "laptop" to InlineTextContent(Placeholder(1.2.em, 1.em, PlaceholderVerticalAlign.TextCenter)) {
                Icon(SettingsIcons.Laptop, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            },
        )
        AlertDialog(
            onDismissRequest = { open = false },
            title = { Text("About Settings") },
            text = {
                Text(
                    words,
                    inlineContent = laptop,
                    style = MaterialTheme.roles.body,
                    // Read aloud with the laptop named, as the Mac's says "with a laptop".
                    modifier = Modifier.testTag("settingsInfoText").semantics {
                        contentDescription = "$before with a laptop$after".replace("  ", " ")
                    },
                )
            },
            confirmButton = { TextButton(onClick = { open = false }, Modifier.testTag("settingsInfoOk")) { Text("OK") } },
        )
    }
}
