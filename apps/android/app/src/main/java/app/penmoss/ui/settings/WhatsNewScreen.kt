package app.penmoss.ui.settings

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.penmoss.updates.NotesBlock
import app.penmoss.updates.NotesView
import app.penmoss.updates.noteLine

/*
 * Settings → What's New (PEN-109): this version's notes and earlier versions', grouped New,
 * Improved and Fixed. Each block and each kind is a heading, so TalkBack can move between them;
 * each note is its own line. Without notes yet, it says so and links to GitHub.
 */

@Composable
fun WhatsNewScreen(view: NotesView, onOpenReleases: () -> Unit, onBack: () -> Unit) {
    SectionScreen("What’s New", onBack) {
        when (view) {
            NotesView.None -> Missing(
                "Release notes show once the phone has been online with Penmoss open. Until then, they’re on GitHub.",
                onOpenReleases,
            )
            NotesView.Newer -> Missing("This version of Penmoss can’t read the newest release notes. They’re on GitHub.", onOpenReleases)
            is NotesView.Ok -> {
                view.current?.let { Block(it, "whatsNewCurrent") }
                if (view.earlier.isNotEmpty()) {
                    Heading("Earlier versions", MaterialTheme.typography.titleLarge, Modifier.testTag("whatsNewEarlier"))
                    view.earlier.forEach { Block(it, "whatsNewRelease") }
                }
                if (view.current == null && view.earlier.isEmpty()) {
                    Help("No release notes yet.")
                }
            }
        }
    }
}

@Composable
private fun Missing(text: String, onOpenReleases: () -> Unit) {
    Help(text, Modifier.testTag("whatsNewMissing"))
    Row(Modifier.padding(horizontal = 8.dp)) {
        TextButton(onClick = onOpenReleases, modifier = Modifier.testTag("whatsNewReleases")) { Text("Open Releases on GitHub") }
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
    Heading(block.title, MaterialTheme.typography.titleMedium, Modifier.testTag(tag))
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
