package app.penmoss.ui.common

import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import app.penmoss.analytics.trackedToggle

/**
 * A switch as a whole row, so TalkBack reads one control with its name: every switch row in the
 * app, so they never drift. [event] is its catalogue id, recorded with the state it goes to
 * ([trackedToggle]); null only where [onChange] records the use itself. [headline] draws [label]
 * (Settings' `DeviceOnlyHeadline` adds the laptop after it).
 */
@Composable
fun Toggle(
    label: String,
    supporting: String?,
    on: Boolean,
    enabled: Boolean,
    tag: String,
    modifier: Modifier = Modifier,
    event: String?,
    headline: @Composable (String) -> Unit = { Text(it) },
    onChange: (Boolean) -> Unit,
) {
    ListItem(
        headlineContent = { headline(label) },
        supportingContent = supporting?.let { { Text(it, style = MaterialTheme.roles.help) } },
        trailingContent = { Switch(checked = on, onCheckedChange = null, enabled = enabled) },
        modifier = modifier.testTag(tag).toggleable(
            value = on,
            enabled = enabled,
            role = Role.Switch,
            onValueChange = if (event != null) trackedToggle(event, onChange) else onChange,
        ),
    )
}
