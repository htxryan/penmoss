package app.penmoss.engine.bridge

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/**
 * The app's side of the graph page's bridge (T40 P7, LK7, LK8; A478); the page's side is
 * `apps/android/editor/src/graph-protocol.ts`, and `apps/android/contract/graph-v1.json` holds
 * an example of every message for both test suites. The page is a second page in the APK,
 * `graph.html`, on the editor's `penmossNative` listener, origin and CSP (A293). It gets titles,
 * top-level folders and links from Room, never note content. Version 1 grows by adding messages.
 */
const val GRAPH_VERSION = 1

/** A note as the graph draws it: its title, its top-level folder (null: the top level), its links. */
data class GraphNote(val id: String, val title: String, val group: String?, val links: List<String>)

/** A top-level folder in the lists' order; a null id is the top level itself. */
data class GraphGroup(val id: String?, val name: String)

/** What the graph shows: every note, or the notes within [depth] links of one (LK8). */
sealed interface GraphScope {
    data object Global : GraphScope

    data class Local(val noteId: String, val depth: Int) : GraphScope
}

sealed interface ToGraph {
    /** The phone's notes and links, sent again whenever Room's change. */
    data class Graph(val notes: List<GraphNote>, val groups: List<GraphGroup>) : ToGraph

    data class Scope(val scope: GraphScope) : ToGraph

    /** A note picked in the search field: the page brings it to the middle with its chip. */
    data class Focus(val noteId: String) : ToGraph

    /** The theme to draw with (A305), as the editor page gets it. */
    data class Theme(val theme: JsonObject, val variant: String) : ToGraph
}

sealed interface FromGraph {
    data object Ready : FromGraph

    /** What the page shows now: the top bar's count. */
    data class Shown(val notes: Int, val links: Int) : FromGraph

    /** The chip was tapped: open this note. */
    data class Open(val noteId: String) : FromGraph
}

object GraphProtocol {
    private val NOTE_ID = Regex("^[A-Za-z0-9_-]{1,80}$")

    /** The depths a local graph offers on the phone: 1 to 3 links (LK8). */
    val DEPTHS = listOf(1, 2, 3)

    /** More than any vault Penmoss is built for (D20 tests 2,000 notes). */
    const val MAX_NOTES = 20_000

    /** The links one note may bring (the editor page reports at most 1,000, A473). */
    const val MAX_NOTE_LINKS = 1000

    /** Longer than any title or folder name the server keeps (300). */
    const val MAX_TEXT = 1000

    fun encode(message: ToGraph): String = buildJsonObject {
        put("v", GRAPH_VERSION)
        when (message) {
            is ToGraph.Graph -> {
                put("type", "graph")
                putJsonArray("notes") {
                    for (note in message.notes) {
                        addJsonObject {
                            put("id", note.id)
                            put("title", note.title.take(MAX_TEXT))
                            put("group", note.group?.let(::JsonPrimitive) ?: JsonNull)
                            putJsonArray("links") { note.links.take(MAX_NOTE_LINKS).forEach { add(it) } }
                        }
                    }
                }
                putJsonArray("groups") {
                    for (group in message.groups) {
                        addJsonObject {
                            put("id", group.id?.let(::JsonPrimitive) ?: JsonNull)
                            put("name", group.name.take(MAX_TEXT))
                        }
                    }
                }
            }
            is ToGraph.Scope -> {
                put("type", "scope")
                putJsonObject("scope") {
                    when (val scope = message.scope) {
                        GraphScope.Global -> put("kind", "global")
                        is GraphScope.Local -> {
                            put("kind", "local")
                            put("noteId", scope.noteId)
                            put("depth", scope.depth)
                        }
                    }
                }
            }
            is ToGraph.Focus -> {
                put("type", "focus")
                put("noteId", message.noteId)
            }
            is ToGraph.Theme -> {
                put("type", "theme")
                put("theme", message.theme)
                put("variant", message.variant)
            }
        }
    }.toString()

    fun encode(message: FromGraph): String = buildJsonObject {
        put("v", GRAPH_VERSION)
        when (message) {
            FromGraph.Ready -> put("type", "ready")
            is FromGraph.Shown -> {
                put("type", "shown")
                put("notes", message.notes)
                put("links", message.links)
            }
            is FromGraph.Open -> {
                put("type", "open")
                put("noteId", message.noteId)
            }
        }
    }.toString()

    /** Reads a message from the page; null for anything malformed or of another version. */
    fun decodeFromGraph(raw: String): FromGraph? {
        val value = parse(raw) ?: return null
        return when (value.string("type")) {
            "ready" -> FromGraph.Ready
            "shown" -> FromGraph.Shown(value.count("notes") ?: return null, value.count("links") ?: return null)
            "open" -> FromGraph.Open(value.string("noteId")?.takeIf(NOTE_ID::matches) ?: return null)
            else -> null
        }
    }

    /** Reads a message to the page (the page's own parser is in TypeScript; this is for tests). */
    fun decodeToGraph(raw: String): ToGraph? {
        val value = parse(raw) ?: return null
        return when (value.string("type")) {
            "graph" -> {
                val notes = (value["notes"] as? JsonArray)?.takeIf { it.size <= MAX_NOTES }?.map { entry ->
                    val item = entry as? JsonObject ?: return null
                    val links = (item["links"] as? JsonArray)?.takeIf { it.size <= MAX_NOTE_LINKS }?.map {
                        (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content?.takeIf(NOTE_ID::matches) ?: return null
                    } ?: return null
                    GraphNote(
                        item.string("id")?.takeIf(NOTE_ID::matches) ?: return null,
                        item.string("title")?.takeIf { it.length <= MAX_TEXT } ?: return null,
                        (item.nullableId("group") ?: return null).value,
                        links,
                    )
                } ?: return null
                val groups = (value["groups"] as? JsonArray)?.map { entry ->
                    val item = entry as? JsonObject ?: return null
                    GraphGroup(
                        (item.nullableId("id") ?: return null).value,
                        item.string("name")?.takeIf { it.length <= MAX_TEXT } ?: return null,
                    )
                } ?: return null
                ToGraph.Graph(notes, groups)
            }
            "scope" -> {
                val scope = value["scope"] as? JsonObject ?: return null
                when (scope.string("kind")) {
                    "global" -> ToGraph.Scope(GraphScope.Global)
                    "local" -> ToGraph.Scope(
                        GraphScope.Local(
                            scope.string("noteId")?.takeIf(NOTE_ID::matches) ?: return null,
                            scope.count("depth")?.takeIf { it in DEPTHS } ?: return null,
                        ),
                    )
                    else -> null
                }
            }
            "focus" -> ToGraph.Focus(value.string("noteId")?.takeIf(NOTE_ID::matches) ?: return null)
            "theme" -> {
                val theme = value["theme"] as? JsonObject ?: return null
                val variant = value.string("variant")?.takeIf { it == "light" || it == "dark" } ?: return null
                ToGraph.Theme(theme, variant)
            }
            else -> null
        }
    }

    private fun parse(raw: String): JsonObject? {
        val value = runCatching { Json.parseToJsonElement(raw) }.getOrNull() as? JsonObject ?: return null
        val version = (value["v"] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
        return value.takeIf { version == GRAPH_VERSION }
    }

    private class Field<T>(val value: T)

    /** An id that may be null (the top level); a missing key or a bad id is malformed. */
    private fun JsonObject.nullableId(key: String): Field<String?>? = when (val raw = this[key]) {
        null -> null
        is JsonNull -> Field(null)
        else -> (raw as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf(NOTE_ID::matches)?.let { Field(it) }
    }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

    private fun JsonObject.count(key: String): Int? =
        (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull?.takeIf { it >= 0 }
}
