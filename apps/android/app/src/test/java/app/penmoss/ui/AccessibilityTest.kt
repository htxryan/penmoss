package app.penmoss.ui

import android.content.Context
import android.provider.Settings
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.ui.screens.HomeScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * The accessibility pass (T40 P9, PL14, A498), as far as Robolectric reaches: headings for
 * TalkBack's headings navigation, a row's long press named for TalkBack's actions, touch targets of
 * 48 dp, and no slide when the phone removes animations. TalkBack itself, Switch Access and the
 * Accessibility Scanner are the Pixel's (docs/android.md, T40 P9 checklist).
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AccessibilityTest {
    @get:Rule
    val compose = createComposeRule()

    private fun home() {
        compose.setContent {
            PenmossTheme {
                HomeScreen(
                    recent = listOf(NoteItem("n1", "Groceries", "eggs, milk", "Oct 21")),
                    folders = listOf(FolderItem("f1", "Projects")),
                    status = "Synced at 3:42 PM",
                    syncing = false,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = {},
                    onToday = {},
                    onThisWeek = {},
                    onJournal = {},
                    onNewNote = {},
                    onNoteLongPress = {},
                    onFolderLongPress = {},
                )
            }
        }
    }

    @Test
    fun aListsSectionsAreHeadings() {
        compose.setContent { PenmossTheme { SectionTitle("Recent") } }
        compose.onNodeWithText("Recent").assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading))
    }

    @Test
    fun aRowsLongPressIsNamedForTalkBack() {
        home()
        compose.onNodeWithText("Groceries").assert(
            SemanticsMatcher("long press named Note Actions") {
                it.config.getOrElseNullable(SemanticsActions.OnLongClick) { null }?.label == "Note Actions"
            },
        )
        compose.onNodeWithText("Projects").assert(
            SemanticsMatcher("long press named Folder Actions") {
                it.config.getOrElseNullable(SemanticsActions.OnLongClick) { null }?.label == "Folder Actions"
            },
        )
    }

    @Test
    fun homesButtonsAreTouchTargets() {
        home()
        // Home's row of icons too (T51, A932): Search, Today, This Week, Graph and Commands.
        for (label in listOf("Search", "Today", "This Week", "Graph", "Commands", "New Note", "Settings", "Sync Now", "More Options")) {
            assertTouchTarget(compose, compose.onNodeWithContentDescription(label), label)
        }
    }

    @Test
    fun screensDoNotSlideWhenThePhoneRemovesAnimations() {
        val context: Context = ApplicationProvider.getApplicationContext()
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        assertFalse(reducedMotion(context))
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        assertTrue(reducedMotion(context))
        Settings.Global.putFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        assertEquals(false, reducedMotion(context))
    }
}

/**
 * Asserts [node] takes touches over at least 48 by 48 dp (Android's and WCAG's touch target). A
 * Material icon button draws 40 dp and reserves 48 around it (`minimumInteractiveComponentSize`),
 * so its layout's size is the target, not the bounds its semantics report.
 */
internal fun assertTouchTarget(rule: ComposeContentTestRule, node: SemanticsNodeInteraction, name: String) {
    val layout = node.fetchSemanticsNode().layoutInfo
    val (width, height) = with(rule.density) { layout.width.toDp() to layout.height.toDp() }
    assertTrue("$name takes touches over $width by $height", width >= 48.dp && height >= 48.dp)
}
