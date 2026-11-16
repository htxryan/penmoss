package app.penmoss.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/** What the laptop mark says, as the Mac's does with "this Mac" (A1559). */
const val DEVICE_ONLY_TIP = "Unlike other settings, this setting is kept only on this phone and isn’t synced through your primary notebook."

/**
 * A setting kept on this phone alone (A1559), as the Mac's: the laptop, its sentence a tooltip on
 * a long press and its content description.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DeviceOnlyMark(modifier: Modifier = Modifier) {
    TooltipBox(
        positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above),
        tooltip = { PlainTooltip { Text(DEVICE_ONLY_TIP) } },
        state = rememberTooltipState(),
    ) {
        Icon(
            SettingsIcons.Laptop,
            contentDescription = DEVICE_ONLY_TIP,
            modifier = modifier.size(18.dp).testTag("deviceOnly"),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** A row's headline with the laptop mark after it. */
@Composable
internal fun DeviceOnlyHeadline(text: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text)
        DeviceOnlyMark()
    }
}

/** What the phone mark says (PEN-156, A1605): kept for the phones, apart from the Macs. */
const val PLATFORM_TIP = "This setting is kept for your Android phones only. Your Macs keep their own."

/** What the phone mark says after a group's title. */
const val PLATFORM_GROUP_TIP = "These settings are kept for your Android phones only. Your Macs keep their own."

/**
 * A setting every phone shares and the Macs keep apart (PEN-156, A1605), as the laptop marks one
 * kept on this phone alone (A1559): the phone, its sentence a tooltip on a long press and its
 * content description.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun PlatformMark(modifier: Modifier = Modifier, many: Boolean = false) {
    val tip = if (many) PLATFORM_GROUP_TIP else PLATFORM_TIP
    TooltipBox(
        positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above),
        tooltip = { PlainTooltip { Text(tip) } },
        state = rememberTooltipState(),
    ) {
        Icon(
            SettingsIcons.Phone,
            contentDescription = tip,
            modifier = modifier.size(18.dp).testTag("platformOnly"),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** A title with the phone mark after it: a screen's, or a group's ([many]). */
@Composable
internal fun PlatformHeadline(text: String, many: Boolean = false) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text)
        PlatformMark(many = many)
    }
}
