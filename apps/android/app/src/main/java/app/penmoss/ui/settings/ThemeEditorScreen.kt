package app.penmoss.ui.settings

import androidx.compose.foundation.BorderStroke
import app.penmoss.ui.square.SQUARE
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AlertDialog
import app.penmoss.ui.square.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import app.penmoss.ui.square.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import app.penmoss.engine.settings.Colour
import app.penmoss.engine.settings.Contrast
import app.penmoss.engine.settings.ContrastCheck
import app.penmoss.engine.settings.ThemeCatalogue
import app.penmoss.engine.settings.ThemeEdits
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.Locale

/** Edits are saved (and synced) once they pause this long, as on the web; the preview shows them at once. */
const val THEME_SAVE_DELAY_MS = 400L

/**
 * The theme editor (T40 P1b, ST5, A417), adapted to a phone. The web edits beside a full app
 * preview; a phone has room for controls or a preview, not both, so the preview is a strip at
 * the top (the real editor page, A418) and each colour opens in a sheet. Name, the variant to
 * edit, the colour tokens in the web's groups, fonts and note width; Duplicate and Delete in
 * the overflow menu. Contrast warnings sit beside the colours they concern; they only advise
 * (A419): the server's `parseTheme` decides what a theme may hold.
 *
 * Edits show at once and are saved once they pause, as the web saves; leaving saves what is
 * left. A newer saved version (another device's edit) replaces the screen's while nothing is
 * waiting to be saved.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThemeEditorScreen(
    /** The theme as the phone has it (changes not sent yet included); null when it has gone. */
    saved: JsonObject?,
    catalogue: ThemeCatalogue,
    /** The other themes' names, to say when this one takes another's. */
    otherNames: List<String>,
    /** The variant the app shows now, which the editor starts on. */
    shownVariant: String,
    enabled: Boolean,
    /** False until the phone has read its settings (just after the app was restarted): not deleted, loading. */
    loaded: Boolean = true,
    onSave: (JsonObject) -> Unit,
    onDuplicate: (JsonObject) -> Unit,
    onDelete: (JsonObject) -> Unit,
    onBack: () -> Unit,
    preview: @Composable (theme: JsonObject, variant: String, modifier: Modifier) -> Unit,
) {
    var draft by remember { mutableStateOf(saved) }
    var dirty by remember { mutableStateOf(false) }
    var variant by rememberSaveable { mutableStateOf(shownVariant) }
    // The open colour sheet and the delete question outlive a rotation (and the app being restarted).
    var editing by rememberSaveable { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    var confirmDelete by rememberSaveable { mutableStateOf(false) }

    // A newer saved version replaces the screen's while there is nothing of its own to save.
    LaunchedEffect(saved) { if (!dirty) draft = saved }
    // Saved once edits pause.
    LaunchedEffect(draft, dirty) {
        val pending = draft
        if (dirty && pending != null) {
            delay(THEME_SAVE_DELAY_MS)
            onSave(pending)
            dirty = false
        }
    }
    // Leaving saves what was left unsaved.
    val latest by rememberUpdatedState(draft to dirty)
    val save by rememberUpdatedState(onSave)
    DisposableEffect(Unit) {
        onDispose {
            val (pending, waiting) = latest
            if (waiting && pending != null) save(pending)
        }
    }
    fun edit(next: JsonObject) {
        draft = next
        dirty = true
    }

    val theme = draft
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(theme?.let { it.text("name") } ?: "Theme editor") },
                navigationIcon = { BackButton(onBack) },
                actions = {
                    if (theme != null) {
                        IconButton(onClick = { menu = true }, Modifier.testTag("themeMenu")) {
                            Icon(Icons.Default.MoreVert, contentDescription = "More Options")
                        }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(
                                text = { Text("Duplicate") },
                                enabled = enabled,
                                onClick = {
                                    menu = false
                                    onDuplicate(theme)
                                },
                                modifier = Modifier.testTag("duplicateThis"),
                            )
                            DropdownMenuItem(
                                text = { Text("Delete This Theme", color = MaterialTheme.colorScheme.error) },
                                enabled = enabled,
                                onClick = {
                                    menu = false
                                    confirmDelete = true
                                },
                                modifier = Modifier.testTag("deleteTheme"),
                            )
                        }
                    }
                },
            )
        },
    ) { padding ->
        if (theme == null) {
            Column(Modifier.fillMaxSize().padding(padding)) {
                if (loaded) {
                    Help("This theme was deleted, here or on another device. Its changes were not kept.", Modifier.testTag("themeGone"))
                } else {
                    LinearProgressIndicator(Modifier.fillMaxWidth().testTag("themeLoading"))
                }
            }
            return@Scaffold
        }
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            // Always in view while the controls scroll: the real note, in the colours being edited.
            preview(theme, variant, Modifier.fillMaxWidth().height(PREVIEW_HEIGHT).testTag("themePreview"))
            HorizontalDivider()
            Column(Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 16.dp)) {
                if (!enabled) Help(SETTINGS_WAIT, Modifier.testTag("settingsNotice"))
                NameField(theme, otherNames, enabled) { edit(ThemeEdits.withName(theme, it)) }
                GroupTitle("Variant")
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("themeVariant")) {
                    listOf("light" to "Light", "dark" to "Dark").forEachIndexed { index, (value, label) ->
                        SegmentedButton(
                            selected = variant == value,
                            onClick = { variant = value },
                            shape = SegmentedButtonDefaults.itemShape(index, 2, SQUARE),
                            modifier = Modifier.testTag("variant-$value"),
                        ) { Text(label) }
                    }
                }
                if (variant != shownVariant) Help("The app is showing the $shownVariant variant; the preview shows the $variant one.")
                val colours = ThemeEdits.colours(theme, variant)
                // A theme missing a token (only one stored by a newer or broken build) is not checked.
                val checked = catalogue.tokens.all { it.key in colours }
                val problems = remember(colours) { if (checked) Contrast.problems(colours) else emptyList() }
                ContrastSummary(problems, variant, checked)
                for (group in catalogue.groups) {
                    GroupTitle(group.label)
                    for (token in catalogue.tokens.filter { it.group == group.id }) {
                        val hex = colours[token.key] ?: continue
                        val failing = problems.filter { token.key in it.tokens }
                        ColourRow(token.key, token.label, hex, failing, enabled) { editing = token.key }
                    }
                }
                GroupTitle("Type and layout")
                for ((key, label) in FONT_FIELDS) {
                    FontField(key, label, ThemeEdits.font(theme, key), catalogue.fonts, enabled) { edit(ThemeEdits.withFont(theme, key, it)) }
                }
                WidthField(ThemeEdits.width(theme), catalogue.width, enabled) { edit(ThemeEdits.withWidth(theme, it)) }
            }
        }
        val key = editing
        if (key != null) {
            val colours = ThemeEdits.colours(theme, variant)
            val label = catalogue.tokens.firstOrNull { it.key == key }?.label ?: key
            val names = catalogue.tokens.associate { it.key to it.label }
            ColourSheet(
                label = label,
                initial = colours[key] ?: "#000000",
                quickPicks = colours.entries.groupBy({ it.value }, { names[it.key] ?: it.key }).map { (hex, tokens) -> QuickPick(hex, tokens) },
                onDismiss = { editing = null },
                onPick = { hex ->
                    editing = null
                    edit(ThemeEdits.withColour(theme, variant, key, hex))
                },
            )
        }
        if (confirmDelete) {
            AlertDialog(
                onDismissRequest = { confirmDelete = false },
                title = { Text("Delete “${theme.text("name")}” on every device?") },
                text = { Text("Devices showing it go back to the theme it was based on.") },
                confirmButton = {
                    TextButton(
                        onClick = {
                            confirmDelete = false
                            dirty = false
                            onDelete(theme)
                        },
                        modifier = Modifier.testTag("confirmDelete"),
                    ) { Text("Delete Theme", color = MaterialTheme.colorScheme.error) }
                },
                dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Keep It") } },
            )
        }
    }
}

private val PREVIEW_HEIGHT = 220.dp

private val FONT_FIELDS = listOf("ui" to "Interface Font", "body" to "Note Font", "mono" to "Code Font")

private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** A theme needs a name: while the field is empty the last one is kept, as the web keeps it. */
@Composable
private fun NameField(theme: JsonObject, otherNames: List<String>, enabled: Boolean, onName: (String) -> Unit) {
    var text by rememberSaveable(theme.text("id")) { mutableStateOf(theme.text("name").orEmpty()) }
    val blank = text.isBlank()
    val taken = !blank && text.trim() in otherNames
    OutlinedTextField(
        value = text,
        onValueChange = {
            text = it.take(ThemeEdits.NAME_MAX)
            if (text.isNotBlank()) onName(text)
        },
        label = { Text("Name") },
        singleLine = true,
        enabled = enabled,
        isError = blank || taken,
        supportingText = {
            when {
                blank -> Text("A theme needs a name; until it has one, it keeps the last.")
                taken -> Text("Another theme has this name.")
            }
        },
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words),
        modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp).testTag("themeName"),
    )
}

/** What the contrast check found in this variant: nothing, or the pairs below WCAG AA (advice only). */
@Composable
private fun ContrastSummary(problems: List<ContrastCheck>, variant: String, checked: Boolean) {
    var all by rememberSaveable { mutableStateOf(false) }
    val text = if (!checked) {
        "The $variant variant lacks colours this version of Penmoss knows, so its contrast is not checked."
    } else if (problems.isEmpty()) {
        "Every text and icon colour in the $variant variant passes WCAG AA."
    } else {
        "${problems.size} colour ${if (problems.size == 1) "pair is" else "pairs are"} below WCAG AA in the $variant variant: " +
            problems.take(if (all) problems.size else 4).joinToString("; ") { "${it.label} (${ratio(it.ratio)})" } +
            if (problems.size > 4 && !all) "; …" else "."
    }
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        Text(
            text,
            Modifier.semantics { liveRegion = LiveRegionMode.Polite }.testTag("themeContrast"),
            style = MaterialTheme.typography.bodyMedium,
            color = if (problems.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
        )
        if (problems.size > 4) {
            TextButton(onClick = { all = !all }, Modifier.testTag("contrastAll")) { Text(if (all) "Show Fewer" else "Show All ${problems.size}") }
        }
    }
}

private fun ratio(value: Double) = String.format(Locale.ROOT, "%.1f:1", value)

private fun colourOf(hex: String): Color = Color(0xFF000000 or hex.removePrefix("#").toLong(16))

/** One colour token: its name, a swatch, its hex, and a warning when a pair it makes fails. */
@Composable
private fun ColourRow(key: String, label: String, hex: String, failing: List<ContrastCheck>, enabled: Boolean, onOpen: () -> Unit) {
    ListItem(
        headlineContent = { Text(label) },
        supportingContent = {
            Text(
                if (failing.isEmpty()) hex else "$hex · below WCAG AA: ${failing.first().label} (${ratio(failing.first().ratio)})",
                fontFamily = if (failing.isEmpty()) FontFamily.Monospace else null,
                color = if (failing.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
            )
        },
        leadingContent = {
            Box(Modifier.size(32.dp).background(colourOf(hex), CircleShape).border(1.dp, MaterialTheme.colorScheme.outline, CircleShape))
        },
        trailingContent = if (failing.isNotEmpty()) {
            { Icon(Icons.Default.Warning, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("warn-$key")) }
        } else {
            null
        },
        modifier = Modifier.testTag("colour-$key").clickable(enabled = enabled, onClickLabel = "Change $label", onClick = onOpen),
    )
}

/** A font: the web's choices by name, and the theme's own stack when it is none of them. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FontField(key: String, label: String, stack: String, fonts: List<ThemeCatalogue.Font>, enabled: Boolean, onFont: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val choices = if (fonts.any { it.stack == stack } || stack.isEmpty()) fonts else listOf(ThemeCatalogue.Font(stack, stack)) + fonts
    val shown = choices.firstOrNull { it.stack == stack }?.label ?: stack
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { if (enabled) open = it }, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
        OutlinedTextField(
            value = shown,
            onValueChange = {},
            readOnly = true,
            enabled = enabled,
            label = { Text(label) },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
            modifier = Modifier.fillMaxWidth().menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable, enabled).testTag("font-$key"),
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (font in choices) {
                DropdownMenuItem(
                    text = { Text(font.label) },
                    onClick = {
                        open = false
                        onFont(font.stack)
                    },
                    modifier = Modifier.testTag("fontChoice-$key-${font.label}"),
                )
            }
        }
    }
}

@Composable
private fun WidthField(rem: Int, range: IntRange, enabled: Boolean, onWidth: (Int) -> Unit) {
    var value by remember(rem) { mutableStateOf(rem.toFloat()) }
    Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
        Text("Note width: ${value.toInt()} rem", Modifier.clearAndSetSemantics {}, style = MaterialTheme.typography.bodyLarge)
        Slider(
            value = value,
            onValueChange = { value = it },
            onValueChangeFinished = { onWidth(value.toInt()) },
            valueRange = range.first.toFloat()..range.last.toFloat(),
            steps = range.last - range.first - 1,
            enabled = enabled,
            modifier = Modifier.semantics { contentDescription = "Note width"; stateDescription = "${value.toInt()} rem" }.testTag("themeWidth"),
        )
    }
}

/**
 * A colour, picked in a sheet (A417): a saturation and brightness square over the hue, hue,
 * saturation and brightness sliders (which TalkBack can move), the hex code, and the theme's
 * other colours to reuse. The change is applied with Use colour.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun ColourSheet(label: String, initial: String, quickPicks: List<QuickPick>, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    val start = remember(initial) { Colour.hsv(initial) }
    // Kept across a rotation or the app being restarted, as the sheet is (A417).
    var hue by rememberSaveable(initial) { mutableStateOf(start.first) }
    var saturation by rememberSaveable(initial) { mutableStateOf(start.second) }
    var value by rememberSaveable(initial) { mutableStateOf(start.third) }
    var hexText by rememberSaveable(initial) { mutableStateOf(initial) }
    val current = Colour.fromHsv(hue, saturation, value)
    fun setHex(hex: String) {
        val (h, s, v) = Colour.hsv(hex)
        // A grey has no hue of its own: keep the one shown.
        if (s > 0f) hue = h
        saturation = s
        value = v
        hexText = hex
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).navigationBarsPadding().imePadding().testTag("colourSheet")) {
            Text(label, style = MaterialTheme.typography.titleMedium)
            Row(Modifier.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.size(40.dp).background(colourOf(initial), RectangleShape).border(1.dp, MaterialTheme.colorScheme.outline, RectangleShape))
                Text("→")
                Box(Modifier.size(40.dp).background(colourOf(current), RectangleShape).border(1.dp, MaterialTheme.colorScheme.outline, RectangleShape).testTag("colourNew"))
                Text(current, fontFamily = FontFamily.Monospace)
            }
            SaturationValueSquare(hue, saturation, value) { s, v ->
                saturation = s
                value = v
                hexText = Colour.fromHsv(hue, s, v)
            }
            SheetSlider("Hue", hue, 0f..360f, "${hue.toInt()}°") {
                hue = it
                hexText = Colour.fromHsv(it, saturation, value)
            }
            SheetSlider("Saturation", saturation, 0f..1f, "${(saturation * 100).toInt()}%") {
                saturation = it
                hexText = Colour.fromHsv(hue, it, value)
            }
            SheetSlider("Brightness", value, 0f..1f, "${(value * 100).toInt()}%") {
                value = it
                hexText = Colour.fromHsv(hue, saturation, it)
            }
            OutlinedTextField(
                value = hexText,
                onValueChange = {
                    val text = it.trim().take(7)
                    hexText = text
                    if (Colour.isHex(text)) setHex(text.lowercase())
                },
                label = { Text("Hex") },
                singleLine = true,
                isError = !Colour.isHex(hexText),
                supportingText = { if (!Colour.isHex(hexText)) Text("A colour is # and six hex digits, like #2e3440.") },
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp).testTag("colourHex"),
            )
            Text("This theme’s colours", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.labelLarge)
            FlowRow(Modifier.padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (pick in quickPicks) {
                    val chosen = pick.hex == current
                    Surface(
                        onClick = { setHex(pick.hex) },
                        shape = CircleShape,
                        color = colourOf(pick.hex),
                        border = BorderStroke(if (chosen) 3.dp else 1.dp, if (chosen) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline),
                        modifier = Modifier.size(32.dp).semantics {
                            contentDescription = "${pick.tokens.joinToString(", ")}: ${pick.hex}"
                            selected = chosen
                        }.testTag("pick-${pick.hex}"),
                    ) {}
                }
            }
            Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onDismiss) { Text("Cancel") }
                Button(onClick = { onPick(current) }, enabled = Colour.isHex(hexText), modifier = Modifier.testTag("useColour")) { Text("Use Colour") }
            }
        }
    }
}

@Composable
private fun SheetSlider(label: String, value: Float, range: ClosedFloatingPointRange<Float>, state: String, onChange: (Float) -> Unit) {
    Column {
        // Seen, not read: the slider says its name and value itself.
        Text("$label: $state", Modifier.clearAndSetSemantics {}, style = MaterialTheme.typography.bodyMedium)
        Slider(
            value = value,
            onValueChange = onChange,
            valueRange = range,
            modifier = Modifier.semantics { contentDescription = label; stateDescription = state }.testTag("slider-$label"),
        )
    }
}

/** A colour the sheet offers to reuse, and the tokens of this variant that have it. */
internal data class QuickPick(val hex: String, val tokens: List<String>)

/** Saturation across and brightness down, over the hue: a tap or a drag picks both. */
@Composable
private fun SaturationValueSquare(hue: Float, saturation: Float, value: Float, onChange: (Float, Float) -> Unit) {
    val pure = colourOf(Colour.fromHsv(hue, 1f, 1f))
    fun pick(offset: Offset, width: Float, height: Float) =
        onChange((offset.x / width).coerceIn(0f, 1f), 1f - (offset.y / height).coerceIn(0f, 1f))
    Canvas(
        Modifier
            .fillMaxWidth()
            .height(160.dp)
            .padding(vertical = 8.dp)
            .pointerInput(hue) { detectTapGestures { pick(it, size.width.toFloat(), size.height.toFloat()) } }
            .pointerInput(hue) { detectDragGestures { change, _ -> pick(change.position, size.width.toFloat(), size.height.toFloat()) } }
            .semantics {
                contentDescription = "Saturation and brightness"
                stateDescription = "Saturation ${(saturation * 100).toInt()}%, brightness ${(value * 100).toInt()}%"
            }
            .testTag("colourSquare"),
    ) {
        drawRect(Brush.horizontalGradient(listOf(Color.White, pure)))
        drawRect(Brush.verticalGradient(listOf(Color.Transparent, Color.Black)))
        val at = Offset(saturation * size.width, (1f - value) * size.height)
        drawCircle(Color.White, radius = 10.dp.toPx(), center = at, style = androidx.compose.ui.graphics.drawscope.Stroke(3.dp.toPx()))
        drawCircle(Color.Black, radius = 12.dp.toPx(), center = at, style = androidx.compose.ui.graphics.drawscope.Stroke(1.dp.toPx()))
    }
}
