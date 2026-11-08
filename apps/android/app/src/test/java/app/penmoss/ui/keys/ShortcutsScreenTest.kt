package app.penmoss.ui.keys

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.withKeyDown
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.keys.Bindings
import app.penmoss.engine.keys.ShortcutCatalogue
import app.penmoss.ui.PenmossTheme
import app.penmoss.ui.assertTouchTarget
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/** Settings → Keyboard shortcuts (T40 P9, ST8, A495), with the keys a Bluetooth keyboard sends. */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ShortcutsScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val catalogue = ShortcutCatalogue.bundled
    private val raw = LinkedHashMap<String, JsonElement>()
    private var bindings by mutableStateOf(Bindings(catalogue, emptyMap()))
    private val writes = mutableListOf<Pair<String, List<String>?>>()
    private var recording = false

    private fun show(
        keyboard: Boolean = true,
        canChange: Boolean = true,
        start: Map<String, List<String>> = emptyMap(),
        layout: KeyChars = Layout.US,
        coverage: (String, String) -> Coverage? = AndroidCommands::coverage,
    ) {
        for ((id, keys) in start) raw[id] = JsonArray(keys.map(::JsonPrimitive))
        bindings = Bindings(catalogue, raw.toMap())
        compose.setContent {
            PenmossTheme {
                ShortcutsScreen(
                    bindings = bindings,
                    keyboard = keyboard,
                    canChange = canChange,
                    onSet = { id, keys ->
                        writes += id to keys
                        if (keys == null) raw.remove(id) else raw[id] = JsonArray(keys.map(::JsonPrimitive))
                        bindings = Bindings(catalogue, raw.toMap())
                    },
                    onBack = {},
                    onRecording = { recording = it },
                    chars = layout,
                    coverage = coverage,
                )
            }
        }
    }

    private fun row(id: String) {
        compose.onNodeWithTag("shortcutList").performScrollToNode(hasTestTag("shortcut-$id"))
    }

    private fun record(id: String, keys: androidx.compose.ui.test.KeyInjectionScope.() -> Unit) {
        row(id)
        compose.onNodeWithTag("change-$id").performClick()
        compose.runOnIdle { assertTrue(recording) }
        // Robolectric never gives the dialog's window focus, which the recorder waits for on a
        // phone (the Pixel checklist covers that), so it is focused as TalkBack would focus it.
        compose.onNodeWithTag("shortcutRecorder").performSemanticsAction(SemanticsActions.RequestFocus)
        compose.onNodeWithTag("shortcutRecorder").assertIsFocused()
        compose.onNodeWithTag("shortcutRecorder").performKeyInput(keys)
        compose.waitForIdle()
    }

    @Test
    fun listsTheCommandsByAreaWithAndroidsNamesForTheKeys() {
        show()
        row("app.search")
        compose.onNodeWithTag("keys-app.search", useUnmergedTree = true).assertTextEquals("Ctrl+Shift+F")
        compose.onNodeWithText("Navigation").assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading))
        row("journal.thisWeek")
        compose.onNodeWithTag("keys-journal.thisWeek", useUnmergedTree = true).assertTextEquals("Ctrl+Shift+W or Alt+W")
        // The phone's own: no sidebar, no browser to open; the palette is Search here.
        compose.onNodeWithTag("shortcut-app.toggleSidebar").assertDoesNotExist()
        compose.onNodeWithTag("shortcut-app.openInBrowser").assertDoesNotExist()
        compose.onNodeWithTag("shortcutsNeedKeyboard").assertDoesNotExist()
    }

    @Test
    fun searchFindsACommandByItsNameOrKeysAndSaysWhenNoneMatch() {
        show()
        compose.onNodeWithTag("shortcutSearch").performTextInput("ctrl+d")
        compose.onNodeWithTag("shortcut-journal.today").assertExists()
        compose.onNodeWithTag("shortcut-app.search").assertDoesNotExist()
        compose.onNodeWithTag("shortcutSearch").performTextInput("zzz")
        compose.onNodeWithTag("shortcutsNone").assertTextEquals("No commands match “ctrl+dzzz”.")
    }

    @Test
    fun recordsANewShortcutFromTheKeyboard() {
        show()
        record("app.search") { withKeyDown(Key.CtrlLeft) { withKeyDown(Key.ShiftLeft) { pressKey(Key.J) } } }
        assertEquals(listOf<Pair<String, List<String>?>>("app.search" to listOf("Mod+Shift+J")), writes)
        compose.onNodeWithTag("keys-app.search", useUnmergedTree = true).assertTextEquals("Ctrl+Shift+J")
        compose.onNodeWithTag("notice-app.search", useUnmergedTree = true).assertTextEquals("Search Notes… is now Ctrl+Shift+J.")
        compose.runOnIdle { assertTrue(!recording) }
    }

    @Test
    fun aShortcutTheEditorHasIsNotTakenWithoutAsking() {
        // Ctrl+Shift+S is Strikethrough in a note: a global command there would clash (A90).
        show()
        record("app.search") { withKeyDown(Key.CtrlLeft) { withKeyDown(Key.ShiftLeft) { pressKey(Key.S) } } }
        assertEquals(emptyList<Any>(), writes)
        compose.onNodeWithText("Ctrl+Shift+S is used by “Strikethrough”.").assertExists()
    }

    @Test
    fun aShortcutAnotherCommandHasIsMovedOnlyWhenAsked() {
        show()
        record("app.search") { withKeyDown(Key.CtrlLeft) { pressKey(Key.D) } }
        assertEquals(emptyList<Any>(), writes)
        compose.onNodeWithText("Ctrl+D is used by “Today's Note”.").assertExists()
        compose.onNodeWithTag("useHere").performClick()
        assertEquals(listOf("journal.today" to emptyList<String>(), "app.search" to listOf("Mod+D")), writes)
        row("app.search")
        compose.onNodeWithTag("keys-app.search", useUnmergedTree = true).assertTextEquals("Ctrl+D")
        row("journal.today")
        compose.onNodeWithTag("keys-journal.today", useUnmergedTree = true).assertTextEquals("No shortcut")
    }

    @Test
    fun refusesWhatWouldTypeOrIsKeptAndEscapeCancels() {
        show()
        record("app.search") { pressKey(Key.S) }
        compose.onNodeWithTag("notice-app.search", useUnmergedTree = true).assertTextEquals("S would type a character: add Ctrl or Alt.")
        record("app.search") { withKeyDown(Key.CtrlLeft) { pressKey(Key.C) } }
        compose.onNodeWithTag("notice-app.search", useUnmergedTree = true).assertTextEquals("Ctrl+C is kept for copying, pasting, finding and editing text.")
        record("app.search") { withKeyDown(Key.CtrlLeft) { pressKey(Key.Spacebar) } }
        compose.onNodeWithTag("notice-app.search", useUnmergedTree = true).assertTextEquals("Ctrl+Space is kept by Android.")
        record("app.search") { pressKey(Key.Escape) }
        compose.onNodeWithTag("notice-app.search", useUnmergedTree = true).assertDoesNotExist()
        assertEquals(emptyList<Any>(), writes)
        compose.onNodeWithTag("keys-app.search", useUnmergedTree = true).assertTextEquals("Ctrl+Shift+F")
    }

    @Test
    fun removeAndResetNeedNoKeyboard() {
        show(keyboard = false, start = mapOf("app.quickOpen" to listOf("Mod+Shift+O")))
        compose.onNodeWithTag("shortcutsNeedKeyboard").assertTextEquals("Connect a keyboard to change a shortcut.")
        row("app.search")
        compose.onNodeWithTag("change-app.search").assertDoesNotExist()
        compose.onNodeWithTag("remove-app.search").performClick()
        compose.onNodeWithTag("keys-app.search", useUnmergedTree = true).assertTextEquals("No shortcut")
        row("app.quickOpen")
        compose.onNodeWithTag("reset-app.quickOpen").performClick()
        compose.onNodeWithTag("keys-app.quickOpen", useUnmergedTree = true).assertTextEquals("Ctrl+P")
        row("app.search")
        compose.onNodeWithTag("reset-app.search").performClick()
        assertEquals(
            listOf<Pair<String, List<String>?>>("app.search" to emptyList(), "app.quickOpen" to null, "app.search" to null),
            writes,
        )
        compose.onNodeWithTag("keys-app.search", useUnmergedTree = true).assertTextEquals("Ctrl+Shift+F")
    }

    @Test
    fun aClashThatArrivedBySyncIsListed() {
        show(start = mapOf("app.search" to listOf("Mod+D")))
        compose.onNodeWithTag("shortcutClashes").assertTextEquals("Ctrl+D is bound to both “Search Notes…” and “Today's Note”.")
    }

    @Test
    fun beforeTheFirstSyncNothingCanChange() {
        show(canChange = false)
        compose.onNodeWithText("Shortcuts can be changed here once the phone has synced with Penmoss.").assertExists()
        row("app.search")
        compose.onNodeWithTag("change-app.search").assertDoesNotExist()
        compose.onNodeWithTag("remove-app.search").assertDoesNotExist()
    }

    @Test
    fun eachButtonIsAtLeastATouchTargetAndSaysWhatItChanges() {
        show(start = mapOf("app.search" to listOf("Mod+Shift+S")))
        row("app.search")
        for (tag in listOf("change-app.search", "remove-app.search", "reset-app.search")) {
            assertTouchTarget(compose, compose.onNodeWithTag(tag), tag)
        }
        compose.onNode(hasText("Ctrl+Shift+S")).assertExists()
        compose.onNode(
            SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("Reset the shortcut for Search Notes…")),
            useUnmergedTree = true,
        ).assertExists()
    }

    @Test
    fun aShortcutThatTypesOnThisKeyboardSaysSo() {
        // Generic, a keyboard with no layout chosen (review S5, A557): Alt+N is the dead ~ and
        // Alt+C types ç, so New note and Code block never run with them here.
        show(layout = Layout.GENERIC)
        row("note.new")
        compose.onNodeWithTag("keys-note.new", useUnmergedTree = true)
            .assertTextEquals("Alt+N (types a character on this keyboard)")
        row("editor.codeBlock")
        compose.onNodeWithTag("keys-editor.codeBlock", useUnmergedTree = true)
            .assertTextEquals("Alt+C (types a character on this keyboard)")
        // One that works is listed as it is, beside one that types.
        row("journal.thisWeek")
        compose.onNodeWithTag("keys-journal.thisWeek", useUnmergedTree = true).assertTextEquals("Ctrl+Shift+W or Alt+W")
    }

    @Test
    fun refusesAltGrAndAnyAltTheLayoutTypesWith() {
        // Polish: AltGr+N types ń; recorded, it would never fire and ń could not be typed (B1).
        show(layout = Layout.POLISH)
        record("app.search") { withKeyDown(Key.AltRight) { pressKey(Key.N) } }
        compose.onNodeWithTag("notice-app.search", useUnmergedTree = true)
            .assertTextEquals("Alt+N types a character on this keyboard: add Ctrl.")
        assertEquals(emptyList<Any>(), writes)
    }

    @Test
    fun refusesTheMetaKeyAndTheKeysAndroidsTextFieldsKeep() {
        show()
        record("app.search") { withKeyDown(Key.CtrlLeft) { withKeyDown(Key.MetaLeft) { pressKey(Key.K) } } }
        compose.onNodeWithTag("notice-app.search", useUnmergedTree = true)
            .assertTextEquals("Shortcuts with the Meta key are kept by Android.")
        record("app.search") { withKeyDown(Key.CtrlLeft) { pressKey(Key.DirectionLeft) } }
        compose.onNodeWithTag("notice-app.search", useUnmergedTree = true).assertTextEquals("Ctrl+← is kept by Android.")
        assertEquals(emptyList<Any>(), writes)
    }

    @Test
    fun backAndTheVolumeKeysAreNotRecorded() {
        fun press(code: Int, meta: Int = 0, repeat: Int = 0) =
            recorderKey(android.view.KeyEvent(0L, 0L, android.view.KeyEvent.ACTION_DOWN, code, repeat, meta), Layout.POLISH)
        // Android's (review S10): Back closes the recorder, as on Android 11 and 12 too.
        for (code in listOf(android.view.KeyEvent.KEYCODE_BACK, android.view.KeyEvent.KEYCODE_VOLUME_UP, android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)) {
            assertEquals(RecorderKey.Pass, press(code))
        }
        assertEquals(RecorderKey.Listen, press(android.view.KeyEvent.KEYCODE_SHIFT_LEFT, android.view.KeyEvent.META_SHIFT_ON))
        val ctrl = android.view.KeyEvent.META_CTRL_ON or android.view.KeyEvent.META_CTRL_LEFT_ON
        assertEquals(RecorderKey.Combo("Mod+J", typed = false), press(android.view.KeyEvent.KEYCODE_J, ctrl))
        assertEquals(RecorderKey.Listen, press(android.view.KeyEvent.KEYCODE_J, ctrl, repeat = 1))
        val altGr = android.view.KeyEvent.META_ALT_ON or android.view.KeyEvent.META_ALT_RIGHT_ON
        assertEquals(RecorderKey.Combo("Alt+N", typed = true), press(android.view.KeyEvent.KEYCODE_N, altGr))
    }

    @Test
    fun aCommandStillToComeShowsNoKeysAndCannotBeChanged() {
        // No command is still to come since T40 P6 (the final parity pass); one added on the web
        // and given to a later slice shows this.
        show(coverage = { id, scope -> if (id == "app.recent") Coverage.Later("T41 (FD7)") else AndroidCommands.coverage(id, scope) })
        row("app.recent")
        compose.onNodeWithTag("keys-app.recent", useUnmergedTree = true)
            .assertTextEquals("Not on Android yet: arrives with T41")
        compose.onNodeWithTag("change-app.recent").assertDoesNotExist()
        compose.onNodeWithTag("remove-app.recent").assertDoesNotExist()
    }

    @Test
    fun theRecentNotesSwitcherAndShowAllNotesCanBeRebound() {
        // P6's commands run on Android now (the final parity pass): their keys show and change.
        show()
        row("app.recent")
        compose.onNodeWithTag("keys-app.recent", useUnmergedTree = true).assertTextEquals("Ctrl+E")
        compose.onNodeWithTag("change-app.recent").assertExists()
        row("tags.clearFilter")
        compose.onNodeWithTag("change-tags.clearFilter").assertExists()
    }
}
