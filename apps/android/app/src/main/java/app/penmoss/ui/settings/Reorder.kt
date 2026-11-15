package app.penmoss.ui.settings

import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex

/**
 * Where a row dragged by [offset] pixels from [from] lands among rows of [heights] (PEN-146): past
 * half of a neighbour's height, it takes that neighbour's place.
 */
internal fun dropIndex(from: Int, offset: Float, heights: List<Int>): Int {
    var to = from
    var left = offset
    if (left > 0) {
        while (to + 1 < heights.size && left > heights[to + 1] / 2f) {
            left -= heights[to + 1]
            to++
        }
    } else {
        while (to - 1 >= 0 && -left > heights[to - 1] / 2f) {
            left += heights[to - 1]
            to--
        }
    }
    return to
}

/** [list] with the item at [from] moved to [to]. */
internal fun <T> List<T>.movedTo(from: Int, to: Int): List<T> =
    if (from == to || from !in indices) this else toMutableList().also { it.add(to.coerceIn(0, lastIndex), it.removeAt(from)) }

/**
 * A column of rows the person reorders by dragging each row's handle (PEN-146: Home's sections,
 * Symbols), dropped where it is let go. TalkBack and Switch Access move a row with its Move Up and
 * Move Down actions instead. [row] draws one row, placing [handle] where its grip goes.
 */
@Composable
internal fun <T> ReorderableColumn(
    items: List<T>,
    key: (T) -> String,
    name: (T) -> String,
    enabled: Boolean,
    onMove: (from: Int, to: Int) -> Unit,
    modifier: Modifier = Modifier,
    row: @Composable (item: T, index: Int, handle: @Composable () -> Unit) -> Unit,
) {
    val heights = remember { mutableStateMapOf<String, Int>() }
    var dragging by remember { mutableStateOf<String?>(null) }
    var offset by remember { mutableFloatStateOf(0f) }
    val shown by rememberUpdatedState(items)
    val move by rememberUpdatedState(onMove)
    Column(modifier) {
        items.forEachIndexed { index, item ->
            val id = key(item)
            key(id) {
                val lifted = dragging == id
                Box(
                    Modifier
                        .onSizeChanged { heights[id] = it.height }
                        .zIndex(if (lifted) 1f else 0f)
                        .graphicsLayer { translationY = if (lifted) offset else 0f }
                        .semantics {
                            if (enabled) {
                                customActions = buildList {
                                    if (index > 0) add(CustomAccessibilityAction("Move Up") { move(index, index - 1); true })
                                    if (index < items.lastIndex) add(CustomAccessibilityAction("Move Down") { move(index, index + 1); true })
                                }
                            }
                        },
                ) {
                    row(item, index) {
                        Box(
                            Modifier
                                .size(40.dp)
                                .testTag("drag-$id")
                                .then(
                                    if (!enabled) Modifier else Modifier.pointerInput(id) {
                                        detectVerticalDragGestures(
                                            onDragStart = {
                                                dragging = id
                                                offset = 0f
                                            },
                                            onDragEnd = {
                                                val from = shown.indexOfFirst { key(it) == id }
                                                val to = if (from < 0) from else dropIndex(from, offset, shown.map { heights[key(it)] ?: 0 })
                                                dragging = null
                                                offset = 0f
                                                if (from >= 0 && to != from) move(from, to)
                                            },
                                            onDragCancel = {
                                                dragging = null
                                                offset = 0f
                                            },
                                            onVerticalDrag = { change, dy ->
                                                change.consume()
                                                offset += dy
                                            },
                                        )
                                    },
                                ),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(SettingsIcons.Drag, contentDescription = "Drag to Move ${name(item)}", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
        }
    }
}
