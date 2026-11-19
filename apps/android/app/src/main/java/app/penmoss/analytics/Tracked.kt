package app.penmoss.analytics

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.semantics.semantics

/** A tracked control's id in the semantics tree, so `TrackedControlsTest` can list them. */
val TrackedId = SemanticsPropertyKey<String>("TrackedId")
private var SemanticsPropertyReceiver.trackedId by TrackedId

/**
 * A control counted by name when it is used (PEN-137), as the web's `data-event`: [id] is a
 * catalogue id (`privacy.view-data`), never built from data. A tap on it is recorded without
 * taking the tap from the control. A control whose action is a command is counted by the
 * command's run and needs no id. Only for a control with no control inside it: a row's taps
 * include its buttons', so a row wraps its action in [trackedClick] instead.
 */
fun Modifier.tracked(id: String): Modifier = this
    .semantics { trackedId = id }
    .pointerInput(id) {
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val up = waitForUpOrCancellation(PointerEventPass.Initial)
            if (up != null) Analytics.click(id)
        }
    }

/** Marks a control as tracked without counting its taps here: its handler records ([trackedClick]). */
fun Modifier.trackedId(id: String): Modifier = semantics { trackedId = id }

/** [onClick], recorded as a use of [id] first (for buttons, keyboard and TalkBack alike). */
fun trackedClick(id: String, onClick: () -> Unit): () -> Unit = {
    Analytics.click(id)
    onClick()
}

/** A switch's or a check box's [onChange], recorded as a use of [id] with the state it goes to first. */
fun trackedToggle(id: String, onChange: (Boolean) -> Unit): (Boolean) -> Unit = { on ->
    Analytics.click(id, on)
    onChange(on)
}

/**
 * A dialog or sheet counted by name (PEN-137), the Compose twin of the web's `useTrackedDialog`:
 * `open` as it shows, then `done` or `cancel` as it leaves, with how long it was open (a bucket).
 * A dialog that does what it was opened for calls [done] before it closes; closing any other way
 * is a cancel.
 */
class TrackedDialog internal constructor() {
    @Volatile
    internal var finished = false

    /** The dialog did what it was opened for: its close records `done`. */
    fun done() {
        finished = true
    }

    /** [onClick], after which the dialog's close records `done`. */
    fun done(onClick: () -> Unit): () -> Unit = {
        finished = true
        onClick()
    }
}

/**
 * Tracks the dialog [name] (a catalogue name, never built from data) while [open]; a dialog
 * composed only while it shows leaves [open] out. Call it where the dialog is composed.
 */
@Composable
fun rememberTrackedDialog(name: String, open: Boolean = true): TrackedDialog {
    val dialog = remember(name) { TrackedDialog() }
    DisposableEffect(name, open) {
        if (!open) return@DisposableEffect onDispose {}
        dialog.finished = false
        val at = System.currentTimeMillis()
        Analytics.record("dialog", name, mapOf("action" to "open"))
        onDispose {
            Analytics.record(
                "dialog",
                name,
                mapOf("action" to if (dialog.finished) "done" else "cancel", "open" to AnalyticsFormat.durationBucket(System.currentTimeMillis() - at)),
            )
        }
    }
    return dialog
}
