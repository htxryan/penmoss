package app.penmoss.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/*
 * Sync state per notebook, as a dot (T51, A933): Home's status line became a dot on each source's
 * section title, in the state's colour, with the old words as its content description and, on a
 * tap or long press, its tooltip. A stopped dot still leads to what resolves it.
 */

/** What a dot shows: the accent synced, pulsing while syncing, muted offline or not yet, red stopped. */
enum class DotState { SYNCED, SYNCING, OFFLINE, IDLE, STOPPED }

/**
 * How a dot is drawn (T52 item 11), so its state never rests on colour alone beside the accent
 * name (the accent and the error colour are near alike in luminance in some themes): a solid dot
 * synced or syncing, a hollow ring offline or not yet synced, a dot in a ring (a bullseye) stopped.
 */
enum class DotMark { SOLID, RING, BULLSEYE }

/** The web's marks for each state (`sources.css`). */
fun DotState.mark(): DotMark = when (this) {
    DotState.SYNCED, DotState.SYNCING -> DotMark.SOLID
    DotState.OFFLINE, DotState.IDLE -> DotMark.RING
    DotState.STOPPED -> DotMark.BULLSEYE
}

/** A source's dot: its state, its words, and (stopped) the way to what resolves it. */
data class SyncDot(val state: DotState, val words: String, val onStopped: (() -> Unit)? = null)

/** The dot itself, at a full touch target: a tap says its words, or (stopped) opens what resolves it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SyncStateDot(dot: SyncDot, modifier: Modifier = Modifier) {
    val colours = MaterialTheme.colorScheme
    val colour = when (dot.state) {
        DotState.SYNCED, DotState.SYNCING -> colours.primary
        DotState.OFFLINE, DotState.IDLE -> colours.onSurfaceVariant
        DotState.STOPPED -> colours.error
    }
    // Only a syncing dot pulses: an idle one runs no animation, so it draws no frames.
    val alpha = if (dot.state == DotState.SYNCING) {
        val pulse by rememberInfiniteTransition(label = "syncDot").animateFloat(
            initialValue = 1f,
            targetValue = 0.3f,
            animationSpec = infiniteRepeatable(tween(700, easing = LinearEasing), RepeatMode.Reverse),
            label = "syncDotPulse",
        )
        pulse
    } else {
        1f
    }
    val tip = rememberTooltipState()
    val scope = rememberCoroutineScope()
    TooltipBox(
        positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Below),
        tooltip = { PlainTooltip { Text(dot.words, Modifier.testTag("syncDotTip")) } },
        state = tip,
    ) {
        Box(
            modifier
                .minimumInteractiveComponentSize()
                .clickable(onClickLabel = if (dot.onStopped != null) "Open Sync and Storage" else "Show Sync State") {
                    val stopped = dot.onStopped
                    if (stopped != null) stopped() else scope.launch { tip.show() }
                }
                .semantics {
                    contentDescription = dot.words
                    role = Role.Button
                },
            contentAlignment = Alignment.Center,
        ) {
            val shape = Modifier
                .size(DOT_SIZE)
                .alpha(alpha)
                .testTag("syncDotMark")
            when (dot.state.mark()) {
                DotMark.SOLID -> Box(shape.background(colour, CircleShape))
                DotMark.RING -> Box(shape.border(RING_WIDTH, colour, CircleShape))
                // A ring, a clear gap, and a dot inside.
                DotMark.BULLSEYE -> Box(shape.border(RING_WIDTH, colour, CircleShape).padding(RING_WIDTH * 2)) {
                    Box(Modifier.fillMaxSize().background(colour, CircleShape))
                }
            }
        }
    }
}

private val DOT_SIZE = 10.dp
private val RING_WIDTH = 1.5.dp

/** A section title with its source's dot at the row's far right (A933, A979). */
@Composable
fun SectionTitleWithDot(text: String, dot: SyncDot, modifier: Modifier = Modifier, dotTag: String = "syncDot") {
    Row(modifier.padding(start = 16.dp, end = 4.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        // The name takes the row, so the dot sits at its far right, as on the web (A979).
        Text(
            text,
            Modifier.weight(1f).semantics { heading() },
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.primary,
        )
        SyncStateDot(dot, Modifier.testTag(dotTag))
    }
}
