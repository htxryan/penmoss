package app.penmoss.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import app.penmoss.ui.square.IconButton
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.penmoss.AppGraph
import app.penmoss.engine.api.SearchFilters
import app.penmoss.search.SearchAction
import app.penmoss.search.SearchActions
import app.penmoss.search.SearchOutcome
import app.penmoss.search.SearchRequest
import app.penmoss.search.SearchResult
import app.penmoss.search.SearchService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import androidx.compose.foundation.layout.size
import androidx.compose.ui.draw.alpha
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn

/** The Updated filter's choices, in the web's words (T40 P6, FD3): a label and its days back. */
internal val DATE_RANGES: List<Pair<String, Int?>> = listOf(
    "Any time" to null,
    "Past day" to 1,
    "Past week" to 7,
    "Past month" to 30,
    "Past year" to 365,
)

private const val DAY_MS = 86_400_000L

/** The search's filters as the screen shows them: the folder's and tag's names, and the range chosen. */
@Immutable
data class SearchFilterUi(
    val folderId: String? = null,
    val folderName: String? = null,
    val tag: String? = null,
    val range: Int = 0,
    /** Epoch ms, from when the range was chosen (as the web does). */
    val updatedAfter: Long? = null,
) {
    fun filters() = SearchFilters(folderId, tag, updatedAfter)

    companion object {
        private fun parts(value: SearchFilterUi): List<Any?> = listOf(value.folderId, value.folderName, value.tag, value.range, value.updatedAfter)

        private fun of(saved: List<Any?>): SearchFilterUi =
            SearchFilterUi(saved[0] as String?, saved[1] as String?, saved[2] as String?, saved[3] as Int, saved[4] as Long?)

        /** Kept across a rotation (review nit): the chips stay as chosen. */
        val Saver: Saver<SearchFilterUi, Any> = listSaver(save = { parts(it) }, restore = { of(it) })

        /** The query and filters Enter asked for, kept with them. */
        val SubmittedSaver: Saver<Pair<String, SearchFilterUi>?, Any> = listSaver(
            save = { value -> if (value == null) emptyList() else listOf<Any?>(value.first) + parts(value.second) },
            restore = { saved -> if (saved.isEmpty()) null else saved[0] as String to of(saved.drop(1)) },
        )
    }
}

/** What the result list shows: the answer, whether it is still coming, and what to say. */
@Immutable
data class SearchView(
    val results: List<SearchResult> = emptyList(),
    val searching: Boolean = false,
    val outcome: SearchOutcome? = null,
)

/** The status line under the filters, as the web's (`search-status`). */
internal fun searchStatus(query: String, view: SearchView): String {
    if (query.isBlank()) return "Type to search every note."
    val outcome = view.outcome ?: return if (view.searching) "Searching…" else ""
    val count = outcome.results.size
    val counted = if (count == 0) "No results" else "$count ${if (count == 1) "result" else "results"}"
    return counted + if (outcome.source == SearchOutcome.Source.DEVICE && !outcome.preview) " on this device" else ""
}

/**
 * Every tag a filter can name, nested ones with their parents (`area` for `area/cooking`), A–Z,
 * as the web's tag filter lists its tree.
 */
internal fun tagOptions(tags: Collection<String>): List<String> {
    val out = sortedSetOf<String>()
    for (tag in tags) {
        val levels = tag.split('/')
        for (depth in 1..levels.size) out += levels.take(depth).joinToString("/")
    }
    return out.toList()
}

/**
 * Search (T32; T40 P6, FD1–FD4): the field is the bar; under it the filters (Folder, Tag,
 * Updated) as chips, a status line (with "Words only" when meaning could not answer, T42), then
 * the results with the matched words painted as the web marks them. One search, Hybrid always
 * (A460): no mode to pick.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchScreen(
    query: String,
    onQuery: (String) -> Unit,
    view: SearchView,
    onBack: () -> Unit,
    onOpen: (String) -> Unit,
    filters: SearchFilterUi = SearchFilterUi(),
    onFilters: (SearchFilterUi) -> Unit = {},
    folderChoices: List<FolderChoice> = emptyList(),
    tags: List<String> = emptyList(),
    onSubmit: () -> Unit = {},
    onNoteLongPress: ((NoteItem) -> Unit)? = null,
    dateOf: (Long) -> String = { "" },
    now: () -> Long = System::currentTimeMillis,
    /** The Actions section above the notes (T40 P6, FD6): the commands the query finds. */
    actions: List<SearchAction> = emptyList(),
    onAction: (SearchAction) -> Unit = {},
) {
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    var picking by remember { mutableStateOf<String?>(null) }
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { app.penmoss.ui.settings.BackButton(onBack) },
                title = {
                    // The field is the bar itself, as in Android's own apps: no box inside the bar (T39).
                    TextField(
                        value = query,
                        onValueChange = onQuery,
                        modifier = Modifier.fillMaxWidth().focusRequester(focus).testTag("searchField"),
                        placeholder = { Text("Search notes") },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                        keyboardActions = KeyboardActions(onSearch = {
                            keyboard?.hide()
                            onSubmit()
                        }),
                        trailingIcon = {
                            if (query.isNotEmpty()) {
                                IconButton(onClick = {
                                    onQuery("")
                                    runCatching { focus.requestFocus() }
                                }) { Icon(Icons.Default.Close, contentDescription = "Clear") }
                            }
                        },
                        colors = TextFieldDefaults.colors(
                            focusedContainerColor = Color.Transparent,
                            unfocusedContainerColor = Color.Transparent,
                            focusedIndicatorColor = MaterialTheme.colorScheme.primary,
                            unfocusedIndicatorColor = Color.Transparent,
                        ),
                    )
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).imePadding()) {
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilterMenuChip(filters.folderName ?: "All folders", filters.folderId != null, "folderFilter") { picking = "folder" }
                FilterMenuChip(filters.tag?.let { "#$it" } ?: "Any tag", filters.tag != null, "tagFilter") { picking = "tag" }
                Box {
                    FilterMenuChip(DATE_RANGES[filters.range].first, filters.range != 0, "dateFilter") { picking = "date" }
                    DropdownMenu(expanded = picking == "date", onDismissRequest = { picking = null }) {
                        DATE_RANGES.forEachIndexed { index, (label, days) ->
                            DropdownMenuItem(
                                text = { Text(label) },
                                onClick = {
                                    picking = null
                                    onFilters(filters.copy(range = index, updatedAfter = days?.let { now() - it * DAY_MS }))
                                },
                                modifier = Modifier.testTag("range-$index"),
                            )
                        }
                    }
                }
            }
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)
                    .semantics { liveRegion = LiveRegionMode.Polite }.testTag("searchStatus"),
            ) {
                // Searching: a spinner beside the words, which moves nothing (T53 item 2: the bar
                // above pushed the list down and back).
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (view.searching && query.isNotBlank()) {
                        CircularProgressIndicator(Modifier.size(12.dp).testTag("searchSpinner"), strokeWidth = 2.dp)
                    }
                    Text(searchStatus(query, view), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                view.outcome?.notice?.takeIf { query.isNotBlank() }?.let {
                    Text(it, Modifier.testTag("searchNotice"), style = MaterialTheme.typography.bodyMedium)
                }
                // Quietly, as the web's (T42): the reason is its description, for TalkBack too.
                view.outcome?.takeIf { query.isNotBlank() && it.notice == null }?.wordsOnly?.let { reason ->
                    Text(
                        SearchService.WORDS_ONLY,
                        Modifier.semantics { contentDescription = "${SearchService.WORDS_ONLY}. $reason" }.testTag("searchWordsOnly"),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            val outcome = view.outcome
            if (query.isNotBlank() && outcome != null && !view.searching && view.results.isEmpty() && actions.isEmpty()) {
                EmptyMessage("No notes match “${query.trim()}”")
            }
            // The last results fade while the answer to what was typed is on its way.
            LazyColumn(Modifier.alpha(if (view.searching && query.isNotBlank()) 0.55f else 1f).testTag("searchResults")) {
                if (actions.isNotEmpty()) {
                    item(key = "actions", contentType = "heading") { SearchHeading("Actions") }
                    items(actions, key = { "action:${it.id}" }, contentType = { "action" }) { action ->
                        Text(
                            action.title,
                            Modifier.fillMaxWidth()
                                .clickable(role = Role.Button, onClickLabel = "Run") { onAction(action) }
                                .padding(horizontal = 16.dp, vertical = 12.dp)
                                .testTag("action-${action.id}"),
                            style = MaterialTheme.typography.bodyLarge,
                        )
                    }
                    if (view.results.isNotEmpty()) item(key = "notes", contentType = "heading") { SearchHeading("Notes") }
                }
                items(view.results, key = { it.id }, contentType = { "result" }) { result ->
                    SearchResultRow(result, onOpen, onNoteLongPress, dateOf)
                }
            }
        }
    }
    when (picking) {
        "folder" -> FolderPickerSheet(
            title = "Search in",
            // The first choice is the whole vault here, not the top level alone.
            choices = folderChoices.map { if (it.id == null) it.copy(name = "All folders") else it },
            current = filters.folderId,
            onPick = { id ->
                picking = null
                onFilters(filters.copy(folderId = id, folderName = folderChoices.firstOrNull { it.id == id && id != null }?.name))
            },
            onDismiss = { picking = null },
        )
        "tag" -> TagFilterSheet(tags, filters.tag, onPick = { tag ->
            picking = null
            onFilters(filters.copy(tag = tag))
        }, onDismiss = { picking = null })
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FilterMenuChip(label: String, selected: Boolean, tag: String, onClick: () -> Unit) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        trailingIcon = { Icon(Icons.Default.ArrowDropDown, contentDescription = null) },
        modifier = Modifier.testTag(tag),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TagFilterSheet(tags: List<String>, current: String?, onPick: (String?) -> Unit, onDismiss: () -> Unit) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Text("Tag", Modifier.padding(horizontal = 24.dp, vertical = 8.dp), style = MaterialTheme.typography.titleMedium)
        LazyColumn(Modifier.fillMaxWidth().testTag("tagChoices")) {
            items(listOf<String?>(null) + tags, key = { it ?: "" }) { tag ->
                val depth = tag?.count { it == '/' } ?: 0
                DropdownMenuItem(
                    text = {
                        Text(
                            tag?.let { "#$it" } ?: "Any tag",
                            Modifier.padding(start = (depth * 16).dp),
                            fontWeight = if (tag == current) FontWeight.SemiBold else null,
                        )
                    },
                    onClick = { onPick(tag) },
                    modifier = Modifier.semantics { if (tag == current) contentDescription = "${tag?.let { "#$it" } ?: "Any tag"}, chosen" },
                )
            }
        }
    }
}

/** Text marked with U+0002…U+0003, the matches painted as the web's `<mark>` (FD1). */
internal fun markedText(text: String, mark: SpanStyle): AnnotatedString = buildAnnotatedString {
    var marking = false
    var start = 0
    for (char in text) {
        when (char) {
            '\u0002' -> {
                marking = true
                start = length
            }
            '\u0003' -> if (marking) {
                if (length > start) addStyle(mark, start, length)
                marking = false
            }
            else -> append(char)
        }
    }
    if (marking && length > start) addStyle(mark, start, length)
}

/** A section's name in the results, as the palette's group headings ("Actions", "Notes"). */
@Composable
private fun SearchHeading(text: String) {
    Text(
        text,
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp).semantics { heading() },
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
    )
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun SearchResultRow(result: SearchResult, onOpen: (String) -> Unit, onLongPress: ((NoteItem) -> Unit)?, dateOf: (Long) -> String) {
    val haptics = LocalHapticFeedback.current
    val mark = SpanStyle(background = LocalSearchMatch.current, color = MaterialTheme.colorScheme.onSurface, fontWeight = FontWeight.SemiBold)
    val title = result.title.ifBlank { Items.UNTITLED }
    val item = NoteItem(result.id, title, Items.plainSnippet(result.snippet).ifBlank { result.excerpt }, dateOf(result.updatedAt))
    Column(
        Modifier.fillMaxWidth()
            .combinedClickable(
                role = Role.Button,
                onClickLabel = "Open",
                onLongClickLabel = if (onLongPress != null) "Note Actions" else null,
                onLongClick = onLongPress?.let { press ->
                    {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        press(item)
                    }
                },
            ) { onOpen(result.id) }
            .padding(horizontal = 16.dp, vertical = 10.dp)
            .testTag("result-${result.id}"),
    ) {
        Text(
            if (result.titleMarked.isNotEmpty()) markedText(result.titleMarked, mark) else AnnotatedString(title),
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        val meta = listOfNotNull(
            result.heading?.let { "› $it" },
            result.tags.takeIf { it.isNotEmpty() }?.joinToString(" ") { "#$it" },
            item.date.takeIf { it.isNotEmpty() },
        )
        if (meta.isNotEmpty() || result.semantic) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    meta.joinToString("  "),
                    Modifier.weight(1f, fill = false),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (result.semantic) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "≈",
                        Modifier.semantics { contentDescription = "Found by meaning" },
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
            }
        }
        val body = if (result.snippet.isNotBlank()) markedText(result.snippet, mark) else AnnotatedString(result.excerpt)
        if (body.isNotEmpty()) {
            Text(
                body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

/**
 * Search's route (T40 P6): the phone answers each keystroke at once, the server after a pause or
 * on Enter (A111), Hybrid always, with the filters chosen (kept across a rotation). Offline, no
 * pause: the phone's answer is the only one.
 */
@Composable
internal fun SearchRoute(
    graph: AppGraph,
    onBack: () -> Unit,
    onOpen: (String) -> Unit,
    onLongPress: (NoteItem) -> Unit,
    /** Opened by Ctrl+K (FD6): every action listed before anything is typed, and all that match after. */
    actionsFirst: Boolean = false,
    onAction: (SearchAction) -> Unit = {},
) {
    var query by rememberSaveable { mutableStateOf("") }
    var filters by rememberSaveable(stateSaver = SearchFilterUi.Saver) { mutableStateOf(SearchFilterUi()) }
    /** The request Enter asked the server to answer now (A111). */
    var submitted by rememberSaveable(stateSaver = SearchFilterUi.SubmittedSaver) { mutableStateOf<Pair<String, SearchFilterUi>?>(null) }
    val service = remember(graph) {
        SearchService(
            graph.api, graph.offlineSearch, { graph.onlineAgain.online.value },
            notebooks = graph::notebookScope, folderOf = graph.store::folderOf,
        )
    }
    val choices by remember {
        combine(graph.store.observeRootSortMode(), graph.store.observeFolders()) { sort, folders -> Items.folderChoices(sort, folders) }
            .distinctUntilChanged()
    }.collectAsStateWithLifecycle(emptyList())
    val tags by remember {
        // Coalesced while a first fill writes notes many times a second (review nit).
        // The tags of open notebooks' notes (T43, A752).
        combine(graph.store.observeTagCounts(graph.hiddenFolders).conflate(), graph.store.observeTagList()) { local, known ->
            tagOptions(local.map { it.tag } + known.map { it.name })
        }.conflate().distinctUntilChanged().flowOn(Dispatchers.Default)
    }.collectAsStateWithLifecycle(emptyList())
    val key = query to filters
    val view by produceState(SearchView(), key, submitted) {
        val text = query.trim()
        if (text.isEmpty()) {
            value = SearchView()
            return@produceState
        }
        val request = SearchRequest(query, filters.filters(), submitted = submitted == key)
        value = value.copy(searching = true)
        // The phone answers while typing; a preview the server will replace waits for it, to a
        // point (T53 item 2), so the results never shift under a finger. Offline, the phone's
        // answer is final and shows at once.
        var typed: SearchOutcome? = null
        if (!request.submitted) {
            delay(SearchService.TYPING_MS)
            typed = service.typing(request).also { if (!it.preview) value = SearchView(it.results, searching = true, outcome = it) }
        }
        val outcome = coroutineScope {
            val answer = async {
                if (!request.submitted) delay(SearchService.pauseMs(graph.onlineAgain.online.value) - SearchService.TYPING_MS)
                service.search(request)
            }
            val preview = typed?.takeIf { it.preview }
            if (preview != null && withTimeoutOrNull(SearchService.PREVIEW_HOLD_MS - SearchService.TYPING_MS) { answer.await() } == null) {
                value = SearchView(preview.results, searching = true, outcome = preview)
            }
            answer.await()
        }
        value = SearchView(outcome.results, searching = false, outcome = outcome)
    }
    val dates = remember { DateLabels(System.currentTimeMillis(), java.time.ZoneId.systemDefault()) }
    SearchScreen(
        query = query,
        onQuery = { query = it },
        view = view,
        onBack = onBack,
        onOpen = onOpen,
        filters = filters,
        onFilters = { filters = it },
        folderChoices = choices,
        tags = tags,
        onSubmit = { submitted = key },
        onNoteLongPress = onLongPress,
        dateOf = { if (it > 0) dates.label(it) else "" },
        actions = searchActionsFor(query, actionsFirst),
        onAction = onAction,
    )
}

/**
 * The Actions section for [query] (FD6): the actions it finds, best first, at most
 * [SearchActions.SHOWN] above the notes; opened by Ctrl+K ([actionsFirst]), every action before
 * anything is typed and every match after, as the palette lists commands.
 */
internal fun searchActionsFor(query: String, actionsFirst: Boolean): List<SearchAction> = when {
    query.isBlank() -> if (actionsFirst) SearchActions.ALL else emptyList()
    actionsFirst -> SearchActions.matching(query)
    else -> SearchActions.matching(query).take(SearchActions.SHOWN)
}
