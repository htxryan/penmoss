package app.penmoss.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import app.penmoss.ui.common.OutlinedButton
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.trackedClick
import app.penmoss.updates.NotesBlock
import app.penmoss.updates.NotesView
import app.penmoss.updates.noteLine

/*
 * Settings → What's New (PEN-109; PEN-146): a version card first (the only place Settings names
 * the version; it has no update controls: Google Play updates a Play install, and a newer
 * Penmoss.apk installs over a sideloaded one, as install/android.md says), then this version's
 * notes and, behind Earlier Versions, the earlier ones', grouped New, Improved and Fixed. Each
 * block and each kind is a heading, so TalkBack can move between them; each note is its own line.
 * Without notes yet, it says so and links to GitHub.
 */

@Composable
fun WhatsNewScreen(view: NotesView, onOpenReleases: () -> Unit, onBack: () -> Unit, version: String? = null) {
    var earlier by rememberSaveable { mutableStateOf(false) }
    SectionScreen("What’s New", onBack) {
        if (version != null) VersionCard(version)
        when (view) {
            NotesView.None -> Missing(
                "Release notes show once the phone has been online with Penmoss open. Until then, they’re on GitHub.",
                onOpenReleases,
            )
            NotesView.Newer -> Missing("This version of Penmoss can’t read the newest release notes. They’re on GitHub.", onOpenReleases)
            is NotesView.Ok -> {
                view.current?.let { Block(it, "whatsNewCurrent") }
                if (view.earlier.isNotEmpty()) {
                    OutlinedButton(
                        onClick = trackedClick("settings.updates.whats-new.earlier") { earlier = !earlier },
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("whatsNewEarlierToggle"),
                    ) { Text(if (earlier) "Hide Earlier Versions" else "Earlier Versions") }
                    if (earlier) {
                        Heading("Earlier Versions", MaterialTheme.typography.titleLarge, Modifier.testTag("whatsNewEarlier"))
                        view.earlier.forEach { Block(it, "whatsNewRelease") }
                    }
                }
                if (view.current == null && view.earlier.isEmpty()) {
                    Help("No release notes yet.")
                }
            }
        }
    }
}

/** The version card (PEN-146): this build's version, Current, where updates come from, and Open Source Notices (A1580). */
@Composable
private fun VersionCard(version: String) {
    Column(
        Modifier.settingRow("what-s-new").fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant).padding(16.dp).testTag("whatsNewVersion"),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Penmoss $version", style = MaterialTheme.typography.titleMedium)
            Text(
                "Current",
                Modifier.background(MaterialTheme.colorScheme.primaryContainer).padding(horizontal = 8.dp, vertical = 2.dp),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onPrimaryContainer,
            )
        }
        Text(VERSION_UPDATES, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OpenSourceNoticesLink()
    }
}

@Composable
private fun Missing(text: String, onOpenReleases: () -> Unit) {
    Help(text, Modifier.testTag("whatsNewMissing"))
    Row(Modifier.padding(horizontal = 8.dp)) {
        TextButton(onClick = trackedClick("settings.whats-new.open-releases", onOpenReleases), modifier = Modifier.testTag("whatsNewReleases")) { Text("Open Releases on GitHub") }
    }
}

@Composable
private fun Heading(text: String, style: androidx.compose.ui.text.TextStyle, modifier: Modifier = Modifier) {
    Text(
        text,
        modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp).semantics { heading() },
        style = style,
    )
}

@Composable
private fun Block(block: NotesBlock, tag: String) {
    Heading(headingCase(block.title), MaterialTheme.typography.titleMedium, Modifier.testTag(tag))
    if (block.groups.isEmpty()) {
        Help("Nothing that people using Penmoss would notice.")
        return
    }
    block.groups.forEach { group ->
        GroupTitle(group.label)
        group.notes.forEach { note ->
            // Only notes for both apps or Android's reach this screen, so none needs a tag.
            Text(
                "• ${noteLine(note, block.builds)}",
                Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("whatsNewNote"),
                style = MaterialTheme.typography.bodyLarge,
            )
        }
    }
}

/**
 * A release block's title as a heading (PEN-146): the shared model's "In this version (since
 * 0.2.0)", which the Mac's contract fixes, in Title Case on the screen. A version stays as it is.
 */
internal fun headingCase(title: String): String =
    title.replace("In this version", "In This Version").replace("(since ", "(Since ")

/**
 * The version card's line (PEN-146; PEN-148): how each install updates. One from Google Play (its
 * internal testing track) is updated by Google Play, as any app is; Penmoss.apk never updates
 * itself, so a newer one installs over it.
 */
internal const val VERSION_UPDATES =
    "Installed from Google Play: Google Play updates it, as it does your other apps. " +
        "Installed from Penmoss.apk: it doesn’t update itself, so install a newer Penmoss.apk from GitHub over this one."
