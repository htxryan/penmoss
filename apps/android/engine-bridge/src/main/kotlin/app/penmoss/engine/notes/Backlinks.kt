package app.penmoss.engine.notes

import app.penmoss.engine.api.BacklinksReply
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The Info sheet's backlinks (T40 P7, LK5, LK6), as the web's Backlinks panel reads them
 * (`apps/web/src/notes/backlinks.ts`, `packages/ui/src/panels/Backlinks.tsx`): notes linking to
 * the open note, one entry per note with the text around each of its links, and notes that
 * mention its title without a link, their matched words marked.
 */

/** A wikilink or embed as the index stores it: [noteId] is null while it is unresolved. */
data class LinkRef(val noteId: String?, val target: String, val heading: String?, val alias: String?)

/** Text, or a link shown by its target's current title. */
sealed interface ContextPart {
    data class Text(val text: String) : ContextPart

    data class Link(val ref: LinkRef) : ContextPart
}

/** One block of a linking note around its links: [embed] for `![[…]]`. */
data class Mention(val context: List<ContextPart>, val embed: Boolean, val heading: String?)

data class LinkedNote(val id: String, val title: String, val updatedAt: Long, val mentions: List<Mention>)

/** Snippet text, with the runs that matched the title marked. */
data class SnippetPart(val text: String, val match: Boolean)

data class UnlinkedNote(val id: String, val title: String, val snippet: List<SnippetPart>)

/** Both lists, as the sheet shows them. */
data class BacklinkLists(val linked: List<LinkedNote>, val unlinked: List<UnlinkedNote>)

object Backlinks {
    /** The server's snippet markers (`apps/server/src/routes/backlinks.ts`). */
    private const val MATCH_START = '\u0002'
    private const val MATCH_END = '\u0003'
    private val SPACES = Regex("\\s+")

    /** How a link reads: its alias, else the target's title (or the written target) and heading. */
    fun linkLabel(ref: LinkRef, title: String?): String {
        ref.alias?.takeIf { it.isNotEmpty() }?.let { return it }
        val name = title ?: ref.target
        return if (!ref.heading.isNullOrEmpty()) "$name › ${ref.heading}" else name
    }

    /** A context as plain text, each link shown by [titleOf] (its current title, or null). */
    fun contextText(context: List<ContextPart>, titleOf: (String) -> String?): String =
        context.joinToString("") { part ->
            when (part) {
                is ContextPart.Text -> part.text
                is ContextPart.Link -> linkLabel(part.ref, part.ref.noteId?.let(titleOf))
            }
        }

    /** Splits a server snippet on its match markers, spaces folded, as the web's `snippetParts`. */
    fun snippetParts(snippet: String): List<SnippetPart> {
        val parts = mutableListOf<SnippetPart>()
        var rest = snippet
        while (rest.isNotEmpty()) {
            val start = rest.indexOf(MATCH_START)
            if (start == -1) {
                parts += SnippetPart(rest, false)
                break
            }
            if (start > 0) parts += SnippetPart(rest.substring(0, start), false)
            val end = rest.indexOf(MATCH_END, start)
            val stop = if (end == -1) rest.length else end
            parts += SnippetPart(rest.substring(start + 1, stop), true)
            rest = if (end == -1) "" else rest.substring(end + 1)
        }
        return parts.map { it.copy(text = it.text.replace(SPACES, " ")) }
    }

    /** One context part, or null for anything malformed (dropped, as the web drops it). */
    fun contextPart(element: JsonElement): ContextPart? {
        if (element is JsonPrimitive) return if (element.isString) ContextPart.Text(element.content) else null
        val item = element as? JsonObject ?: return null
        val target = item.text("target") ?: return null
        return ContextPart.Link(LinkRef(item.text("noteId"), target, item.text("heading"), item.text("alias")))
    }

    /**
     * The server's answer as the sheet shows it: one entry per linking note (most recently
     * edited first, as the server orders them), each block's text once even when it holds two
     * links here, and the mentions with their matched words marked.
     */
    fun lists(reply: BacklinksReply): BacklinkLists {
        val byNote = LinkedHashMap<String, Triple<String, Long, MutableList<Mention>>>()
        for (row in reply.linked) {
            if (row.id.isEmpty()) continue
            val entry = byNote.getOrPut(row.id) { Triple(row.title, row.updatedAt, mutableListOf()) }
            entry.third += Mention(row.context.mapNotNull(::contextPart), row.embed, row.heading)
        }
        val linked = byNote.map { (id, entry) -> LinkedNote(id, entry.first, entry.second, distinct(entry.third)) }
        val unlinked = reply.unlinked.filter { it.id.isNotEmpty() }.map { UnlinkedNote(it.id, it.title, snippetParts(it.snippet)) }
        return BacklinkLists(linked, unlinked)
    }

    /** One mention per block: two links in one paragraph share its text, which shows once. */
    fun distinct(mentions: List<Mention>): List<Mention> {
        val seen = HashSet<List<ContextPart>>()
        return mentions.filter { seen.add(it.context) }
    }

    private fun JsonObject.text(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString && this[key] !is JsonNull }?.content
}
