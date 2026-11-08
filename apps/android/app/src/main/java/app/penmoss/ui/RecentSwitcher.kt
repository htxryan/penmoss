package app.penmoss.ui

import android.view.KeyEvent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.ui.keys.KeyNames
import app.penmoss.ui.keys.LocalAppCommands
import app.penmoss.ui.keys.RegisterCommand
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/**
 * Ctrl+E, the recent-notes switcher (FD7), as the web's ⌘E: Ctrl+E opens it on the note after
 * the open one, E again (Ctrl held) moves down, Shift+E up (Ctrl+Shift+E never opens it: the
 * editor's Inline code), and letting go of Ctrl opens the note
 * chosen; Enter opens it too and Escape closes the switcher. [count] is how many notes it lists.
 * The keys are `app.recent`'s, as the user bound them (T40 P9, A494): `bound` says whether a
 * combination is one of them. Opened by its command instead ([start], from Search's actions or
 * the note's page), it is not held: ↑/↓ and Enter choose, as on the web.
 */
@Stable
class RecentSwitch {
    var open by mutableStateOf(false)
        private set
    var index by mutableIntStateOf(0)
        private set

    /** Opened by its keys, with their modifier held: letting go of it opens the note chosen. */
    var held by mutableStateOf(false)
        private set

    sealed interface Outcome {
        data object Ignored : Outcome
        data object Handled : Outcome
        data class Choose(val index: Int) : Outcome
    }

    fun onKey(event: KeyEvent, count: Int, bound: (String) -> Boolean = { it == "Mod+E" }): Outcome {
        val down = event.action == KeyEvent.ACTION_DOWN
        val combo = KeyNames.comboOf(event)
        // Ctrl+Shift+E opens nothing (review S7): in a note it is the editor's Inline code, and the
        // web's switcher is Mod+E only. Shift+E moves up once the switcher is open.
        val ours = combo != null && (bound(combo) || (open && event.isShiftPressed && bound(withoutShift(combo))))
        if (ours) {
            // A held key's repeats move nothing (T40 P9 review S11): one press, one step.
            if (!down || event.repeatCount > 0) return Outcome.Handled
            if (count == 0) return Outcome.Handled
            if (!open) {
                start(count)
                held = true
            } else {
                step(if (event.isShiftPressed) -1 else 1, count)
            }
            return Outcome.Handled
        }
        if (!open) return Outcome.Ignored
        return when (event.keyCode) {
            KeyEvent.KEYCODE_CTRL_LEFT, KeyEvent.KEYCODE_CTRL_RIGHT, KeyEvent.KEYCODE_ALT_LEFT, KeyEvent.KEYCODE_ALT_RIGHT ->
                if (event.action == KeyEvent.ACTION_UP && held) choose() else Outcome.Handled
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> if (down) choose() else Outcome.Handled
            KeyEvent.KEYCODE_ESCAPE -> {
                if (down) close()
                Outcome.Handled
            }
            KeyEvent.KEYCODE_DPAD_DOWN -> {
                if (down && count > 0) index = (index + 1) % count
                Outcome.Handled
            }
            KeyEvent.KEYCODE_DPAD_UP -> {
                if (down && count > 0) index = (index - 1 + count) % count
                Outcome.Handled
            }
            else -> Outcome.Handled
        }
    }

    /** Opens on the note after the open one, which comes first, like an app switcher. */
    fun start(count: Int) {
        if (count == 0) return
        open = true
        held = false
        index = minOf(1, count - 1)
    }

    /** Moves the choice [by] notes, wrapping. */
    fun step(by: Int, count: Int) {
        if (count > 0) index = ((index + by) % count + count) % count
    }

    fun close() {
        open = false
        held = false
        index = 0
    }

    private fun choose(): Outcome {
        val chosen = index
        close()
        return Outcome.Choose(chosen)
    }
}

/**
 * The switcher's list (FD7): the notes most recently used, the chosen one marked. Drawn over the
 * screen in the app's own window, not a dialog's, so the keys keep reaching [AppCommands].
 */
@Composable
fun RecentSwitcher(notes: List<NoteItem>, index: Int, onOpen: (Int) -> Unit, onDismiss: () -> Unit) {
    Box(
        Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.32f)).clickable(onClickLabel = "Close", onClick = onDismiss),
        contentAlignment = Alignment.Center,
    ) {
        Surface(shape = MaterialTheme.shapes.large, tonalElevation = 6.dp, modifier = Modifier.padding(24.dp).widthIn(max = 480.dp).testTag("recentSwitcher")) {
            Column(Modifier.padding(vertical = 12.dp)) {
                Text(
                    "Recent notes",
                    Modifier.padding(horizontal = 20.dp, vertical = 6.dp),
                    style = MaterialTheme.typography.titleSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                notes.forEachIndexed { at, note ->
                    val chosen = at == index
                    Text(
                        note.title,
                        Modifier.fillMaxWidth()
                            .background(if (chosen) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface)
                            .clickable(role = Role.Button) { onOpen(at) }
                            .semantics {
                                selected = chosen
                                if (chosen) liveRegion = LiveRegionMode.Polite
                            }
                            .padding(horizontal = 20.dp, vertical = 10.dp)
                            .testTag("recent-$at"),
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = if (chosen) FontWeight.SemiBold else null,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/** Notes most recently used first, the open one at the top (as the web's `recentNotes`), at most [limit]. */
internal fun recentWithCurrent(recent: List<NoteItem>, current: String?, limit: Int = RECENT_SWITCHER_NOTES): List<NoteItem> {
    val open = recent.firstOrNull { it.id == current }
    return (listOfNotNull(open) + recent.filter { it.id != current }).take(limit)
}

private fun withoutShift(combo: String) = combo.split('+').filter { it != "Shift" }.joinToString("+")

/** How many notes the switcher lists (the web's 9). */
internal const val RECENT_SWITCHER_NOTES = 9

/**
 * The switcher over every screen (FD7): it takes `app.recent`'s keys ahead of every view, the
 * note's page included (A494: modal, it needs Ctrl's release, which a page's message would race),
 * and lists the notes most recently used, the open one first ([currentNote]), opening the one
 * chosen. The command itself, from Search or the page, opens it without Ctrl held.
 */
@Composable
internal fun RecentSwitcherHost(graph: app.penmoss.AppGraph, currentNote: String?, openNote: (String) -> Unit) {
    val switch = androidx.compose.runtime.remember { RecentSwitch() }
    val recent by androidx.compose.runtime.remember(graph) {
        // Open notebooks only (T43, A752).
        graph.store.observeRecent(RECENT_SWITCHER_NOTES + 1, graph.hiddenFolders)
            .map { Items.notes(it, System.currentTimeMillis()) }
            .distinctUntilChanged()
    }.collectAsStateWithLifecycle(emptyList())
    val notes = recentWithCurrent(recent, currentNote)
    val listed by androidx.compose.runtime.rememberUpdatedState(notes)
    val open by androidx.compose.runtime.rememberUpdatedState(openNote)
    val current by androidx.compose.runtime.rememberUpdatedState(currentNote)
    RecentSwitcherKeys(switch, count = { listed.size }) { at ->
        // The open note again: nothing to open.
        listed.getOrNull(at)?.let { if (it.id != current) open(it.id) }
    }
    if (switch.open) {
        RecentSwitcher(
            notes,
            switch.index,
            onOpen = { at ->
                switch.close()
                notes.getOrNull(at)?.let { if (it.id != currentNote) openNote(it.id) }
            },
            onDismiss = switch::close,
        )
    }
}

/**
 * The switcher's keys (T40 P6's key router, folded into [AppCommands] by P9, A494): `app.recent`
 * as a command, which opens it without Ctrl held (from Search or the note's page), and a modal
 * taker that opens it on `app.recent`'s keys, as the user bound them, ahead of every view, and
 * while it is open takes every key. [choose] opens the note at that place in the list.
 */
@Composable
internal fun RecentSwitcherKeys(switch: RecentSwitch, count: () -> Int, choose: (Int) -> Unit) {
    val commands = LocalAppCommands.current
    val counted by androidx.compose.runtime.rememberUpdatedState(count)
    val chosen by androidx.compose.runtime.rememberUpdatedState(choose)
    RegisterCommand("app.recent") {
        if (switch.open) switch.step(1, counted()) else switch.start(counted())
    }
    androidx.compose.runtime.DisposableEffect(commands, switch) {
        val remove = commands.take { event ->
            val keys = commands.bindings.value.keysOf("app.recent")
            // Closed, a key that types here or that Android keeps never opens it (A556); open, it
            // takes every key until a note is chosen or it closes.
            val may = switch.open || commands.mayTake(event)
            when (val outcome = switch.onKey(event, counted()) { may && it in keys }) {
                RecentSwitch.Outcome.Ignored -> false
                RecentSwitch.Outcome.Handled -> true
                is RecentSwitch.Outcome.Choose -> {
                    chosen(outcome.index)
                    true
                }
            }
        }
        onDispose { remove() }
    }
}
