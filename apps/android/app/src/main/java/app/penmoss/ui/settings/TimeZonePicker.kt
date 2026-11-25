package app.penmoss.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.input.ImeAction
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.ui.common.IconButton
import app.penmoss.ui.common.BackButton

/** The time zones offered: the region zones the web offers (`Intl`), and UTC. */
fun regionTimeZones(available: Set<String> = java.time.ZoneId.getAvailableZoneIds()): List<String> =
    (available.filter { REGION.matches(it) } + "UTC").distinct().sorted()

private val REGION = Regex("^(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)/[A-Za-z0-9_+\\-/]+$")

/** What a search for a zone finds: every word typed, in any order, spaces matching underscores. */
fun matchingZones(zones: List<String>, query: String): List<String> {
    val words = query.trim().lowercase().replace('_', ' ').split(Regex("[\\s/]+")).filter { it.isNotEmpty() }
    if (words.isEmpty()) return zones
    return zones.filter { zone -> val name = zone.lowercase().replace('_', ' '); words.all { it in name } }
}

/**
 * The time-zone picker (ST6): a searchable list, the current zone first, and this phone's own
 * zone one tap away when it differs.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimeZonePicker(current: String, phoneZone: String, zones: List<String>, onPick: (String) -> Unit, onBack: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val shown = remember(query, zones, current) { matchingZones(listOf(current) + (zones - current), query) }
    // The web's time-zone picker is a dialog; here it is a screen, counted by the same name.
    val tracked = rememberTrackedDialog("timeZone")
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { BackButton(onBack) },
                title = {
                    TextField(
                        value = query,
                        onValueChange = { query = it },
                        modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("zoneSearch"),
                        placeholder = { Text("Search Time Zones") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        trailingIcon = {
                            if (query.isNotEmpty()) IconButton(onClick = trackedClick("settings.journal.time-zone.clear") { query = "" }) { Icon(Icons.Default.Close, contentDescription = "Clear") }
                        },
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = Color.Transparent,
                            unfocusedContainerColor = Color.Transparent,
                            focusedIndicatorColor = MaterialTheme.colorScheme.primary,
                            unfocusedIndicatorColor = Color.Transparent,
                        ),
                    )
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            // A button above the list, not one of its choices: the list is the radio group.
            if (phoneZone != current && query.isBlank()) {
                ListItem(
                    headlineContent = { Text("Use This Phone’s Zone") },
                    supportingContent = { Text(phoneZone) },
                    modifier = Modifier.testTag("usePhoneZone").clickable(role = Role.Button, onClick = trackedClick("settings.journal.time-zone.use-phone-zone", tracked.done { onPick(phoneZone) })),
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
                )
            }
            LazyColumn(Modifier.fillMaxSize().selectableGroup().testTag("zones")) {
                if (shown.isEmpty()) item(key = "none") { Help("No time zone matches.") }
                items(shown, key = { it }) { zone ->
                    ListItem(
                        headlineContent = { Text(zone.replace('_', ' ')) },
                        trailingContent = if (zone == current) ({ Icon(Icons.Default.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary) }) else null,
                        modifier = Modifier.testTag("zone-$zone").selectable(selected = zone == current, role = Role.RadioButton, onClick = trackedClick("settings.journal.time-zone.pick", tracked.done { onPick(zone) })),
                    )
                }
            }
        }
    }
}
