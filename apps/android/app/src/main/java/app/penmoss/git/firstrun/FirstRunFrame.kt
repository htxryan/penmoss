package app.penmoss.git.firstrun

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.penmoss.ui.common.Button
import app.penmoss.ui.common.OutlinedButton
import app.penmoss.ui.common.TextButton
import app.penmoss.ui.common.LucideAssets
import app.penmoss.ui.common.rememberLucideIcons
import app.penmoss.ui.common.roles

/**
 * One screen of the first run (A1404): the "Step n of 3" bar, the screen's title, what it asks,
 * and a footer with Back (or Cancel) on the left and its buttons on the right. The Mac's is
 * `FirstRunFrame.tsx`.
 */
@Composable
internal fun Frame(
    name: String,
    title: String,
    step: Int? = null,
    back: (() -> Unit)? = null,
    /** Cancel in Back's place: the flow's first screen when Add Notebook opened it (A1562). */
    cancel: (() -> Unit)? = null,
    /** The footer's left when there is no Back (the welcome's Learn More). */
    start: (@Composable () -> Unit)? = null,
    centered: Boolean = false,
    above: (@Composable () -> Unit)? = null,
    actions: (@Composable RowScope.() -> Unit)? = null,
    /** The screen's other ways on (Use a Token Instead, Paste a URL Instead): centred just above the footer. */
    below: (@Composable ColumnScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit = {},
) {
    // The screen draws its own background, so its text takes the colour on it: without this,
    // words with no colour of their own were black on dark (Ryan, on his phone).
    CompositionLocalProvider(LocalContentColor provides MaterialTheme.colorScheme.onBackground) {
        Column(
            Modifier
                .fillMaxSize()
                .background(MaterialTheme.colorScheme.background)
                .systemBarsPadding()
                .imePadding()
                .testTag("first-run-$name"),
        ) {
            Column(
                Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 24.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                horizontalAlignment = if (centered) Alignment.CenterHorizontally else Alignment.Start,
            ) {
                // The welcome's words sit a third of the way down.
                if (centered) Spacer(Modifier.height(96.dp))
                if (step != null) StepBar(step)
                above?.invoke()
                Text(
                    title,
                    Modifier.semantics { heading() }.testTag("first-run-title"),
                    style = MaterialTheme.roles.pageTitle,
                    textAlign = if (centered) TextAlign.Center else TextAlign.Start,
                )
                content()
            }
            if (below != null) {
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("first-run-below"),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    content = below,
                )
            }
            if (back != null || cancel != null || actions != null || start != null) {
                HorizontalDivider()
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    when {
                        cancel != null && back == null -> Link("Cancel", "first-run-cancel", "x", cancel)
                        back != null -> Link("Back", "first-run-back", "chevron-left", back)
                        start != null -> start()
                    }
                    Spacer(Modifier.weight(1f))
                    if (actions != null) Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically, content = actions)
                }
            }
        }
    }
}

/** "Step n of 3" and its three bars. */
@Composable
private fun StepBar(step: Int) {
    Column(Modifier.fillMaxWidth().testTag("first-run-step-bar"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Step $step of 3", style = MaterialTheme.roles.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for (each in 1..3) {
                Box(
                    Modifier.weight(1f).height(4.dp).background(
                        if (each <= step) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
                    ),
                )
            }
        }
    }
}

/**
 * A button's Lucide icon (A1579's set) before its words, as the Mac's first run has them. Every
 * button here has one, and none wraps: its words stay on one line.
 */
@Composable
private fun ButtonIcon(name: String) {
    val icon = rememberLucideIcons()?.icon(name)
    if (icon != null) {
        Icon(LucideAssets.vector(icon), contentDescription = null, Modifier.size(18.dp))
    } else {
        Spacer(Modifier.size(18.dp))
    }
    Spacer(Modifier.width(8.dp))
}

/** One of Lucide's icons on its own (an icon-only button's), [size] square. */
@Composable
internal fun LucideGlyph(name: String, contentDescription: String?, size: androidx.compose.ui.unit.Dp = 22.dp) {
    val icon = rememberLucideIcons()?.icon(name)
    if (icon != null) Icon(LucideAssets.vector(icon), contentDescription, Modifier.size(size)) else Spacer(Modifier.size(size))
}

@Composable
private fun ButtonWords(text: String) {
    Text(text, maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
}

/** The footer's primary button. */
@Composable
internal fun Primary(text: String, tag: String, icon: String, enabled: Boolean = true, busy: Boolean = false, onClick: () -> Unit) {
    Button(onClick = onClick, enabled = enabled && !busy, modifier = Modifier.testTag(tag)) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
            Spacer(Modifier.width(8.dp))
        } else {
            ButtonIcon(icon)
        }
        ButtonWords(text)
    }
}

/** A plain footer or inline button. */
@Composable
internal fun Plain(text: String, tag: String, icon: String, enabled: Boolean = true, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, enabled = enabled, modifier = Modifier.testTag(tag)) {
        ButtonIcon(icon)
        ButtonWords(text)
    }
}

/** A quiet button inside the screen (Paste a URL Instead, Refresh, Change). */
@Composable
internal fun Link(text: String, tag: String, icon: String, onClick: () -> Unit) {
    TextButton(onClick = onClick, Modifier.testTag(tag)) {
        ButtonIcon(icon)
        ButtonWords(text)
    }
}

/** What a screen says under its title. */
@Composable
internal fun Lead(text: String, modifier: Modifier = Modifier, small: Boolean = false, centered: Boolean = false) {
    Text(
        text,
        modifier,
        style = if (small) MaterialTheme.roles.help else MaterialTheme.roles.body,
        color = if (small) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
        textAlign = if (centered) TextAlign.Center else TextAlign.Start,
    )
}

/** Something went wrong, said once, for screen readers too. */
@Composable
internal fun Problem(text: String, tag: String) {
    Text(
        text,
        Modifier.testTag(tag).semantics { liveRegion = LiveRegionMode.Polite },
        style = MaterialTheme.roles.body,
        color = MaterialTheme.colorScheme.error,
    )
}

/** Work going on: a spinner and what it is. */
@Composable
internal fun Working(text: String, tag: String = "first-run-working") {
    Row(
        Modifier.testTag(tag).semantics { liveRegion = LiveRegionMode.Polite },
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        Text(text, style = MaterialTheme.roles.body)
    }
}

/** A small label beside a row: Recommended, Private, Empty, Read Only, Already Added. */
@Composable
internal fun Chip(text: String, tag: String? = null) {
    Text(
        text,
        Modifier
            .background(MaterialTheme.colorScheme.secondaryContainer)
            .padding(horizontal = 6.dp, vertical = 1.dp)
            .then(if (tag != null) Modifier.testTag(tag) else Modifier),
        style = MaterialTheme.roles.badge,
        color = MaterialTheme.colorScheme.onSecondaryContainer,
    )
}

/** One of a screen's choices, drawn as a wide row. */
internal data class Option<T>(val value: T, val title: String, val line: String, val tag: String, val chip: String? = null, val enabled: Boolean = true)

/** Radio choices drawn as wide rows: one picked, the footer's button goes on with it. */
@Composable
internal fun <T> Options(value: T, items: List<Option<T>>, onChange: (T) -> Unit) {
    Column(Modifier.selectableGroup().fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        for (item in items) {
            val picked = item.value == value
            Row(
                Modifier
                    .fillMaxWidth()
                    .border(1.dp, if (picked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant)
                    .selectable(selected = picked, enabled = item.enabled, role = Role.RadioButton) { onChange(item.value) }
                    .padding(horizontal = 8.dp, vertical = 12.dp)
                    .testTag(item.tag),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                RadioButton(selected = picked, onClick = null, enabled = item.enabled)
                Column(Modifier.weight(1f)) {
                    Text(item.title, style = MaterialTheme.roles.rowLabel)
                    Text(item.line, style = MaterialTheme.roles.help, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (item.chip != null) Chip(item.chip)
            }
        }
    }
}

/** A repository (or address) with where in it: the card the name and repository screens show. */
@Composable
internal fun PlaceCard(label: String, dir: String, branch: String, notebook: String? = null) {
    Column(
        Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant).padding(12.dp).testTag("first-run-place"),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        if (notebook != null) Text(notebook, style = MaterialTheme.roles.rowLabel)
        Text(label, style = if (notebook != null) MaterialTheme.roles.help else MaterialTheme.roles.rowLabel)
        Text("${folderWords(dir)} · $branch", style = MaterialTheme.roles.meta, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Branch and folder, out of the way until opened. */
@Composable
internal fun MoreOptions(branch: String, dir: String, onBranch: (String) -> Unit, onDir: (String) -> Unit) {
    var open by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().testTag("first-run-more"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Link("More Options", "first-run-more-toggle", if (open) "chevron-down" else "chevron-right") { open = !open }
        if (open) {
            OutlinedTextField(branch, onBranch, Modifier.fillMaxWidth().testTag("first-run-branch"), label = { Text("Branch") }, singleLine = true)
            OutlinedTextField(dir, onDir, Modifier.fillMaxWidth().testTag("first-run-dir"), label = { Text("Folder (Optional)") }, singleLine = true)
        }
    }
}
