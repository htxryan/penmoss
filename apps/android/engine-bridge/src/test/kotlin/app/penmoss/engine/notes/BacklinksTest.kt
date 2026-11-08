package app.penmoss.engine.notes

import app.penmoss.engine.api.BacklinksReply
import app.penmoss.engine.api.PenmossJson
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The Info sheet's backlinks read the server's answer as the web's Backlinks panel does
 * (`apps/web/src/notes/backlinks.ts`, T16; T40 P7, LK5, LK6).
 */
class BacklinksTest {
    private val target = "01JD3A0000000000000000LNK1"
    private val other = "01JD3A0000000000000000LNK9"

    /** What `GET /api/notes/:id/backlinks` answered in the server's links test, plus a second link in one block. */
    private val reply = PenmossJson.decodeFromString(
        BacklinksReply.serializer(),
        """
        {"title":"Garden plan","linked":[
          {"id":"src","title":"Weekly review","updatedAt":20,"heading":null,"embed":false,"count":1,
           "context":["Started the ",{"noteId":"$target","target":"Garden plan","heading":null,"alias":null}," this week."]},
          {"id":"src","title":"Weekly review","updatedAt":20,"heading":"Beds","embed":true,"count":1,"context":[]},
          {"id":"src","title":"Weekly review","updatedAt":20,"heading":"Paths","embed":false,"count":1,
           "context":["Started the ",{"noteId":"$target","target":"Garden plan","heading":null,"alias":null}," this week."]},
          {"id":"old","title":"","updatedAt":10,"heading":null,"embed":false,"count":2,
           "context":[{"noteId":"$other","target":"Shed","heading":"Tools","alias":null}," and ",7,{"target":"Lost"}]},
          {"id":"","title":"Broken","updatedAt":5,"context":[]}
        ],"unlinked":[
          {"id":"shop","title":"Shopping","updatedAt":30,"snippet":"Seeds for the \u0002garden plan\u0003.\n Soon"},
          {"id":"","title":"Broken","updatedAt":1,"snippet":""}
        ]}
        """.trimIndent(),
    )

    @Test
    fun groupsLinksByNoteAndShowsEachBlockOnce() {
        val lists = Backlinks.lists(reply)
        assertEquals(listOf("src", "old"), lists.linked.map { it.id })
        val review = lists.linked.first()
        // Two links in one paragraph share its text, which shows once; the embed keeps its own.
        assertEquals(2, review.mentions.size)
        assertEquals(listOf(false, true), review.mentions.map { it.embed })
        assertEquals("Beds", review.mentions[1].heading)
        assertEquals(
            listOf(
                ContextPart.Text("Started the "),
                ContextPart.Link(LinkRef(target, "Garden plan", null, null)),
                ContextPart.Text(" this week."),
            ),
            review.mentions[0].context,
        )
    }

    @Test
    fun dropsMalformedPartsAndRows() {
        val old = Backlinks.lists(reply).linked[1]
        assertEquals(
            listOf(
                ContextPart.Link(LinkRef(other, "Shed", "Tools", null)),
                ContextPart.Text(" and "),
                ContextPart.Link(LinkRef(null, "Lost", null, null)),
            ),
            old.mentions.single().context,
        )
        assertEquals(listOf("shop"), Backlinks.lists(reply).unlinked.map { it.id })
    }

    @Test
    fun marksTheMatchedWordsOfAMention() {
        assertEquals(
            listOf(SnippetPart("Seeds for the ", false), SnippetPart("garden plan", true), SnippetPart(". Soon", false)),
            Backlinks.lists(reply).unlinked.single().snippet,
        )
        // An unclosed mark runs to the end; text with no mark is one part.
        assertEquals(listOf(SnippetPart("a ", false), SnippetPart("b c", true)), Backlinks.snippetParts("a \u0002b c"))
        assertEquals(listOf(SnippetPart("plain", false)), Backlinks.snippetParts("plain"))
        assertEquals(emptyList<SnippetPart>(), Backlinks.snippetParts(""))
    }

    @Test
    fun labelsLinksAsTheWebDoes() {
        val ref = LinkRef(target, "Garden plan", null, null)
        assertEquals("Garden", Backlinks.linkLabel(ref, "Garden"))
        assertEquals("Garden plan", Backlinks.linkLabel(ref, null))
        assertEquals("Garden › Beds", Backlinks.linkLabel(ref.copy(heading = "Beds"), "Garden"))
        assertEquals("the plan", Backlinks.linkLabel(ref.copy(heading = "Beds", alias = "the plan"), "Garden"))
        assertEquals(
            "Started the Garden this week.",
            Backlinks.contextText(Backlinks.lists(reply).linked.first().mentions[0].context) { "Garden" },
        )
    }
}
