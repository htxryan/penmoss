package app.penmoss.analytics

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
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
 * command's run and needs no id.
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
