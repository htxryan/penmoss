package app.penmoss.ui

import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.ui.screens.FolderScreen
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * Quick repeated taps while a screen slides (T39): two taps on a note open it once, and two
 * taps on Back leave one screen, never the whole app (which left an empty, blank window).
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class NavigationTest {
    @get:Rule
    val compose = createComposeRule()

    private lateinit var nav: NavHostController

    private fun twoScreens() {
        compose.setContent {
            PenmossTheme {
                nav = rememberNavController()
                NavHost(nav, startDestination = "home") {
                    composable("home") { Text("Home") }
                    composable("folder") { entry ->
                        FolderScreen(
                            "Garden",
                            emptyList(),
                            listOf(NoteItem("n1", "Plan", "", "")),
                            onBack = { nav.leave(entry) },
                            onFolder = {},
                            onOpen = { nav.open("note/$it") },
                        )
                    }
                    composable("note/{id}") { Text("Note") }
                }
            }
        }
        compose.runOnUiThread { nav.navigate("folder") }
        compose.onNodeWithText("Garden").assertIsDisplayed()
    }

    @Test
    fun twoQuickTapsOnBackLeaveOneScreen() {
        twoScreens()
        // Two taps before the slide ends (the clock held, as on a slow phone).
        compose.mainClock.autoAdvance = false
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        assertEquals(listOf("home"), nav.currentBackStack.value.mapNotNull { it.destination.route })
        compose.onNodeWithText("Home").assertIsDisplayed()
    }

    @Test
    fun twoQuickTapsOnANoteOpenItOnce() {
        twoScreens()
        compose.mainClock.autoAdvance = false
        compose.onNodeWithText("Plan").performClick()
        compose.onNodeWithText("Plan").performClick()
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        assertEquals(listOf("home", "folder", "note/{id}"), nav.currentBackStack.value.mapNotNull { it.destination.route })
    }

    /** A link to a heading opens the note's route with it (T40 P7, LK3); a plain link has none. */
    @Test
    fun aNotesRouteCarriesTheHeadingALinkNamed() {
        val headings = mutableListOf<String?>()
        compose.setContent {
            PenmossTheme {
                nav = rememberNavController()
                NavHost(nav, startDestination = "home") {
                    composable("home") { Text("Home") }
                    composable(NOTE_ROUTE, arguments = noteArguments) { entry ->
                        headings += entry.arguments?.getString("heading")
                        Text("Note ${entry.arguments?.getString("id")}")
                    }
                }
            }
        }
        compose.runOnUiThread { nav.navigate(noteRouteAt("n1", "Beds & paths?")) }
        compose.onNodeWithText("Note n1").assertIsDisplayed()
        compose.runOnUiThread { nav.navigate(noteRouteAt("n2", null)) }
        compose.onNodeWithText("Note n2").assertIsDisplayed()
        compose.runOnUiThread { nav.navigate(newNoteRoute("n3", "f1")) }
        compose.onNodeWithText("Note n3").assertIsDisplayed()
        assertEquals(listOf("Beds & paths?", null), headings.distinct())
    }
}
