package app.penmoss.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.penmoss.engine.settings.BadgeGlyph
import app.penmoss.engine.settings.NotebookBadge
import app.penmoss.engine.settings.NotebookBadges
import app.penmoss.ui.common.LucideAssets
import app.penmoss.ui.common.NotebookBadgeView
import app.penmoss.ui.common.OutlinedButton
import app.penmoss.ui.common.badgeColour
import app.penmoss.ui.common.rememberLucideIcons
import kotlinx.serialization.json.JsonElement

/** The row's help (A1579), as the Mac's Badge row says it for the phone. */
internal const val BADGE_HELP = "Shown before the notebook’s name in its rows and on its page. Changes sync with the notebook."

private val KINDS = listOf(BadgeGlyph.LETTER to "Letter", BadgeGlyph.NUMBER to "Number", BadgeGlyph.ICON to "Icon")
private val NUMBER = Regex("^(0|[1-9][0-9]?)$")

/**
 * A notebook's Badge on its page's Overview (A1579), as the Mac's (A1504, A1568): the badge with
 * Reset to Default, its Colour (ten presets, or Custom… with the colour picker), and what it Shows
 * (a letter, a number from 0 to 99, or an icon from the icon picker). Each change is written at
 * once to the notebook's own settings through [onChange] (`badge.color` or `badge.glyph`, null
 * back to the default), so it syncs with the notebook. The default is never written: a rename
 * still changes its letter.
 */
@Composable
fun BadgeSettings(
    badge: NotebookBadge,
    notebookId: String,
    name: String,
    onChange: (key: String, value: JsonElement?) -> Unit,
) {
    val fallback = remember(notebookId, name) { NotebookBadges.defaultBadge(notebookId, name) }
    val glyph = badge.glyph
    var numberText by remember(glyph) { mutableStateOf<String?>(null) }
    var custom by rememberSaveable { mutableStateOf(false) }
    var picking by rememberSaveable { mutableStateOf(false) }
    fun setGlyph(next: BadgeGlyph) {
        onChange(NotebookBadges.GLYPH, if (next == fallback.glyph) null else NotebookBadges.glyphValue(next) ?: return)
    }
    fun setColour(color: String) {
        val value = NotebookBadges.colorValue(color) ?: return
        onChange(NotebookBadges.COLOR, if ((value as? kotlinx.serialization.json.JsonPrimitive)?.content == fallback.preset) null else value)
    }
    fun chooseKind(kind: String) {
        if (kind == glyph.kind) return
        numberText = null
        setGlyph(
            when {
                kind == fallback.glyph.kind -> fallback.glyph
                kind == BadgeGlyph.LETTER -> BadgeGlyph(kind, fallback.glyph.value)
                kind == BadgeGlyph.NUMBER -> BadgeGlyph(kind, "1")
                else -> BadgeGlyph(kind, NotebookBadges.FIRST_ICON)
            },
        )
    }
    Column(Modifier.settingRow("badge").fillMaxWidth().testTag("badgeSettings")) {
        GroupTitle("Badge")
        ListItem(
            leadingContent = { NotebookBadgeView(badge, name, size = 26.dp) },
            headlineContent = { Text(name) },
            supportingContent = { Text(BADGE_HELP) },
            modifier = Modifier.testTag("badgePreview"),
        )
        Row(Modifier.padding(horizontal = 8.dp)) {
            TextButton(
                onClick = {
                    numberText = null
                    onChange(NotebookBadges.COLOR, null)
                    onChange(NotebookBadges.GLYPH, null)
                },
                enabled = badge.custom,
                modifier = Modifier.testTag("badgeReset"),
            ) { Text("Reset to Default") }
        }
        // Colour: the ten presets, then Custom….
        Text(
            "Colour",
            Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp),
            style = MaterialTheme.typography.titleSmall,
        )
        // Wrapped, so every preset and Custom… show on a narrow phone.
        FlowRow(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp).selectableGroup(),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            for (preset in NotebookBadges.PRESETS) {
                val checked = badge.preset == preset.id
                Box(
                    Modifier
                        .size(40.dp)
                        .background(badgeColour(preset.hex), RectangleShape)
                        .border(2.dp, if (checked) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.surface, RectangleShape)
                        .selectable(selected = checked, role = Role.RadioButton) { if (!checked) setColour(preset.id) }
                        .testTag("badgePreset-${preset.id}")
                        .semantics { contentDescription = preset.label },
                    contentAlignment = Alignment.Center,
                ) {
                    if (checked) Icon(Icons.Default.Check, contentDescription = null, tint = badgeColour(NotebookBadges.ink(preset.hex)))
                }
            }
            TextButton(onClick = { custom = true }, modifier = Modifier.testTag("badgeCustom")) {
                Text(if (badge.preset == null) "Custom: ${badge.color.uppercase()}" else "Custom…")
            }
        }
        // Shows: a letter, a number or an icon.
        Text(
            "Shows",
            Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 4.dp),
            style = MaterialTheme.typography.titleSmall,
        )
        Segments(KINDS, glyph.kind, enabled = true, tag = "badgeKind", onChoose = ::chooseKind)
        when (glyph.kind) {
            BadgeGlyph.LETTER -> OutlinedTextField(
                value = glyph.value,
                onValueChange = { text ->
                    // The last character typed: typing over the one there replaces it.
                    val trimmed = text.trim()
                    if (trimmed.isNotEmpty()) {
                        val last = String(Character.toChars(trimmed.codePointBefore(trimmed.length)))
                        setGlyph(BadgeGlyph(BadgeGlyph.LETTER, last))
                    }
                },
                label = { Text("Letter") },
                supportingText = { Text("One character.") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("badgeLetter"),
            )
            BadgeGlyph.NUMBER -> OutlinedTextField(
                value = numberText ?: glyph.value,
                onValueChange = { text ->
                    numberText = text.take(3)
                    if (NUMBER.matches(text)) setGlyph(BadgeGlyph(BadgeGlyph.NUMBER, text))
                },
                label = { Text("Number") },
                supportingText = { Text("From 0 to 99.") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("badgeNumber"),
            )
            else -> BadgeIconRow(glyph.value) { picking = true }
        }
    }
    if (picking) {
        IconPicker(
            current = NotebookBadges.iconInLucide(glyph.value),
            onPick = { value ->
                picking = false
                setGlyph(BadgeGlyph(BadgeGlyph.ICON, value))
            },
            onDismiss = { picking = false },
        )
    }
    if (custom) {
        AlertDialog(
            onDismissRequest = { custom = false },
            title = { Text("Custom Colour") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    // A badge is opaque: the picker's opacity is left out.
                    ColourPicker(hex = badge.color, onChange = { setColour(it.take(7)) })
                    Help("A badge’s colour is the same in light and dark.", Modifier.padding(0.dp))
                }
            },
            confirmButton = { TextButton(onClick = { custom = false }, modifier = Modifier.testTag("badgeCustomDone")) { Text("Done") } },
        )
    }
}

/** The Icon row: the icon the badge shows, its name, and Choose Icon…. */
@Composable
private fun BadgeIconRow(value: String, onChoose: () -> Unit) {
    val lucide = NotebookBadges.iconInLucide(value)
    val icon = lucide?.let { rememberLucideIcons()?.icon(it) }
    ListItem(
        leadingContent = {
            Box(Modifier.size(40.dp).border(1.dp, MaterialTheme.colorScheme.outlineVariant, RectangleShape), contentAlignment = Alignment.Center) {
                if (icon != null) Icon(LucideAssets.vector(icon), contentDescription = null, Modifier.size(24.dp))
            }
        },
        headlineContent = { Text("Icon") },
        supportingContent = { Text(characterLabel(lucide ?: value), Modifier.testTag("badgeIconName")) },
        trailingContent = {
            OutlinedButton(onClick = onChoose, modifier = Modifier.testTag("badgeIconChoose")) { Text("Choose Icon…") }
        },
    )
}
