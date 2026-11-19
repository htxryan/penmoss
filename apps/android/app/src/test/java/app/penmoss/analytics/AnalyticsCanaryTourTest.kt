package app.penmoss.analytics

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.ui.common.FolderItem
import app.penmoss.ui.common.NoteItem
import app.penmoss.ui.common.PenmossTheme
import app.penmoss.ui.folders.FolderDeleteDialog
import app.penmoss.ui.folders.FolderSheet
import app.penmoss.ui.home.FolderScreen
import app.penmoss.ui.home.HomeActions
import app.penmoss.ui.home.HomeScreen
import app.penmoss.ui.home.HomeUi
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * A tour of the phone's screens filled with the canary notebook's words records none of them
 * (PEN-137, AC14): Home, a folder, its sheet and its delete question, each holding canary names,
 * have every control tapped; screens are shown by routes that carry canary ids; settings are set
 * to canary text. The record then holds the taps, the dialogs and the screens by name, and not one
 * canary, in any case or URL-encoded.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AnalyticsCanaryTourTest {
    @get:Rule
    val compose = createComposeRule()

    private val phone = AnalyticsHarness()

    private val canaries = listOf(
        "Zebracanary Title Q7", "Okapicanary Folder", "narwhalcanary", "quokkacanary.png", "Axolotlcanary Target", "pangolincanary",
        "Wombatcanary Notebook", "canary-owner/kiwicanary-repo", "tapircanary-branch", "lemurcanary", "ibis.canary@example.invalid",
        "ghp_CANARY000000000000000000000000000000", "slothcanary",
    )

    @Before
    fun install() = Analytics.install(phone.service)

    @After
    fun close() {
        Analytics.install(null)
        phone.close()
    }

    /** Taps every control on screen, once each, as long as it is still there. */
    private fun tapEverything() {
        var index = 0
        while (true) {
            val nodes = compose.onAllNodes(hasClickAction())
            if (index >= nodes.fetchSemanticsNodes().size) break
            runCatching { nodes[index].performClick() }
            compose.waitForIdle()
            index++
        }
    }

    @Test
    fun aTourOfCanaryScreensRecordsNoCanary() = runBlocking {
        val notes = listOf(
            NoteItem("01JCANARY00000000000000001", "Zebracanary Title Q7", "pangolincanary #narwhalcanary [[Axolotlcanary Target]]", "ibis.canary@example.invalid"),
            NoteItem("01JCANARY00000000000000002", "slothcanary", "quokkacanary.png", "lemurcanary"),
        )
        val folders = listOf(FolderItem("Okapicanary Folder", "Okapicanary Folder"))
        var step by mutableIntStateOf(0)
        compose.setContent {
            PenmossTheme {
                when (step) {
                    0 -> HomeScreen(
                        HomeUi(notes = notes, recent = notes, folders = folders, status = "tapircanary-branch", notebook = "Wombatcanary Notebook"),
                        HomeActions(),
                    )
                    1 -> FolderScreen("Okapicanary Folder", folders, notes, onBack = {}, onFolder = {}, onOpen = {}, onNewNote = {})
                    2 -> FolderSheet("Okapicanary Folder", onRename = {}, onNewSubfolder = {}, onMove = {}, onDelete = {}, onDismiss = {})
                    else -> FolderDeleteDialog("Okapicanary Folder", notes = 2, subfolders = 1, destination = "Wombatcanary Notebook", onConfirm = {}, onDismiss = {})
                }
            }
        }
        for (next in 0..3) {
            step = next
            compose.waitForIdle()
            tapEverything()
        }
        step = 0
        compose.waitForIdle()

        // Screens by routes that carry canary ids, and settings set to canary text.
        for (canary in canaries) {
            Analytics.screen(ScreenKinds.of("note/$canary"))
            Analytics.screen(ScreenKinds.of("folder/$canary"))
            Analytics.screen(ScreenKinds.of(canary))
            SettingEvents.record("template.daily", JsonPrimitive(canary))
            SettingEvents.record("theme.id", JsonPrimitive(canary))
            SettingEvents.record("font.note", JsonPrimitive("custom:$canary"))
            SettingEvents.record("keys.$canary", JsonPrimitive(canary))
            SettingEvents.record("theme.custom.$canary", JsonPrimitive(canary))
        }

        phone.service.flush()
        val stored = phone.store.page(null, null, 5000)
        val text = stored.joinToString("\n") { "${it.kind} ${it.name} ${it.props}" }
        assertTrue("no taps recorded:\n$text", stored.count { it.kind == "click" } >= 5)
        assertTrue("no dialog recorded:\n$text", stored.any { it.kind == "dialog" })
        assertTrue("no screen recorded:\n$text", stored.any { it.kind == "screen" })
        assertTrue("no setting recorded:\n$text", stored.any { it.kind == "setting" })
        for (canary in canaries) {
            for (form in listOf(canary, java.net.URLEncoder.encode(canary, "UTF-8"))) {
                assertFalse("$form in the record", text.contains(form, ignoreCase = true))
            }
        }
        assertFalse(text.contains("canary", ignoreCase = true))
    }
}
