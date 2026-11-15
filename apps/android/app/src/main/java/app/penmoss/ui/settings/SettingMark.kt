package app.penmoss.ui.settings

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.SemanticsPropertyReceiver
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch

/**
 * Search Settings' mark (PEN-148), as the Mac's `[data-setting]`: a result names its row's id, and
 * the screen it opens scrolls to the row that carries that id ([settingRow]) and marks it for a
 * moment, a tint that fades. A row that is not there (a screen that draws it only with two
 * notebooks, say) leaves the screen at its top: the mark gives up after [WAIT_MS].
 */
@Stable
class SettingMark(private val now: () -> Long = { System.nanoTime() / 1_000_000 }) {
    /** The row a result opened, until its screen marks it. */
    var target: String? by mutableStateOf(null)
        private set

    private var until = 0L

    /** A result for [id] was chosen: its screen opens next. */
    fun request(id: String) {
        until = now() + WAIT_MS
        target = id
    }

    /** The row [id] takes the mark, once, if it is asked for and not given up on. */
    fun take(id: String): Boolean {
        if (target != id) return false
        target = null
        return now() <= until
    }

    companion object {
        /** How long a screen may take to draw the row before the mark gives up (the Mac's second or so). */
        const val WAIT_MS = 1_500L

        /** How long the row stays marked, then fades (the Mac's 2 s in all). */
        const val HOLD_MS = 1_200L
        const val FADE_MS = 800L
    }
}

/** The app's one mark: Search Settings asks, and the screen it opens answers. Tests give their own. */
private val APP_MARK = SettingMark()

val LocalSettingMark = staticCompositionLocalOf { APP_MARK }

/** Whether a row is marked now (for tests and TalkBack's tree): set while the mark shows. */
val SettingMarked = SemanticsPropertyKey<Boolean>("SettingMarked")
private var SemanticsPropertyReceiver.settingMarked by SettingMarked

/**
 * A setting's row, by the id Search Settings names it with ([SettingEntry.id], its label in kebab
 * case): when a result for it opened this screen, the screen scrolls to it and it is marked a
 * moment, its tint fading. Otherwise nothing changes.
 */
@OptIn(ExperimentalFoundationApi::class)
fun Modifier.settingRow(id: String): Modifier = composed {
    val mark = LocalSettingMark.current
    val requester = remember { BringIntoViewRequester() }
    val tint = remember { Animatable(0f) }
    var marked by remember { mutableStateOf(false) }
    var size by remember { mutableStateOf(IntSize.Zero) }
    val colour = MaterialTheme.colorScheme.primary
    val margin = with(LocalDensity.current) { 96.dp.toPx() }
    val stroke = with(LocalDensity.current) { 2.dp.toPx() }
    // Keyed on the row, not on the ask: taking the mark clears the ask, which must not stop it.
    LaunchedEffect(mark, id) {
        snapshotFlow { mark.target == id }.filter { it }.collect {
            if (!mark.take(id)) return@collect
            marked = true
            tint.snapTo(1f)
            // Laid out first, so the scroll knows where it is; with room around it, so it is not
            // left at the very edge of the screen. The scroll runs beside the mark, which fades on
            // its own time whatever the scroll does.
            withFrameNanos {}
            launch { runCatching { requester.bringIntoView(Rect(0f, -margin, size.width.toFloat(), size.height + margin)) } }
            delay(SettingMark.HOLD_MS)
            tint.animateTo(0f, tween(SettingMark.FADE_MS.toInt()))
            marked = false
        }
    }
    this
        .onSizeChanged { size = it }
        .bringIntoViewRequester(requester)
        .then(if (marked) Modifier.semantics { settingMarked = true } else Modifier)
        .drawWithContent {
            drawContent()
            val shown = tint.value
            if (shown > 0f) {
                drawRect(colour.copy(alpha = 0.14f * shown))
                drawRect(colour.copy(alpha = 0.6f * shown), style = Stroke(stroke))
            }
        }
}
