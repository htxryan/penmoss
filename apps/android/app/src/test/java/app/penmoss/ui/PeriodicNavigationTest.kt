package app.penmoss.ui

import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavHostController
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * Today, This week and the calendar open a transient periodic screen that the made note then
 * replaces (T40 P5 review B1), through the app's own NavHost and its slide transitions.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PeriodicNavigationTest {
    @get:Rule
    val compose = createComposeRule()

    private lateinit var nav: NavHostController
    private var periodic: NavBackStackEntry? = null

    private fun routes() = nav.currentBackStack.value.mapNotNull { it.destination.route }

    /** Home, then Today's transient screen, as Home's Today button opens it. */
    private fun todayOpen() {
        compose.setContent {
            PenmossTheme {
                nav = rememberNavController()
                PenmossNavHost(nav, startDestination = "home") {
                    composable("home") { Text("Home") }
                    composable(PERIODIC_ROUTE, arguments = periodicArguments) { entry ->
                        periodic = entry
                        Text("Today")
                    }
                    composable(NOTE_ROUTE, arguments = noteArguments) { entry -> Text("Note ${entry.arguments?.getString("id")}") }
                }
            }
        }
        compose.runOnUiThread { nav.open(periodicNoteRoute("daily", null)) }
        compose.onNodeWithText("Today").assertIsDisplayed()
    }

    @Test
    fun todayOpensTheMadeNoteAndBackReturnsHome() {
        todayOpen()
        compose.runOnUiThread { nav.replaceWithNote(periodic!!, "d1") }
        compose.waitForIdle()
        assertEquals(listOf("home", NOTE_ROUTE), routes())
        compose.onNodeWithText("Note d1").assertIsDisplayed()
        compose.runOnUiThread { nav.popBackStack() }
        compose.waitForIdle()
        assertEquals(listOf("home"), routes())
        compose.onNodeWithText("Home").assertIsDisplayed()
    }

    @Test
    fun aNoteMadeAfterBackOpensNothing() {
        todayOpen()
        val entry = periodic!!
        compose.runOnUiThread { nav.popBackStack() }
        compose.waitForIdle()
        // The page answers late, the controller living on the app's scope: Home stays in front.
        compose.runOnUiThread { assertFalse(nav.replaceWithNote(entry, "d1")) }
        compose.waitForIdle()
        assertEquals(listOf("home"), routes())
    }
}
