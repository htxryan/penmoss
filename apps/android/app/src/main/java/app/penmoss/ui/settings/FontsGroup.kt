package app.penmoss.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ListItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import app.penmoss.engine.settings.FontSettings
import app.penmoss.ui.interfaceFontFamily
import kotlin.math.roundToInt

/** Settings → Appearance's fonts (T51, A944): the three synced settings and how to change them. */
data class FontsUi(
    val interfaceFont: String,
    val noteFont: String,
    val noteSize: Int,
    val onInterfaceFont: (String) -> Unit,
    val onNoteFont: (String) -> Unit,
    val onNoteSize: (Int) -> Unit,
)

/**
 * Interface Font, Note Font and Note Font Size (T51, A944): each font a preset or one installed
 * family by name, the size 12 to 28 px. The interface font is the native screens'; the note font
 * and size are the editor page's. They sync to the person's other devices.
 */
@Composable
internal fun FontsGroup(fonts: FontsUi, enabled: Boolean) {
    var choosing by rememberSaveable { mutableStateOf<String?>(null) }
    GroupTitle("Fonts")
    ListItem(
        headlineContent = { Text("Interface Font") },
        supportingContent = { Text(FontSettings.label(fonts.interfaceFont)) },
        modifier = Modifier.testTag("font-interface").clickable(enabled = enabled, role = Role.Button) { choosing = INTERFACE },
    )
    ListItem(
        headlineContent = { Text("Note Font") },
        supportingContent = { Text(FontSettings.label(fonts.noteFont)) },
        modifier = Modifier.testTag("font-note").clickable(enabled = enabled, role = Role.Button) { choosing = NOTE },
    )
    // The size moves as it is dragged and is stored once let go, so a drag sends one change.
    var size by rememberSaveable { mutableFloatStateOf(fonts.noteSize.toFloat()) }
    LaunchedEffect(fonts.noteSize) { size = fonts.noteSize.toFloat() }
    ListItem(
        headlineContent = { Text("Note Font Size") },
        supportingContent = {
            Column {
                Text("${size.roundToInt()} px${if (size.roundToInt() == FontSettings.SIZE_DEFAULT) " (default)" else ""}")
                Slider(
                    value = size,
                    onValueChange = { size = it.roundToInt().toFloat() },
                    onValueChangeFinished = { if (size.roundToInt() != fonts.noteSize) fonts.onNoteSize(size.roundToInt()) },
                    valueRange = FontSettings.SIZE_MIN.toFloat()..FontSettings.SIZE_MAX.toFloat(),
                    steps = FontSettings.SIZE_MAX - FontSettings.SIZE_MIN - 1,
                    enabled = enabled,
                    modifier = Modifier.testTag("font-size").semantics {
                        contentDescription = "Note Font Size"
                        stateDescription = "${size.roundToInt()} pixels"
                    },
                )
            }
        },
    )
    Help("The interface font is this app’s; the note font and size are your notes’. Headings scale with the size. They sync to your other devices.")
    choosing?.let { which ->
        FontDialog(
            title = if (which == INTERFACE) "Interface Font" else "Note Font",
            current = if (which == INTERFACE) fonts.interfaceFont else fonts.noteFont,
            onPick = {
                choosing = null
                if (which == INTERFACE) fonts.onInterfaceFont(it) else fonts.onNoteFont(it)
            },
            onDismiss = { choosing = null },
        )
    }
}

private const val INTERFACE = "interface"
private const val NOTE = "note"

/** A font's presets, each in its own face, and Custom… with a family's name, checked as it is typed. */
@Composable
private fun FontDialog(title: String, current: String, onPick: (String) -> Unit, onDismiss: () -> Unit) {
    val currentCustom = FontSettings.customFamily(current)
    var custom by rememberSaveable { mutableStateOf(currentCustom != null) }
    var family by rememberSaveable { mutableStateOf(currentCustom.orEmpty()) }
    val problem = FontSettings.familyProblem(family)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()).selectableGroup(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                for ((key, label) in FontSettings.PRESETS) {
                    val selected = !custom && key == current
                    ListItem(
                        headlineContent = { Text(label, fontFamily = interfaceFontFamily(key)) },
                        leadingContent = { RadioButton(selected = selected, onClick = null) },
                        modifier = Modifier
                            .testTag("font-preset-$key")
                            .selectable(selected = selected, role = Role.RadioButton) { onPick(key) },
                    )
                }
                ListItem(
                    headlineContent = { Text("Custom…") },
                    leadingContent = { RadioButton(selected = custom, onClick = null) },
                    modifier = Modifier.testTag("font-preset-custom").selectable(selected = custom, role = Role.RadioButton) { custom = true },
                )
                if (custom) {
                    OutlinedTextField(
                        value = family,
                        onValueChange = { family = it.take(FontSettings.MAX_FAMILY_CHARS) },
                        label = { Text("Font Name") },
                        singleLine = true,
                        isError = family.isNotEmpty() && problem != null,
                        supportingText = { Text(if (family.isNotEmpty() && problem != null) problem else "An installed font; Penmoss falls back to the system font without it.") },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 4.dp)
                            .testTag("font-custom-name")
                            .semantics { if (family.isNotEmpty()) problem?.let { error(it) } },
                    )
                }
            }
        },
        confirmButton = {
            if (custom) {
                TextButton(
                    onClick = { onPick(FontSettings.CUSTOM_PREFIX + family.trim()) },
                    enabled = problem == null,
                    modifier = Modifier.testTag("font-custom-use"),
                ) { Text("Use This Font") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
