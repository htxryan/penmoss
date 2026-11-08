package app.penmoss.ui

import android.content.Context
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import app.penmoss.ui.square.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import app.penmoss.ui.square.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavType
import androidx.navigation.navArgument
import app.penmoss.AppGraph
import app.penmoss.editor.EditorWebView
import app.penmoss.engine.bridge.FromGraph
import app.penmoss.engine.bridge.GraphProtocol
import app.penmoss.engine.bridge.GraphScope
import app.penmoss.engine.bridge.ToGraph
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.transform
import kotlinx.serialization.json.JsonObject

/** The graph's route (T40 P7): every note, or `graph?note=<id>` for that note's local graph. */
internal const val GRAPH_ROUTE = "graph?note={note}"

internal val graphArguments = listOf(
    navArgument("note") {
        type = NavType.StringType
        nullable = true
        defaultValue = null
    },
)

/** The route to the graph; around [note] when one is given. */
fun graphRoute(note: String?): String = if (note == null) "graph" else "graph?note=${Uri.encode(note)}"

/** The graph page in a WebView, and how to send it a message. */
class GraphPage(val view: View, val send: (String) -> Unit)

/** What the graph screen needs of a WebView: made with the page's listener and told when its renderer has gone. */
fun interface GraphViews {
    fun create(context: Context, onMessage: (String) -> Unit, onGone: () -> Unit): GraphPage
}

/** The APK's `graph.html` (A478): the editor's origin, CSP and request blocking, no links out. */
val GRAPH_PAGE = GraphViews { context, onMessage, onGone ->
    val channel = EditorWebView.Channel()
    val view = EditorWebView.create(
        context,
        channel,
        onMessage = onMessage,
        onRendererGone = onGone,
        openLinks = false,
        page = EditorWebView.GRAPH_PAGE,
    )
    GraphPage(view, channel::send)
}

/**
 * What the page has been sent, so each change goes once (T40 P7, A478): the theme, the notes,
 * then what to show, in that order; a reloaded page is sent everything again ([reset]).
 */
class GraphFeed(private val send: (String) -> Unit) {
    private var theme: ToGraph.Theme? = null
    private var graph: ToGraph.Graph? = null
    private var scope: GraphScope? = null

    fun reset() {
        theme = null
        graph = null
        scope = null
    }

    fun update(theme: ToGraph.Theme?, graph: ToGraph.Graph?, scope: GraphScope?) {
        if (theme != null && theme != this.theme) {
            send(GraphProtocol.encode(theme))
            this.theme = theme
        }
        if (graph == null) return
        if (graph != this.graph) {
            send(GraphProtocol.encode(graph))
            this.graph = graph
        }
        if (scope != null && scope != this.scope) {
            send(GraphProtocol.encode(ToGraph.Scope(scope)))
            this.scope = scope
        }
    }

    fun focus(noteId: String) = send(GraphProtocol.encode(ToGraph.Focus(noteId)))
}

/**
 * The first value at once, then the latest at most every [ms] (review N5): a big sync changes
 * Room's notes and links many times in a row, and each graph sent is laid out again whole.
 */
internal fun <T> Flow<T>.atMostEvery(ms: Long): Flow<T> = conflate().transform {
    emit(it)
    delay(ms)
}

/** How often Room's changes re-send the graph while they keep coming. */
internal const val GRAPH_BATCH_MS = 250L

/** The graph (LK7) from Home, or a note's local graph (LK8) when [note] is set. */
@Composable
fun GraphRoute(graph: AppGraph, note: String?, onBack: () -> Unit, onOpen: (String) -> Unit) {
    val model by remember {
        // Open notebooks only (T43, A752).
        graph.store.observeGraph(graph.hiddenFolders).atMostEvery(GRAPH_BATCH_MS).map(GraphInput::model).distinctUntilChanged().flowOn(Dispatchers.Default)
    }.collectAsStateWithLifecycle(null)
    val appearance by graph.appearance.collectAsStateWithLifecycle()
    val dark = appearance.isDark(isSystemInDarkTheme())
    GraphScreen(model, appearance.theme, dark, note, onBack, onOpen)
}

/**
 * The graph page (T40 P7, LK7, LK8; A478, A479): the web's graph under touch in a WebView,
 * fed from Room. The top bar counts what is shown; under it a search field brings a note to
 * the middle, and chips choose every note or the notes around one, 1 to 3 links deep. Past
 * [GraphInput.LARGE] notes it opens around the newest note, with Show everything. Never
 * beside another of the app's WebViews (A418): it waits for a note's to go, and a note's
 * waits for it (it counts as the preview the note screen already waits for).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GraphScreen(
    model: GraphModel?,
    theme: JsonObject?,
    dark: Boolean,
    note: String?,
    onBack: () -> Unit,
    onOpen: (String) -> Unit,
    views: GraphViews = GRAPH_PAGE,
) {
    // Where it opens is decided once the notes are read; saved, so a rotation keeps it.
    var decided by rememberSaveable { mutableStateOf(false) }
    var local by rememberSaveable { mutableStateOf(false) }
    var centre by rememberSaveable { mutableStateOf(note) }
    var depth by rememberSaveable { mutableIntStateOf(GraphInput.DEFAULT_DEPTH) }
    var large by rememberSaveable { mutableStateOf(false) }
    if (!decided && model != null) {
        val start = GraphInput.start(model, note)
        local = start.scope is GraphScope.Local
        centre = (start.scope as? GraphScope.Local)?.noteId ?: note
        large = start.large
        decided = true
    }
    val around = centre?.takeIf { model?.ids?.contains(it) == true }
    val scope: GraphScope? = when {
        model == null || !decided -> null
        local && around != null -> GraphScope.Local(around, depth)
        else -> GraphScope.Global
    }
    var shown by remember { mutableStateOf<FromGraph.Shown?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    val focus = LocalFocusManager.current

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(if (scope is GraphScope.Local) "Local Graph" else "Graph")
                        shown?.let {
                            Text(
                                GraphInput.count(it.notes, it.links),
                                Modifier.testTag("graphCount").semantics { liveRegion = LiveRegionMode.Polite },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            OutlinedTextField(
                value = query,
                onValueChange = { query = it },
                label = { Text("Find a note") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("graphSearch"),
            )
            val matches = remember(model, query) { model?.let { GraphInput.matches(it, query) }.orEmpty() }
            var feed by remember { mutableStateOf<GraphFeed?>(null) }
            if (query.isNotBlank()) {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
                    if (matches.isEmpty()) {
                        Text(
                            // Search's words, with what was typed (T39 pass 3, A554).
                            "No notes match “${query.trim()}”",
                            Modifier.padding(vertical = 12.dp),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    for (match in matches) {
                        Text(
                            match.title,
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .clickable {
                                    query = ""
                                    focus.clearFocus()
                                    // A local graph centres on the note picked; with every note
                                    // shown it comes to the middle, and Around offers its graph.
                                    val wasLocal = scope is GraphScope.Local
                                    centre = match.id
                                    if (!wasLocal) feed?.focus(match.id)
                                }
                                .padding(vertical = 12.dp)
                                .testTag("graphResult-${match.id}"),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                FilterChip(
                    selected = scope !is GraphScope.Local,
                    onClick = {
                        local = false
                        large = false
                    },
                    label = { Text("All Notes") },
                    modifier = Modifier.testTag("graphGlobal"),
                )
                FilterChip(
                    selected = scope is GraphScope.Local,
                    enabled = around != null,
                    onClick = { local = true },
                    label = {
                        Text(
                            around?.let { "Around “${model?.titleOf(it)}”" } ?: "This Note",
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    modifier = Modifier.testTag("graphLocal"),
                )
                if (scope is GraphScope.Local) {
                    for (value in GraphProtocol.DEPTHS) {
                        FilterChip(
                            selected = depth == value,
                            onClick = { depth = value },
                            label = { Text(if (value == 1) "1 link" else "$value links") },
                            modifier = Modifier.testTag("graphDepth-$value"),
                        )
                    }
                }
            }
            if (large && scope is GraphScope.Local && model != null) {
                Row(
                    Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        "${model.entries.size} notes are a lot to draw on a phone, so the graph starts around the note edited last.",
                        Modifier.weight(1f).testTag("graphLarge"),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    TextButton(
                        onClick = {
                            local = false
                            large = false
                        },
                        modifier = Modifier.testTag("graphShowAll"),
                    ) { Text("Show Everything") }
                }
            }
            HorizontalDivider(Modifier.padding(top = 8.dp))
            GraphView(
                Modifier.weight(1f).fillMaxWidth(),
                views,
                onFeed = { feed = it },
                onMessage = { message ->
                    when (message) {
                        FromGraph.Ready -> Unit
                        is FromGraph.Shown -> shown = message
                        is FromGraph.Open -> onOpen(message.noteId)
                    }
                },
                theme = theme?.let { ToGraph.Theme(it, if (dark) "dark" else "light") },
                graph = model?.message,
                scope = scope,
            )
        }
    }
}

/** The page itself: made once no other WebView is alive, fed through a [GraphFeed]. */
@Composable
private fun GraphView(
    modifier: Modifier,
    views: GraphViews,
    onFeed: (GraphFeed?) -> Unit,
    onMessage: (FromGraph) -> Unit,
    theme: ToGraph.Theme?,
    graph: ToGraph.Graph?,
    scope: GraphScope?,
) {
    val live by EditorWebView.live.collectAsStateWithLifecycle()
    var page by remember { mutableStateOf<GraphPage?>(null) }
    var gone by remember { mutableStateOf(false) }
    // Each page made here and each time it said ready: everything is sent again.
    var made by remember { mutableIntStateOf(0) }
    var ready by remember { mutableIntStateOf(0) }
    fun release() {
        when (val view = page?.view) {
            is WebView -> {
                (view.parent as? ViewGroup)?.removeView(view)
                EditorWebView.destroy(view)
            }
            null -> Unit
            // Only a test's stand-in page, a plain View: counted out as a WebView would be.
            else -> EditorWebView.destroyed()
        }
        page = null
        ready = 0
        onFeed(null)
        EditorWebView.previewClosed()
    }
    DisposableEffect(Unit) { onDispose { release() } }
    when {
        gone -> {
            Column(modifier, verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                Text("Graph unavailable", Modifier.testTag("graphGone"), color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(
                    onClick = {
                        gone = false
                        made++
                    },
                    modifier = Modifier.testTag("graphReload"),
                ) { Text("Reload") }
            }
            return
        }
        page == null && live > 0 -> {
            Box(modifier, contentAlignment = Alignment.Center) {
                Text(
                    "The graph opens once the note has closed.",
                    Modifier.testTag("graphWaiting"),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            return
        }
    }
    val feed = remember(page) { page?.let { GraphFeed(it.send) } }
    key(made) {
        AndroidView(
            factory = { context ->
                EditorWebView.previewOpened()
                views.create(
                    context,
                    onMessage = { raw ->
                        val message = GraphProtocol.decodeFromGraph(raw) ?: return@create
                        if (message == FromGraph.Ready) ready++
                        onMessage(message)
                    },
                    onGone = {
                        release()
                        gone = true
                    },
                ).also { page = it }.view
            },
            modifier = modifier,
        )
    }
    LaunchedEffect(feed) { onFeed(feed) }
    LaunchedEffect(feed, ready) { feed?.reset() }
    LaunchedEffect(feed, ready, theme, graph, scope) { if (ready > 0) feed?.update(theme, graph, scope) }
}
