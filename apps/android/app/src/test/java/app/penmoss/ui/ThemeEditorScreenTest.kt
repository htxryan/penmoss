package app.penmoss.ui

import android.content.Context
import android.view.View
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertContentDescriptionContains
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.editor.EditorWebView
import app.penmoss.engine.settings.ThemeCatalogue
import app.penmoss.engine.settings.ThemeEdits
import app.penmoss.engine.settings.string
import app.penmoss.ui.settings.AppearanceScreen
import app.penmoss.ui.settings.THEME_SAVE_DELAY_MS
import app.penmoss.ui.settings.ThemeEditorEntry
import app.penmoss.ui.settings.ThemeEditorScreen
import kotlinx.serialization.json.JsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * The theme editor on the phone (T40 P1b, ST5, A417, A418, A419): its way in from Appearance,
 * a colour changed in its sheet and saved once edits pause, the contrast warning beside the
 * colour it concerns, the name, Delete asking first, and the preview never a second WebView.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ThemeEditorScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val catalogue = ThemeCatalogue.bundled
    private val copy = ThemeEdits.duplicate(catalogue.builtIn("nord")!!, "custom-abc", "Nord copy", catalogue)

    @After
    fun noWebViewLeft() {
        while (EditorWebView.live.value > 0) EditorWebView.destroyed()
        EditorWebView.previewClosed()
    }

    private val saves = mutableListOf<JsonObject>()
    private var deleted: JsonObject? = null
    private val previews = mutableListOf<Pair<String?, String>>()

    private fun editor(saved: JsonObject? = copy, loaded: Boolean = true) {
        compose.setContent { EditorUnderTest(saved, loaded) }
    }

    @androidx.compose.runtime.Composable
    private fun EditorUnderTest(saved: JsonObject?, loaded: Boolean = true) {
            PenmossTheme {
                ThemeEditorScreen(
                    saved = saved,
                    catalogue = catalogue,
                    otherNames = listOf("Nord", "Paper"),
                    shownVariant = "light",
                    enabled = loaded,
                    loaded = loaded,
                    onSave = { saves += it },
                    onDuplicate = {},
                    onDelete = { deleted = it },
                    onBack = {},
                    preview = { theme, variant, modifier ->
                        previews += ThemeEdits.colours(theme, variant)["bg"] to variant
                        Box(modifier.testTag("fakePreview"))
                    },
                )
            }
    }

    @Test
    fun aColourChangedInItsSheetShowsAtOnceAndIsSavedOnceEditsPause() {
        editor()
        compose.onNodeWithTag("colour-bg").performScrollTo().performClick()
        compose.onNodeWithTag("colourHex").performTextReplacement("#ABCDEF")
        compose.onNodeWithTag("useColour").performScrollTo().performClick()
        // The preview has it, and once edits pause it is saved, once.
        compose.mainClock.advanceTimeBy(THEME_SAVE_DELAY_MS + 100)
        assertEquals("#abcdef" to "light", previews.last())
        assertEquals("#abcdef", ThemeEdits.colours(saves.single(), "light")["bg"])
        // Only the light variant changed.
        assertEquals(ThemeEdits.colours(copy, "dark"), ThemeEdits.colours(saves.single(), "dark"))
    }

    @Test
    fun aColourBelowWcagAaIsWarnedOfBesideItButStillSaved() {
        editor()
        compose.onNodeWithTag("themeContrast").assertTextContains("passes WCAG AA", substring = true)
        compose.onNodeWithTag("colour-fg").performScrollTo().performClick()
        compose.onNodeWithTag("colourHex").performTextReplacement("#dddddd")
        compose.onNodeWithTag("useColour").performScrollTo().performClick()
        compose.onNodeWithTag("themeContrast").assertTextContains("below WCAG AA in the light variant", substring = true)
        compose.onNodeWithTag("warn-fg", useUnmergedTree = true).performScrollTo().assertIsDisplayed()
        compose.mainClock.advanceTimeBy(THEME_SAVE_DELAY_MS + 100)
        // Advice only (A419): the server's parseTheme decides.
        assertEquals("#dddddd", ThemeEdits.colours(saves.last(), "light")["fg"])
    }

    @Test
    fun theDarkVariantIsEditedApartAndPreviewedAsDark() {
        editor()
        compose.onNodeWithTag("variant-dark").performScrollTo().performClick()
        compose.onNodeWithText("The app is showing the light variant; the preview shows the dark one.").performScrollTo().assertIsDisplayed()
        assertEquals(ThemeEdits.colours(copy, "dark")["bg"] to "dark", previews.last())
        compose.onNodeWithTag("colour-bg").performScrollTo().performClick()
        compose.onNodeWithTag("colourHex").performTextReplacement("#101418")
        compose.onNodeWithTag("useColour").performScrollTo().performClick()
        compose.mainClock.advanceTimeBy(THEME_SAVE_DELAY_MS + 100)
        assertEquals("#101418", ThemeEdits.colours(saves.last(), "dark")["bg"])
        assertEquals(ThemeEdits.colours(copy, "light"), ThemeEdits.colours(saves.last(), "light"))
    }

    @Test
    fun aThemeNeedsANameAndAnotherThemesNameIsSaidOf() {
        editor()
        compose.onNodeWithTag("themeName").performTextReplacement("")
        compose.onNodeWithText("A theme needs a name; until it has one, it keeps the last.").assertIsDisplayed()
        compose.mainClock.advanceTimeBy(THEME_SAVE_DELAY_MS + 100)
        assertTrue(saves.isEmpty())
        compose.onNodeWithTag("themeName").performTextReplacement("Paper")
        compose.onNodeWithText("Another theme has this name.").assertIsDisplayed()
        compose.onNodeWithTag("themeName").performTextReplacement("Night")
        compose.mainClock.advanceTimeBy(THEME_SAVE_DELAY_MS + 100)
        assertEquals("Night", saves.last().string("name"))
    }

    @Test
    fun deleteAsksFirst() {
        editor()
        compose.onNodeWithTag("themeMenu").performClick()
        compose.onNodeWithTag("deleteTheme").performClick()
        compose.onNodeWithText("Delete “Nord copy” on every device?").assertIsDisplayed()
        assertEquals(null, deleted)
        compose.onNodeWithTag("confirmDelete").performClick()
        assertEquals("custom-abc", deleted!!.string("id"))
    }

    @Test
    fun aThemeDeletedElsewhereSaysSo() {
        editor(saved = null)
        compose.onNodeWithTag("themeGone").assertIsDisplayed()
    }

    @Test
    fun appearanceOffersToDuplicateABuiltInAndToEditYourOwn() {
        var opened = 0
        var entry by mutableStateOf(ThemeEditorEntry("Nord", builtIn = true) { opened++ })
        compose.setContent {
            PenmossTheme {
                AppearanceScreen(
                    "system", systemDark = false, themes = emptyList(), chosen = "nord", fullWidth = false, editorWidth = 52,
                    enabled = true, onMode = {}, onTheme = {}, onFullWidth = {}, onBack = {}, editor = entry,
                )
            }
        }
        compose.onNodeWithText("Built-in themes can’t be changed. Duplicate Nord to edit its colours, fonts and note width; your copy syncs to your other devices.")
            .performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("duplicateTheme").performScrollTo().performClick()
        entry = ThemeEditorEntry("Nord copy", builtIn = false) { opened++ }
        compose.onNodeWithTag("editTheme").performScrollTo().assertTextContains("Edit Nord copy").performClick()
        assertEquals(2, opened)
    }

    @Test
    fun thePreviewWaitsWhileANotesWebViewIsAliveAndNeverMakesASecond() {
        var made = 0
        val fake = PreviewViews { context: Context, _, onReady, _ ->
            made++
            EditorWebView.created()
            onReady()
            View(context)
        }
        // A note's WebView has not gone yet.
        EditorWebView.created()
        var shown by mutableStateOf(true)
        compose.setContent {
            PenmossTheme {
                if (shown) ThemePreview(copy, "light", Modifier.testTag("preview"), fake)
            }
        }
        compose.onNodeWithTag("previewWaiting").assertIsDisplayed()
        assertEquals(0, made)
        // The note's WebView goes: the preview's is made, and it is the only one.
        EditorWebView.destroyed()
        compose.waitForIdle()
        assertEquals(1, made)
        assertEquals(1, EditorWebView.live.value)
        // Leaving the editor destroys it.
        shown = false
        compose.waitForIdle()
        assertEquals(0, EditorWebView.live.value)
    }

    @Test
    fun justAfterARestartTheEditorLoadsRatherThanSayingTheThemeWasDeleted() {
        var loaded by mutableStateOf(false)
        var saved by mutableStateOf<JsonObject?>(null)
        compose.setContent { EditorUnderTest(saved, loaded) }
        compose.onNodeWithTag("themeLoading").assertIsDisplayed()
        compose.onNodeWithTag("themeGone").assertDoesNotExist()
        // The settings are read: the theme shows.
        saved = copy
        loaded = true
        compose.onNodeWithTag("themeName").assertTextContains("Nord copy")
    }

    @Test
    fun aPreviewWhoseRendererDiesGoesAndReloadMakesAnother() {
        var made = 0
        var gone: (() -> Unit)? = null
        val fake = PreviewViews { context: Context, _, onReady, onGone ->
            made++
            EditorWebView.created()
            gone = onGone
            onReady()
            View(context)
        }
        compose.setContent { PenmossTheme { ThemePreview(copy, "light", Modifier.testTag("preview"), fake) } }
        compose.waitForIdle()
        assertEquals(1, EditorWebView.live.value)
        assertTrue(EditorWebView.previewOpen.value)
        // The renderer dies: its WebView goes, and the strip says so.
        compose.runOnUiThread { gone!!() }
        compose.onNodeWithTag("previewGone").assertIsDisplayed()
        assertEquals(0, EditorWebView.live.value)
        assertEquals(false, EditorWebView.previewOpen.value)
        compose.onNodeWithTag("previewReload").performClick()
        compose.waitForIdle()
        assertEquals(2, made)
        assertEquals(1, EditorWebView.live.value)
    }

    @Test
    fun aThemeMissingAColourIsShownWithoutAContrastCheck() {
        // Stored by another build: no text colour, and a token this build does not know.
        val light = (copy["light"] as JsonObject).filterKeys { it != "fg" } + ("futureToken" to kotlinx.serialization.json.JsonPrimitive("#123456"))
        editor(saved = JsonObject(copy + ("light" to JsonObject(light))))
        compose.onNodeWithTag("themeContrast").assertTextContains("contrast is not checked", substring = true)
        compose.onNodeWithTag("colour-bg").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun theColourSheetSaysWhichTokensAPickIsAndWhichIsChosenOnce() {
        editor()
        compose.onNodeWithTag("colour-bg").performScrollTo().performClick()
        val bg = ThemeEdits.colours(copy, "light").getValue("bg")
        compose.onNodeWithTag("pick-$bg").assertContentDescriptionContains("Page background", substring = true).assertIsSelected()
        val fg = ThemeEdits.colours(copy, "light").getValue("fg")
        compose.onNodeWithTag("pick-$fg").assertContentDescriptionContains("Text", substring = true).assertIsNotSelected()
        // The square says where it is; each slider is read once, by the slider itself.
        compose.onNodeWithTag("colourSquare").assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.StateDescription))
        compose.onAllNodes(hasText("Hue:", substring = true)).assertCountEquals(0)
        compose.onNodeWithTag("slider-Hue").assert(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("Hue")))
    }

    @Test
    fun anOpenColourSheetAndWhatWasTypedInItOutliveARestart() {
        val restoration = StateRestorationTester(compose)
        restoration.setContent { EditorUnderTest(copy) }
        compose.onNodeWithTag("colour-bg").performScrollTo().performClick()
        compose.onNodeWithTag("colourHex").performTextReplacement("#abcdef")
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithTag("colourHex").assertTextContains("#abcdef")
        compose.onNodeWithTag("useColour").performScrollTo().performClick()
        compose.mainClock.advanceTimeBy(THEME_SAVE_DELAY_MS + 100)
        assertEquals("#abcdef", ThemeEdits.colours(saves.last(), "light")["bg"])
    }
}
