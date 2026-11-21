package app.penmoss.analytics

import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.semantics.semantics

/** A field whose typed length is recorded, in the semantics tree (`dialog.field`), for the tests. */
val TypedLengthOf = SemanticsPropertyKey<String>("TypedLengthOf")
private var SemanticsPropertyReceiver.typedLengthOf by TypedLengthOf

/**
 * How long what is typed in one field is (PEN-177), the twin of the web's `useTypedLength`:
 * `input <dialog>` with the [field] and its length in characters, never its text, once typing
 * has paused for [SessionDetail.INPUT_SETTLE_MS]; at once when the field closes or loses focus
 * with a change waiting. A length equal to the last recorded is dropped, and the length the field
 * opened with counts as recorded, so opening it records nothing. Its settling is core's, through
 * [SettleGate] (scroll-v1.json pins the rules).
 */
class TypedLength(
    private val dialog: String,
    private val field: String,
    start: Int,
    clock: ScrollClock = ScrollClock.main(),
    private val record: (dialog: String, field: String, chars: Int) -> Unit = { name, which, chars ->
        Analytics.record("input", name, mapOf("field" to which, "chars" to chars))
    },
) {
    private val gate = SettleGate<Int>(
        { chars -> record(dialog, field, SessionDetail.clampUsage("chars", chars)) },
        clock,
        settleMs = SessionDetail.INPUT_SETTLE_MS,
        gapMs = 0,
        start = start,
    )

    /** The field now holds [length] characters. */
    fun typed(length: Int) = gate.moved(length)

    /** The field closed or lost focus: what waits is recorded now. */
    fun flush() = gate.flush()
}

/**
 * Records the length typed in this text field as `input <dialog>` (PEN-177): [dialog] is the
 * tracked dialog it is in (a catalogue name, or `settingsSearch`), [field] what it is for (`query`,
 * `name`, `title`, `body`, `url` or `other`), and [text] what it holds now. Never its text.
 * `ControlScan` checks that every text field in a tracked dialog has one.
 */
fun Modifier.typedLength(dialog: String, field: String, text: String): Modifier = composed {
    val typed = remember(dialog, field) { TypedLength(dialog, field, text.length) }
    LaunchedEffect(typed, text) { typed.typed(text.length) }
    DisposableEffect(typed) { onDispose { typed.flush() } }
    semantics { typedLengthOf = "$dialog.$field" }.onFocusChanged { state -> if (!state.isFocused) typed.flush() }
}
