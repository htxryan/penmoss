package app.penmoss.ui

import android.content.Context
import android.view.View
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.material3.Text
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.DirectoryRow
import app.penmoss.data.GraphSource
import app.penmoss.data.NoteLinkEntity
import app.penmoss.editor.EditorWebView
import app.penmoss.engine.bridge.FromGraph
import app.penmoss.engine.bridge.GraphProtocol
import app.penmoss.engine.bridge.GraphScope
import app.penmoss.engine.bridge.ToGraph
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The graph screen (T40 P7, LK7, LK8; A478, A479): what it sends the page and when, the
 * scope chips and depths, the large vault's start, the search field, the chip opening a note,
 * and never a second WebView. The page itself is tested in `graph.test.ts`.
 */
@RunWith(AndroidJUnit4::class)
class GraphScreenTest {
    @get:Rule
    val compose = createComposeRule()

    @After
    fun noWebViewLeft() {
        while (EditorWebView.live.value > 0) EditorWebView.destroyed()
        EditorWebView.previewClosed()
    }

    private val theme = buildJsonObject { put("id", JsonPrimitive("penmoss")) }
    private val sent = mutableListOf<ToGraph>()
    private val opened = mutableListOf<String>()
    private var toApp: ((String) -> Unit)? = null
    private var gone: (() -> Unit)? = null
    private var made = 0

    private val views = GraphViews { context: Context, onMessage, onGone ->
        made++
        EditorWebView.created()
        toApp = onMessage
        gone = onGone
        GraphPage(View(context)) { sent += GraphProtocol.decodeToGraph(it)!! }
    }

    private fun model(count: Int = 4) = GraphInput.model(
        GraphSource(
            listOf(
                DirectoryRow("a", "Garden", null),
                DirectoryRow("b", "Beds", null),
                DirectoryRow("d", "Dahlias", null),
                DirectoryRow("e", "Errands", null),
            ).take(count) + List((count - 4).coerceAtLeast(0)) { DirectoryRow("n$it", "Note $it", null) },
            listOf(NoteLinkEntity("a", "b"), NoteLinkEntity("b", "d")),
            emptyList(),
            "manual",
        ),
    )

    private fun show(model: GraphModel? = model(), note: String? = null) {
        compose.setContent {
            PenmossTheme {
                GraphScreen(model, theme, dark = true, note = note, onBack = {}, onOpen = { opened += it }, views = views)
            }
        }
        compose.waitForIdle()
    }

    private fun page(message: FromGraph) {
        compose.runOnUiThread { toApp!!(GraphProtocol.encode(message)) }
        compose.waitForIdle()
    }

    /** What the page was sent once the screen has settled after the last click. */
    private fun scopes(): List<GraphScope> {
        compose.waitForIdle()
        return sent.filterIsInstance<ToGraph.Scope>().map { it.scope }
    }

    @Test
    fun sendsTheThemeTheNotesThenWhatToShowOnceThePageIsReady() {
        show()
        assertEquals(1, made)
        // Nothing before the page listens.
        assertTrue(sent.isEmpty())
        page(FromGraph.Ready)
        assertEquals(
            listOf(ToGraph.Theme(theme, "dark"), model().message, ToGraph.Scope(GraphScope.Global)),
            sent,
        )
        page(FromGraph.Shown(4, 2))
        compose.onNodeWithTag("graphCount").assertTextEquals("4 notes · 2 links")
        // A reloaded page is sent everything again.
        sent.clear()
        page(FromGraph.Ready)
        assertEquals(3, sent.size)
    }

    @Test
    fun newNotesAreSentAsTheyArriveAndWhatToShowOnlyWhenItChanges() {
        var shown by mutableStateOf(model(3))
        compose.setContent {
            PenmossTheme { GraphScreen(shown, theme, dark = false, note = null, onBack = {}, onOpen = {}, views = views) }
        }
        compose.waitForIdle()
        page(FromGraph.Ready)
        sent.clear()
        shown = model(4)
        compose.waitForIdle()
        assertEquals(listOf(model(4).message), sent)
    }

    @Test
    fun fromANoteItOpensAroundItAndTheDepthChipsChooseHowFar() {
        show(note = "b")
        page(FromGraph.Ready)
        assertEquals(listOf<GraphScope>(GraphScope.Local("b", 2)), scopes())
        compose.onNodeWithText("Local Graph").assertIsDisplayed()
        compose.onNodeWithTag("graphLocal").assertTextContains("Around “Beds”")
        compose.onNodeWithTag("graphDepth-3").performClick()
        compose.onNodeWithTag("graphDepth-1").performClick()
        compose.onNodeWithTag("graphGlobal").performClick()
        compose.onNodeWithTag("graphDepth-1").assertDoesNotExist()
        compose.onNodeWithTag("graphLocal").performClick()
        assertEquals(
            listOf(
                GraphScope.Local("b", 2),
                GraphScope.Local("b", 3),
                GraphScope.Local("b", 1),
                GraphScope.Global,
                GraphScope.Local("b", 1),
            ),
            scopes(),
        )
    }

    @Test
    fun fromHomeEveryNoteAndNoLocalGraphUntilANoteIsPicked() {
        show()
        page(FromGraph.Ready)
        compose.onNodeWithText("Graph").assertIsDisplayed()
        compose.onNodeWithTag("graphLocal").assertIsNotEnabled()
        compose.onNodeWithTag("graphDepth-2").assertDoesNotExist()
    }

    @Test
    fun aLargeVaultOpensAroundTheNoteEditedLastWithShowEverything() {
        show(model(GraphInput.LARGE + 1))
        page(FromGraph.Ready)
        assertEquals(listOf<GraphScope>(GraphScope.Local("a", 2)), scopes())
        compose.onNodeWithTag("graphLarge").assertTextContains("1501 notes are a lot to draw on a phone", substring = true)
        compose.onNodeWithTag("graphShowAll").performClick()
        assertEquals(GraphScope.Global, scopes().last())
        compose.onNodeWithTag("graphLarge").assertDoesNotExist()
    }

    @Test
    fun searchBringsANoteToTheMiddleOrCentresTheLocalGraph() {
        show()
        page(FromGraph.Ready)
        compose.onNodeWithTag("graphSearch").performTextInput("dah")
        compose.onNodeWithTag("graphResult-d").assertTextEquals("Dahlias").performClick()
        compose.waitForIdle()
        assertEquals(ToGraph.Focus("d"), sent.last())
        compose.onNodeWithTag("graphResult-d").assertDoesNotExist()
        // The note picked is the one Around shows.
        compose.onNodeWithTag("graphLocal").assertTextContains("Around “Dahlias”").performClick()
        assertEquals(GraphScope.Local("d", 2), scopes().last())
        // In a local graph, a pick centres it there.
        compose.onNodeWithTag("graphSearch").performTextInput("gar")
        compose.onNodeWithTag("graphResult-a").performClick()
        assertEquals(GraphScope.Local("a", 2), scopes().last())
        compose.onNodeWithTag("graphSearch").performTextInput("zzz")
        compose.onNodeWithText("No notes match “zzz”").assertIsDisplayed()
    }

    @Test
    fun theChipOnThePageOpensTheNote() {
        show()
        page(FromGraph.Ready)
        page(FromGraph.Open("d"))
        assertEquals(listOf("d"), opened)
    }

    @Test
    fun waitsForTheNotesWebViewAndNeverMakesASecond() {
        // A note's WebView has not gone yet.
        EditorWebView.created()
        var alive by mutableStateOf(true)
        compose.setContent {
            PenmossTheme {
                if (alive) GraphScreen(model(), theme, dark = false, note = null, onBack = {}, onOpen = {}, views = views)
            }
        }
        compose.onNodeWithTag("graphWaiting").assertIsDisplayed()
        assertEquals(0, made)
        EditorWebView.destroyed()
        compose.waitForIdle()
        assertEquals(1, made)
        assertEquals(1, EditorWebView.live.value)
        // A note opened from here waits for this one (the note screen waits on previewOpen).
        assertTrue(EditorWebView.previewOpen.value)
        alive = false
        compose.waitForIdle()
        assertEquals(0, EditorWebView.live.value)
        assertFalse(EditorWebView.previewOpen.value)
    }

    @Test
    fun aRendererThatDiesSaysSoAndReloadMakesAnother() {
        show()
        compose.runOnUiThread { gone!!() }
        compose.onNodeWithTag("graphGone").assertIsDisplayed()
        assertEquals(0, EditorWebView.live.value)
        compose.onNodeWithTag("graphReload").performClick()
        compose.waitForIdle()
        assertEquals(2, made)
        assertEquals(1, EditorWebView.live.value)
        page(FromGraph.Ready)
        assertEquals(ToGraph.Scope(GraphScope.Global), sent.last())
    }

    @Test
    fun homesOverflowMenuOpensTheGraph() {
        var graphs = 0
        compose.setContent {
            PenmossTheme {
                app.penmoss.ui.screens.HomeScreen(
                    recent = emptyList(),
                    folders = emptyList(),
                    status = "Synced",
                    syncing = false,
                    onSearch = {},
                    onSettings = {},
                    onAllNotes = {},
                    onFolder = {},
                    onOpen = {},
                    onToday = {},
                    onNewNote = {},
                    onGraph = { graphs++ },
                )
            }
        }
        // An icon in Home's row (T51, A932), no longer in its ⋮ menu.
        compose.onNodeWithTag("homeGraph").assertContentDescriptionEquals("Graph").performClick()
        assertEquals(1, graphs)
    }

    @Test
    fun theGraphsRouteCarriesTheNoteItIsAround() {
        val notes = mutableListOf<String?>()
        lateinit var nav: NavHostController
        compose.setContent {
            PenmossTheme {
                nav = rememberNavController()
                NavHost(nav, startDestination = "home") {
                    composable("home") { Text("Home") }
                    composable(GRAPH_ROUTE, arguments = graphArguments) { entry ->
                        notes += entry.arguments?.getString("note")
                        Text("Graph ${entry.arguments?.getString("note")}")
                    }
                }
            }
        }
        compose.runOnUiThread { nav.navigate(graphRoute(null)) }
        compose.onNodeWithText("Graph null").assertIsDisplayed()
        compose.runOnUiThread { nav.navigate(graphRoute("01JD2Z7Q8R4T6Y8W0E2R4T6YB1")) }
        compose.onNodeWithText("Graph 01JD2Z7Q8R4T6Y8W0E2R4T6YB1").assertIsDisplayed()
        assertEquals(listOf(null, "01JD2Z7Q8R4T6Y8W0E2R4T6YB1"), notes.distinct())
    }
}
