package app.penmoss.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import app.penmoss.ui.square.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.clearAndSetSemantics

/**
 * An icon-only button with its name as its content description and, on a long press, as a
 * tooltip (T51, A932, A936): the phone's form of the web's `data-tip` buttons. [badge], when
 * above zero, is a count on the icon (the open comment threads), said after the name.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TipIconButton(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    tint: Color = Color.Unspecified,
    badge: Int = 0,
) {
    val said = if (badge > 0) "$label, $badge open" else label
    TooltipBox(
        positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Below),
        tooltip = { PlainTooltip { Text(label) } },
        state = rememberTooltipState(),
    ) {
        IconButton(onClick = onClick, enabled = enabled, modifier = modifier) {
            val drawn = @Composable {
                Icon(icon, contentDescription = said, tint = if (tint == Color.Unspecified) LocalContentColor.current else tint)
            }
            if (badge > 0) {
                BadgedBox(badge = { Badge(Modifier.clearAndSetSemantics {}) { Text(if (badge > 99) "99+" else "$badge") } }) { drawn() }
            } else {
                Box { drawn() }
            }
        }
    }
}
