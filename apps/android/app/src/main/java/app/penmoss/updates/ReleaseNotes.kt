package app.penmoss.updates

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.intOrNull

/*
 * Release notes on Android (PEN-109, D67): which notes Settings → What's New shows, from
 * `release-notes.json` (.github/scripts/release-notes.mjs writes it). The same selection as the
 * Mac's `apps/web/src/updates/notes.ts`, for Android's notes: `contract/release-notes-v1.json`
 * holds the cases both check themselves against.
 *
 * - In This Version: a stable release's own notes (after the stable release before it, up to
 *   it); an Alpha build's since the version the phone ran before it, or only its own build's
 *   when that isn't known, never further back than the last stable release, each with its build.
 * - Earlier versions: an Alpha build's earlier builds since the last stable release, in one
 *   block, then each stable release older than this version's own notes, newest first.
 */

/** The `release-notes.json` schema this app reads; a newer file shows a link instead. */
const val NOTES_SCHEMA = 1

data class ReleaseNote(val build: Int, val pr: Int, val kind: String, val platform: String?, val text: String)

data class NotesRelease(val version: String, val tag: String, val build: Int, val date: String)

data class NotesFile(val schema: Int, val notes: List<ReleaseNote>, val releases: List<NotesRelease>)

data class NoteGroup(val kind: String, val label: String, val notes: List<ReleaseNote>)

/** One block: a heading and its notes grouped by kind (none when it has nothing to say). */
data class NotesBlock(val title: String, val builds: Boolean, val groups: List<NoteGroup>)

sealed interface NotesView {
    /** No file yet: Penmoss hasn't reached GitHub. */
    data object None : NotesView

    /** A file of a newer schema than this app reads: the notes are on GitHub. */
    data object Newer : NotesView

    data class Ok(val current: NotesBlock?, val earlier: List<NotesBlock>) : NotesView
}

private val KINDS = listOf("new" to "New", "improved" to "Improved", "fixed" to "Fixed")

private val ALPHA = Regex("""^\d+\.\d+\.\d+-alpha\.(\d+)$""")

/** `X.Y.Z-alpha.N`'s build N, or null for any other version. */
fun alphaBuildOf(version: String): Int? = ALPHA.matchEntire(version)?.groupValues?.get(1)?.toIntOrNull()

/** A version as the notes say it: "0.2.1", or "build 1185" for an Alpha build. */
fun versionLabel(version: String): String = alphaBuildOf(version)?.let { "build $it" } ?: version

/** A version as a heading names it (Title Case): "Build 1183", "0.2.1". */
private fun headingVersion(version: String): String = version.replaceFirstChar { it.uppercase() }

/** A version's build: an Alpha build's own number, or a stable release's from the file. */
fun buildFor(file: NotesFile, version: String): Int? =
    alphaBuildOf(version) ?: file.releases.firstOrNull { it.version == version }?.build

private fun before(file: NotesFile, build: Int): NotesRelease? =
    file.releases.filter { it.build < build }.maxByOrNull { it.build }

private fun range(file: NotesFile, from: Int?, to: Int, platform: String): List<ReleaseNote> =
    file.notes.filter { (it.platform == null || it.platform == platform) && it.build <= to && (from == null || it.build > from) }

fun groupNotes(notes: List<ReleaseNote>): List<NoteGroup> =
    KINDS.map { (kind, label) -> NoteGroup(kind, label, notes.filter { it.kind == kind }) }.filter { it.notes.isNotEmpty() }

private fun releaseBlock(file: NotesFile, release: NotesRelease, platform: String) =
    NotesBlock(release.version, false, groupNotes(range(file, before(file, release.build)?.build, release.build, platform)))

/**
 * What What's New shows for this app's [current] version; [since] is the version the phone ran
 * before it (null when not known), where an Alpha build's notes start.
 */
fun notesView(file: NotesFile?, current: String, platform: String = "android", since: String? = null): NotesView {
    if (file == null) return NotesView.None
    if (file.schema > NOTES_SCHEMA) return NotesView.Newer
    val here = buildFor(file, current)
    val alpha = alphaBuildOf(current) != null
    val base = here?.let { before(file, if (alpha) it + 1 else it) }
    val start = if (here != null && alpha) alphaStart(file, here, base, since) else null
    val currentBlock = when {
        here == null -> null
        start != null -> NotesBlock(
            title = start.second?.let { "In This Version (Since ${headingVersion(it)})" } ?: "In This Version",
            builds = true,
            groups = groupNotes(range(file, start.first, here, platform)),
        )
        else -> releaseBlock(file, NotesRelease(current, "v$current", here, ""), platform).copy(title = "In This Version")
    }
    val stable = file.releases.sortedBy { it.build }
    val releases = when {
        here == null -> stable.reversed().map { releaseBlock(file, it, platform) }
        else -> {
            val floor = if (alpha) base?.build else before(file, here)?.build
            if (floor == null) emptyList() else stable.filter { it.build <= floor }.reversed().map { releaseBlock(file, it, platform) }
        }
    }
    val builds = start?.let { groupNotes(range(file, base?.build, it.first, platform)) }.orEmpty()
    val earlier = if (builds.isEmpty()) releases else {
        listOf(NotesBlock(base?.let { "Earlier Builds (Since ${it.version})" } ?: "Earlier Builds", true, builds)) + releases
    }
    return NotesView.Ok(currentBlock, earlier)
}

/**
 * Where an Alpha build's notes start, and what the heading says they are since: after [since]
 * when it is an older build since the last stable release; after that release when [since] is
 * from before it; otherwise after the build before this one, so only this build's own notes.
 */
private fun alphaStart(file: NotesFile, here: Int, base: NotesRelease?, since: String?): Pair<Int, String?> {
    val previous = since?.takeIf { it.isNotEmpty() }?.let { buildFor(file, it) }
    if (since != null && previous != null && previous < here) {
        return if (base == null || previous > base.build) previous to versionLabel(since) else base.build to base.version
    }
    return (here - 1) to null
}

/**
 * The snackbar after the version changed: the version as people read it, when the phone ran
 * [updatedFrom] before and this version has notes for it; null otherwise.
 */
fun updatedNotice(file: NotesFile?, current: String, updatedFrom: String?, platform: String = "android"): String? {
    if (updatedFrom.isNullOrEmpty()) return null
    val view = notesView(file, current, platform, updatedFrom) as? NotesView.Ok ?: return null
    return if (view.current?.groups?.isNotEmpty() == true) versionLabel(current) else null
}

/** A note as a line: its text, its platform when only one has it, and its build on Alpha. */
fun noteLine(note: ReleaseNote, builds: Boolean): String = if (builds) "${note.text} (build ${note.build})" else note.text

private fun JsonObject.int(key: String): Int? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull

private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/**
 * `release-notes.json` as this app reads it, or null when it isn't one. A newer schema is kept as
 * just its number; schema 1 must be whole.
 */
fun parseNotes(text: String): NotesFile? {
    val root = runCatching { Json.parseToJsonElement(text) }.getOrNull() as? JsonObject ?: return null
    val schema = root.int("schema") ?: return null
    if (schema < 1) return null
    if (schema > NOTES_SCHEMA) return NotesFile(schema, emptyList(), emptyList())
    val notes = (root["notes"] as? JsonArray ?: return null).map { element ->
        val o = element as? JsonObject ?: return null
        val kind = o.text("kind")?.takeIf { k -> KINDS.any { it.first == k } } ?: return null
        val platform = when (val p = o["platform"]) {
            null, JsonNull -> null
            else -> (p as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it == "mac" || it == "android" } ?: return null
        }
        ReleaseNote(o.int("build") ?: return null, o.int("pr") ?: return null, kind, platform, o.text("text") ?: return null)
    }
    val releases = (root["releases"] as? JsonArray ?: return null).map { element ->
        val o = element as? JsonObject ?: return null
        NotesRelease(o.text("version") ?: return null, o.text("tag") ?: return null, o.int("build") ?: return null, o.text("date").orEmpty())
    }
    return NotesFile(schema, notes, releases)
}
