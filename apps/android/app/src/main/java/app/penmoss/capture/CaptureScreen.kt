package app.penmoss.capture

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectableGroup
import app.penmoss.ui.square.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import app.penmoss.engine.api.CaptureRequest

/** What the capture sheet shows. */
/** A git notebook a capture can go to (A888, A1040), by its local id. */
data class CaptureNotebook(val key: String, val name: String) {
    companion object {
        /**
         * Where the sheet starts (A888): the Journal notebook when the person picked one, else the
         * only notebook there is. With several git notebooks and none picked: none, and the sheet
         * asks (never the first, silently).
         */
        fun start(picked: String?, options: List<CaptureNotebook>): String? {
            val keys = options.map { it.key }
            return when {
                picked != null && picked in keys -> picked
                options.size == 1 -> options.single().key
                else -> null
            }
        }
    }
}

/** What the sheet says with no git notebook on the phone (A1040). */
internal const val NO_NOTEBOOK = "Add a git notebook in Penmoss first."

data class CaptureUi(
    val text: String = "",
    val pictures: Int = 0,
    val destination: String = CaptureRequest.DAILY,
    /** A git notebook is on the phone to capture to (A1040); with none, the sheet says to add one. */
    val hasNotebook: Boolean = true,
    /** Where it can go; with more than one, the sheet names the one chosen and lets the person change it. */
    val notebooks: List<CaptureNotebook> = emptyList(),
    /** The notebook chosen ([CaptureNotebook.key]); null: none yet, and Save waits for one. */
    val notebook: String? = null,
    val busy: Boolean = false,
    val message: String? = null,
    /** Asking whether to throw away text typed here (T39 pass 2, A528). */
    val discarding: Boolean = false,
)

/**
 * The capture sheet (T34, A340): over the app it was opened from, the text to
 * save with the keyboard up, the destination the web and Mac apps use (today's
 * note, or a new note in Inbox), and Save. Tapping outside or Back cancels; text
 * typed here is thrown away only once confirmed (A528).
 *
 * On a short screen (a phone on its side) the sheet is one row: the text, the
 * destination, Cancel and Save, so they fit above the keyboard (A529). The choice
 * follows the screen, not the room left by the keyboard: switching layouts as the
 * keyboard opened would take the focus, and close the keyboard again. The sheet stays
 * clear of the status bar and the camera cutout.
 */
@Composable
fun CaptureScreen(
    ui: CaptureUi,
    onText: (String) -> Unit,
    onDestination: (String) -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit,
    onOpenApp: () -> Unit,
    onKeepEditing: () -> Unit = {},
    onDiscard: () -> Unit = onCancel,
    onNotebook: (String) -> Unit = {},
) {
    val focus = remember { FocusRequester() }
    BackHandler(onBack = onCancel)
    val screen = LocalConfiguration.current
    val short = screen.screenHeightDp < SHORT_SCREEN_DP && screen.screenWidthDp >= ROW_SCREEN_DP
    Box(
        // Tapping outside the sheet cancels, as a dialog. A tap gesture, not a clickable: one would
        // make the whole sheet a single button to TalkBack, hiding its fields and buttons.
        Modifier
            .fillMaxSize()
            .pointerInput(onCancel) { detectTapGestures { onCancel() } }
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
            .imePadding(),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Surface(
            // Taps on the sheet itself stay on it.
            Modifier.fillMaxWidth().widthIn(max = if (short) 960.dp else 640.dp).pointerInput(Unit) { detectTapGestures {} },
            shape = MaterialTheme.shapes.extraLarge,
            tonalElevation = 6.dp,
            shadowElevation = 8.dp,
        ) {
            if (short && ui.hasNotebook) {
                ShortSheet(ui, focus, onText, onDestination, onSave, onCancel, onNotebook)
                return@Surface
            }
            Column(
                Modifier.padding(20.dp).navigationBarsPadding(),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text("Capture to Penmoss", style = MaterialTheme.typography.titleMedium)
                if (!ui.hasNotebook) {
                    Text(NO_NOTEBOOK, style = MaterialTheme.typography.bodyMedium)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        TextButton(onClick = onCancel) { Text("Cancel") }
                        Button(onClick = onOpenApp, Modifier.testTag("captureOpenApp")) { Text("Open Penmoss") }
                    }
                    return@Column
                }
                // The field gives way first when the screen is short (the keyboard up, a small phone),
                // so Save and the message above it always stay on screen; never below one line.
                OutlinedTextField(
                    value = ui.text,
                    onValueChange = onText,
                    modifier = Modifier
                        .weight(1f, fill = false)
                        .heightIn(min = OutlinedTextFieldDefaults.MinHeight)
                        .fillMaxWidth()
                        .focusRequester(focus)
                        .testTag("captureText"),
                    placeholder = { Text("What’s on your mind?") },
                    minLines = 3,
                    maxLines = 10,
                    enabled = !ui.busy,
                )
                if (ui.pictures > 0) {
                    Text(
                        if (ui.pictures == 1) "1 picture" else "${ui.pictures} pictures",
                        Modifier.testTag("capturePictures"),
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                NotebookChoice(ui, onNotebook)
                Row(Modifier.selectableGroup(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Destinations(ui, onDestination)
                }
                ui.message?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                    CancelAndSave(ui, onSave, onCancel)
                }
            }
        }
    }
    if (ui.discarding) {
        AlertDialog(
            onDismissRequest = onKeepEditing,
            title = { Text("Discard this capture?") },
            text = { Text("What you typed here has not been saved.") },
            confirmButton = { TextButton(onClick = onDiscard, Modifier.testTag("captureDiscard")) { Text("Discard") } },
            dismissButton = { TextButton(onClick = onKeepEditing, Modifier.testTag("captureKeepEditing")) { Text("Keep Editing") } },
        )
    }
    // The keyboard comes up at once: a capture from the tile is typed straight away.
    LaunchedEffect(ui.hasNotebook) { if (ui.hasNotebook) runCatching { focus.requestFocus() } }
}

/** A screen less tall than this and at least [ROW_SCREEN_DP] wide (a phone on its side) has the sheet in one row (A529). */
internal const val SHORT_SCREEN_DP = 480

/** How wide a screen must be for the one-row sheet. */
internal const val ROW_SCREEN_DP = 600

/** The least width the text keeps in the short sheet's row. */
internal const val ROW_FIELD_DP = 200

/**
 * About how wide the two destinations, Cancel and Save are at the normal text size, with their
 * gaps. About a third of it is padding, which stays; the rest is text, which grows with the
 * text size.
 */
private const val ROW_CONTROLS_DP = 430f

/**
 * The sheet on a short screen (A529): one row, the text, where it goes, Cancel and Save, when
 * they fit beside text at least [ROW_FIELD_DP] wide. With large text or a narrower screen, the
 * text, Cancel and Save are one row and the destinations a second, scrolling sideways if need be.
 */
@Composable
private fun ShortSheet(
    ui: CaptureUi,
    focus: FocusRequester,
    onText: (String) -> Unit,
    onDestination: (String) -> Unit,
    onSave: () -> Unit,
    onCancel: () -> Unit,
    onNotebook: (String) -> Unit,
) {
    BoxWithConstraints(Modifier.padding(horizontal = 16.dp, vertical = 8.dp).navigationBarsPadding()) {
        val controls = (ROW_CONTROLS_DP * (0.35f + 0.65f * LocalDensity.current.fontScale)).dp
        val oneRow = maxWidth - controls >= ROW_FIELD_DP.dp
        // With large text and the keyboard up the second row can be below the keyboard: the sheet
        // scrolls to it, the text and Save staying first in view.
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(
                Modifier.fillMaxWidth().semantics { paneTitle = "Capture to Penmoss" },
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = ui.text,
                    onValueChange = onText,
                    modifier = Modifier.weight(1f).focusRequester(focus).testTag("captureText"),
                    placeholder = { Text("Capture to Penmoss") },
                    maxLines = 2,
                    enabled = !ui.busy,
                )
                if (oneRow) {
                    Row(Modifier.selectableGroup(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Destinations(ui, onDestination)
                    }
                }
                CancelAndSave(ui, onSave, onCancel)
            }
            NotebookChoice(ui, onNotebook)
            if (!oneRow) {
                Row(
                    Modifier.selectableGroup().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Destinations(ui, onDestination)
                }
            }
            if (ui.pictures > 0) {
                Text(
                    if (ui.pictures == 1) "1 picture" else "${ui.pictures} pictures",
                    Modifier.testTag("capturePictures"),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            ui.message?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

@Composable
private fun Destinations(ui: CaptureUi, onDestination: (String) -> Unit) {
    FilterChip(
        selected = ui.destination == CaptureRequest.DAILY,
        onClick = { onDestination(CaptureRequest.DAILY) },
        label = { Text("Today’s Note") },
        modifier = Modifier.testTag("captureDaily"),
        enabled = !ui.busy,
    )
    FilterChip(
        selected = ui.destination == CaptureRequest.INBOX,
        onClick = { onDestination(CaptureRequest.INBOX) },
        label = { Text("New Note in Inbox") },
        modifier = Modifier.testTag("captureInbox"),
        enabled = !ui.busy,
    )
}

/**
 * Which notebook the capture goes to (A888), shown whenever there is more than one: the chosen
 * one by name, a menu to change it, and "Choose a notebook" while none is chosen.
 */
@Composable
private fun NotebookChoice(ui: CaptureUi, onNotebook: (String) -> Unit) {
    if (ui.notebooks.size < 2) return
    var open by remember { mutableStateOf(false) }
    val chosen = ui.notebooks.firstOrNull { it.key == ui.notebook }
    Box {
        TextButton(
            onClick = { open = true },
            enabled = !ui.busy,
            modifier = Modifier.testTag("captureNotebook").semantics { stateDescription = chosen?.name ?: "none chosen" },
        ) {
            Text(
                if (chosen == null) "Choose a Notebook" else "Into ${chosen.name}",
                color = if (chosen == null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
            )
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            for (each in ui.notebooks) {
                DropdownMenuItem(
                    text = { Text(each.name) },
                    onClick = {
                        open = false
                        onNotebook(each.key)
                    },
                    modifier = Modifier.testTag("captureNotebook-${each.key}"),
                )
            }
        }
    }
}

@Composable
private fun CancelAndSave(ui: CaptureUi, onSave: () -> Unit, onCancel: () -> Unit) {
    TextButton(onClick = onCancel, enabled = !ui.busy) { Text("Cancel") }
    Button(
        onClick = onSave,
        enabled = !ui.busy && ui.notebook != null && (ui.text.isNotBlank() || ui.pictures > 0),
        modifier = Modifier.testTag("captureSave"),
    ) { Text(if (ui.busy) "Saving…" else "Save") }
}
