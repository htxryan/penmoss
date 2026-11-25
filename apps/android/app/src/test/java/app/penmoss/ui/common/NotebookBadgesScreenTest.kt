package app.penmoss.ui.common

import android.graphics.Bitmap
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.verticalScroll
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.git.GitNotebookView
import app.penmoss.engine.settings.BadgeGlyph
import app.penmoss.engine.settings.NotebookBadges
import app.penmoss.engine.settings.Settings
import app.penmoss.git.GitNotebooksActions
import app.penmoss.git.GitNotebooksScreen
import app.penmoss.git.GitNotebooksUi
import app.penmoss.git.GitRow
import app.penmoss.ui.settings.BadgeSettings
import app.penmoss.ui.settings.NotebookEntry
import app.penmoss.ui.settings.RecentIcons
import app.penmoss.ui.settings.SettingsHome
import app.penmoss.ui.settings.settingsGroups
import java.io.File
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * Notebook badges on the phone (A1579): drawn on the notebooks' rows (the first screen and
 * Settings → All Notebooks), Settings' Notebooks group and a notebook's page heading, each a
 * square of its colour with its letter, number or Lucide icon, and changed on the page's
 * Overview. Its proof: the first screen's rows drawn and captured (`build/badge-proof/`), each
 * badge's colour read back from the pixels.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NotebookBadgesScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Before
    fun readTheIcons() {
        // Read before the screens compose, so no badge waits on the file.
        LucideAssets.icons(context)
        context.getSharedPreferences("penmoss.picker", 0).edit().clear().commit()
    }

    private fun view(n: Int, name: String) = GitNotebookView(
        localId = "local-$n",
        notebookId = "01JD000000000000000000000$n",
        name = name,
        create = false,
        remote = "https://github.com/htxryan/$n",
        repository = "github.com/htxryan/$n",
        host = "github.com",
        branch = "main",
        dir = "",
        pushDelayS = 60,
        pullEveryMin = 2,
        wifiOnly = false,
        hasToken = true,
    )

    private fun badge(view: GitNotebookView, settings: Map<String, JsonElement> = emptyMap()) =
        NotebookBadges.badgeOf(view.notebookId, view.name, settings)

    private fun glyph(kind: String, value: String) =
        JsonObject(mapOf("kind" to JsonPrimitive(kind), "value" to JsonPrimitive(value)))

    private val personal = view(1, "Personal")
    private val work = view(2, "Work")
    private val garden = view(3, "Garden")
    private val later = view(4, "Later")
    private val rows = listOf(
        // Nothing chosen: its preset and first letter.
        GitRow(personal, null, badge = badge(personal)),
        // A Lucide icon, on teal.
        GitRow(work, null, badge = badge(work, mapOf(NotebookBadges.COLOR to JsonPrimitive("teal"), NotebookBadges.GLYPH to glyph("icon", "lucide:rocket")))),
        // An icon from before Lucide, drawn as its twin; a number on a custom colour.
        GitRow(garden, null, badge = badge(garden, mapOf(NotebookBadges.COLOR to JsonPrimitive("#f5d76e"), NotebookBadges.GLYPH to glyph("icon", "branch")))),
        // A Lucide name this build lacks: the notebook's letter.
        GitRow(later, null, badge = badge(later, mapOf(NotebookBadges.GLYPH to glyph("icon", "lucide:from-a-later-lucide")))),
    )

    /** One of the proof's pictures, under the module's build folder. */
    private fun shot(bitmap: Bitmap, name: String) {
        val folder = File("build/badge-proof").apply { mkdirs() }
        File(folder, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun pixelOf(bitmap: Bitmap, hex: String): Boolean {
        val want = android.graphics.Color.parseColor(hex)
        fun ch(v: Int, shift: Int) = (v shr shift) and 0xFF
        // Its edge, inside the square and clear of the glyph.
        val pixel = bitmap.getPixel(2, 2)
        return listOf(16, 8, 0).all { kotlin.math.abs(ch(pixel, it) - ch(want, it)) < 12 }
    }

    @Test
    fun theFirstScreensRowsShowEachNotebooksBadgeBeforeItsName() {
        compose.setContent {
            PenmossTheme { GitNotebooksScreen(GitNotebooksUi(rows = rows, home = true), GitNotebooksActions(), onBack = {}) }
        }
        compose.waitForIdle()
        val badges = compose.onAllNodesWithTag("notebook-badge", useUnmergedTree = true)
        assertEquals(4, badges.fetchSemanticsNodes().size)
        // Beside its name, so TalkBack hears the name once, not the badge as well.
        for (node in badges.fetchSemanticsNodes()) {
            assertTrue(node.config.getOrNull(SemanticsProperties.HideFromAccessibility) != null)
        }
        // Personal: its preset (rose, from its id, as on the Mac) and P.
        assertEquals("rose", rows[0].badge.preset)
        compose.onAllNodesWithTag("notebook-badge-text", useUnmergedTree = true)[0].assertTextEquals("P")
        compose.onNodeWithTag("notebook-badge-icon-rocket", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("notebook-badge-icon-git-branch", useUnmergedTree = true).assertIsDisplayed()
        // From a later Lucide: Later's L.
        compose.onAllNodesWithTag("notebook-badge-text", useUnmergedTree = true)[1].assertTextEquals("L")

        // Drawn: each square in its colour (the proof's pictures).
        shot(compose.onRoot().captureToImage().asAndroidBitmap(), "notebooks-home.png")
        for ((at, row) in rows.withIndex()) {
            // The large title bar (A1560) leaves the last row below the fold: bring each into view.
            badges[at].performScrollTo()
            val bitmap = badges[at].captureToImage().asAndroidBitmap()
            shot(bitmap, "badge-${row.view.name.lowercase()}.png")
            assertTrue("${row.view.name}'s badge is ${row.badge.color}", pixelOf(bitmap, row.badge.color))
        }
        // Near-black on the light custom colour, white on the presets.
        assertEquals(NotebookBadges.INK_DARK, rows[2].badge.ink)
        assertEquals(NotebookBadges.INK_LIGHT, rows[1].badge.ink)
    }

    @Test
    fun settingsNotebooksGroupShowsEachBadge() {
        val entries = rows.map { NotebookEntry(it.view.localId, it.view.name, primary = false, status = "Synced", dot = DotState.SYNCED, badge = it.badge) }
        compose.setContent {
            PenmossTheme { SettingsHome(settingsGroups(Settings(), "Penmoss", notebooks = entries), onOpen = {}, onBack = {}) }
        }
        compose.onNodeWithTag("settingsSections").performScrollToNode(hasTestTag("section-notebook-local-4"))
        compose.onNodeWithTag("section-notebook-local-2").assertIsDisplayed()
        compose.onNodeWithTag("notebook-badge-icon-rocket", useUnmergedTree = true).assertIsDisplayed()
        assertEquals(4, compose.onAllNodesWithTag("notebook-badge", useUnmergedTree = true).fetchSemanticsNodes().size)
    }

    @Test
    fun theBadgeAloneSaysItsNotebooksName() {
        compose.setContent { PenmossTheme { NotebookBadgeView(rows[1].badge, "Work", size = 26.dp) } }
        compose.onNodeWithTag("notebook-badge", useUnmergedTree = true).assertContentDescriptionEquals("Work")
    }

    @Test
    fun theOverviewsBadgeRowsWriteTheNotebooksOwnSettings() {
        val writes = mutableListOf<Pair<String, JsonElement?>>()
        var settings by mutableStateOf<Map<String, JsonElement>>(emptyMap())
        compose.setContent {
            PenmossTheme {
                androidx.compose.foundation.layout.Column(
                    androidx.compose.ui.Modifier.verticalScroll(androidx.compose.foundation.rememberScrollState()),
                ) {
                    BadgeSettings(badge(personal, settings), personal.notebookId, personal.name) { key, value ->
                        writes += key to value
                        settings = if (value == null) settings - key else settings + (key to value)
                    }
                }
            }
        }
        // Nothing chosen: Reset has nothing to do.
        compose.onNodeWithTag("badgeReset").assertIsNotEnabled()
        compose.onNodeWithTag("badgePreset-rose").assertIsSelected()

        // A preset is written by its id; the default's preset is never written.
        compose.onNodeWithTag("badgePreset-teal").performClick()
        assertEquals(NotebookBadges.COLOR to JsonPrimitive("teal"), writes.last())
        compose.onNodeWithTag("badgePreset-rose").performClick()
        assertEquals(NotebookBadges.COLOR to null, writes.last())

        // A number starts at 1 and takes 0 to 99.
        compose.onNodeWithTag("badgeKind-number").performClick()
        assertEquals(NotebookBadges.GLYPH to glyph("number", "1"), writes.last())
        compose.onNodeWithTag("badgeNumber").performTextReplacement("42")
        assertEquals(NotebookBadges.GLYPH to glyph("number", "42"), writes.last())
        val count = writes.size
        compose.onNodeWithTag("badgeNumber").performTextReplacement("100")
        assertEquals("100 is not written", count, writes.size)

        // An icon starts at Lucide's notebook; Choose Icon… opens the picker, marked on it.
        compose.onNodeWithTag("badgeKind-icon").performClick()
        assertEquals(NotebookBadges.GLYPH to glyph("icon", NotebookBadges.FIRST_ICON), writes.last())
        compose.onNodeWithTag("badgeIconName", useUnmergedTree = true).assertTextEquals("Notebook")
        compose.onNodeWithTag("badgeIconChoose").performScrollTo().performClick()
        compose.onNodeWithTag("icon-picker").assertIsDisplayed()
        compose.onNodeWithTag("icon-notebook").assertIsSelected()
        shot(compose.onNodeWithTag("icon-picker").captureToImage().asAndroidBitmap(), "icon-picker.png")
        compose.onNodeWithTag("icon-search").performTextReplacement("rocket")
        shot(compose.onNodeWithTag("icon-picker").captureToImage().asAndroidBitmap(), "icon-picker-search.png")
        compose.onNodeWithTag("icon-rocket").assertContentDescriptionEquals("Rocket").performClick()
        compose.onNodeWithTag("icon-picker").assertDoesNotExist()
        assertEquals(NotebookBadges.GLYPH to glyph("icon", "lucide:rocket"), writes.last())
        compose.onNodeWithTag("badgeIconName", useUnmergedTree = true).assertTextEquals("Rocket")
        assertEquals(listOf("lucide:rocket"), RecentIcons(context).read())
        shot(compose.onRoot().captureToImage().asAndroidBitmap(), "badge-settings.png")

        // Opened again: Recently Used leads, the chosen icon marked there.
        compose.onNodeWithTag("badgeIconChoose").performScrollTo().performClick()
        compose.onNodeWithText("Recently Used").assertIsDisplayed()
        compose.onAllNodes(hasTestTag("icon-rocket"))[0].assertIsSelected()
        compose.onNodeWithTag("icon-search").performTextReplacement("zzqqxx")
        compose.onNodeWithTag("icon-said").assertTextEquals("No icons match “zzqqxx”.")
        compose.onNodeWithTag("icon-search").performTextReplacement("")
        compose.onAllNodes(hasTestTag("icon-rocket"))[0].performClick()
        compose.onNodeWithTag("icon-picker").assertDoesNotExist()

        // Reset to Default removes both.
        compose.onNodeWithTag("badgeReset").performScrollTo().assertIsEnabled().performClick()
        assertEquals(listOf(NotebookBadges.COLOR to null, NotebookBadges.GLYPH to null), writes.takeLast(2))
        assertEquals(BadgeGlyph(BadgeGlyph.LETTER, "P"), badge(personal, settings).glyph)
    }
}
