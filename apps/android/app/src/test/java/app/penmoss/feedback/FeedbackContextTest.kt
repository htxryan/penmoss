package app.penmoss.feedback

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.FolderEntity
import app.penmoss.data.HistoryCacheEntity
import app.penmoss.data.NoteEntity
import app.penmoss.data.NoteLinkEntity
import app.penmoss.data.NoteStore
import app.penmoss.data.PenmossDatabase
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.file.Files

/**
 * The captured context is metadata only (T49, A791): a note whose text holds a marker, an error
 * quoting it and a version summary naming it never let the marker into the context, the
 * markdown the form previews, or the request the phone sends.
 */
@RunWith(AndroidJUnit4::class)
class FeedbackContextTest {
    private lateinit var db: PenmossDatabase
    private lateinit var tmp: File

    private val app = AppFacts("0.31 (build 431425)", "Android 16 (API 36)", "142.0", "412×915 dp at 2.625×", "Moss (dark)", "system", "en-US", "America/Chicago")
    private val where = WhereFacts("/note/n1", "note", null, "the note's ⋮ menu", "Projects")
    private val sync = SyncFacts(true, "synced", "none (Android polls, A286)", 1_793_113_445_000, 1, 0, 1, "none")

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        tmp = Files.createTempDirectory("feedback").toFile()
    }

    @After
    fun close() {
        db.close()
        tmp.deleteRecursively()
    }

    @Test
    fun theNotesTextNeverReachesTheContextThePreviewOrTheRequest() = runTest {
        val body = "Buy eggs and milk. The secret code is MARKER-7f3a9c, which nobody should ever see in an issue."
        db.folders().put(FolderEntity("f1", "Projects", null, "a0", "manual"))
        db.notes().insert(NoteEntity("n1", title = "Shopping list", excerpt = "MARKER-7f3a9c in the excerpt", updatedAt = 1_793_113_200_000, folderId = "f1", epoch = "e2"))
        NoteStore(db).savePageText("n1", body, tags = listOf("home"))
        db.noteLinks().insertAll(listOf(NoteLinkEntity("other", "n1"), NoteLinkEntity("n1", "other")))
        db.historyCache().put(
            HistoryCacheEntity(
                "n1",
                """{"versions":[
                  {"id":3,"createdAt":1793113200000,"reason":"auto","summary":"MARKER-7f3a9c heading · +3 −1 lines","authors":[{"id":"d1","kind":"device","label":"Pixel 9"}]},
                  {"id":2,"createdAt":1793109600000,"reason":"edit","summary":"Rewrote MARKER-7f3a9c","authors":[{"id":"a1","kind":"agent","label":"Claude Code ✦"}]},
                  {"id":1,"createdAt":1793106000000,"reason":"manual","summary":"Tags changed","authors":[]},
                  {"id":5,"createdAt":1793098800000,"reason":"","summary":"MARKER-7f3a9c · +1 −0 line","authors":[{"id":"d2","kind":"device"}]},
                  {"id":4,"createdAt":1793102400000,"reason":"import","summary":"Imported MARKER-7f3a9c · Title changed","authors":[]}
                ],
                "unversioned":{"since":1793116800000,"authors":[{"id":"d1","kind":"device","label":"Pixel 9"},{"id":"a1","kind":"agent","label":"Claude Code ✦"}]}}""",
            ),
        )
        val errors = RecentErrors()
        // Quoting the note's text, in quotes or not, and naming it: all dropped or scrubbed.
        errors.report("Could not parse \"secret code is MARKER-7f3a9c\"")
        errors.report(IllegalStateException("Buy eggs and milk. The secret code is MARKER-7f3a9c went wrong"))
        errors.report(java.io.IOException("timeout reading Shopping list from pms_abcdefghijkl at ryan@example.com"))
        val collector = FeedbackCollector(db, errors, names = { listOf("Shopping list", "Projects") }, app = { app }, sync = { sync })

        val context = collector.collect(where, "n1", NoteExtras(created = "2026-10-01T09:00:00-05:00", words = 17))
        val json = Json.encodeToString(FeedbackContextData.serializer(), context)
        val markdown = FeedbackMarkdown.context(context)
        val draft = FeedbackDraft("01JBXYZ0000000000000000001", type = "bug", priority = 2, title = "Sync broke", description = "It **broke**")
        val payload = FeedbackPayload.of(draft, app.version, context)
        val request = issueBody(payload, listOf("screenshot-1.png" to "https://example.invalid/screenshot-1.png"))

        for ((what, text) in listOf("context" to json, "markdown" to markdown, "payload" to payload, "request" to request)) {
            assertFalse("the marker is in the $what", text.contains("MARKER-7f3a9c", ignoreCase = true))
            assertFalse("the note's text is in the $what", text.contains("Buy eggs"))
            assertFalse("a token is in the $what", text.contains("pms_abcdefghijkl"))
            assertFalse("an email is in the $what", text.contains("ryan@example.com"))
        }

        // What it does hold: the note's metadata, its last edits' sizes, and the one error left.
        val groups = context.groups.associateBy { it.id }
        assertEquals(listOf("app", "where", "sync", "note", "edits", "errors"), context.groups.map { it.id })
        val note = groups.getValue("note").rows.associate { it[0] to it[1] }
        assertEquals("n1", note["Id"])
        assertEquals("Shopping list", note["Title"])
        assertEquals("Projects", note["Folder"])
        // Right after Folder (T43): the default notebook's name, as no notebook holds it.
        assertEquals("Personal", note["Notebook"])
        assertEquals("Notebook", groups.getValue("note").rows.map { it[0] }.let { it[it.indexOf("Folder") + 1] })
        // With no notebook selected, Where has no Notebook row.
        assertFalse(groups.getValue("where").rows.any { it[0] == "Notebook" })
        assertEquals("#home", note["Tags"])
        assertEquals("17", note["Words"])
        assertEquals("${body.length}", note["Characters"])
        assertEquals("yjs14", note["Engine"])
        assertEquals("e2", note["Epoch"])
        assertEquals("1", note["Backlinks"])
        assertEquals("1", note["Outgoing links"])
        assertEquals("2026-10-27T15:00:00.000Z", note["Updated"])
        assertEquals("1", note["Open in windows"])
        assertEquals(
            listOf(
                listOf("2026-10-27T16:00:00.000Z", "Pixel 9, Claude Code ✦ (agent)", "edits since the last version", ""),
                listOf("2026-10-27T15:00:00.000Z", "Pixel 9", "typed", "+3 −1 lines"),
                listOf("2026-10-27T14:00:00.000Z", "Claude Code ✦ (agent)", "agent edit", ""),
                listOf("2026-10-27T13:00:00.000Z", "", "saved by hand", "Tags changed"),
                listOf("2026-10-27T12:00:00.000Z", "", "import", "Title changed"),
                listOf("2026-10-27T11:00:00.000Z", "Unknown", "version", "+1 −0 line"),
            ),
            groups.getValue("edits").rows,
        )
        val errorRows = groups.getValue("errors").rows
        assertEquals(1, errorRows.size)
        assertEquals("IOException: timeout reading ‹name› from [token removed] at [email removed]", errorRows.single()[1])
        assertTrue(markdown.startsWith("<details><summary>Captured context</summary>"))
    }

    /**
     * From a git notebook (A826, A828, A889; PR #167 review): nothing of the notebook reaches
     * Penmoss's server. The note's title, folder path, notebook, tags, id, dates and authors are
     * in none of the context, the preview's markdown, the payload or the request; counts are.
     */
    @Test
    fun fromAGitNotebookTheContextHoldsKindsAndCountsAndNothingOfTheNotebook() = runTest {
        val id = "01JBN00000000000000000GIT1"
        db.folders().put(FolderEntity("w", "Acme Work", null, "a0", "manual", notebook = true))
        db.folders().put(FolderEntity("c", "Clients Zeta", "w", "a0", "manual"))
        db.notes().insert(NoteEntity(id, title = "Secret merger plan", folderId = "c", updatedAt = 1_793_113_200_000, epoch = "epoch-of-the-secret-store"))
        NoteStore(db).savePageText(id, "Quarterly numbers", tags = listOf("confidential-tag"))
        db.historyCache().put(HistoryCacheEntity(id, """{"versions":[{"id":1,"createdAt":1793113200000,"reason":"auto","summary":"+1 −0 line","authors":[{"id":"d1","kind":"device","label":"Ryan's Pixel"}]}]}"""))
        val errors = RecentErrors()
        errors.report(java.io.IOException("could not read Secret merger plan"))
        val collector = FeedbackCollector(
            db, errors, names = { listOf("Secret merger plan", "Acme Work", "Clients Zeta") }, app = { app },
            sync = { sync.copy(lastError = "Can't sign in to github.com/htxryan/acme-notes") }, gitNotebook = true,
        )
        val gitWhere = WhereFacts("/note/$id", "note", null, "the note's ⋮ menu", "Acme Work / Clients Zeta", notebook = "Acme Work")
        val context = collector.collect(gitWhere, id, NoteExtras(created = "2026-10-01T09:00:00-05:00", words = 2, tags = listOf("confidential-tag")))
        val json = Json.encodeToString(FeedbackContextData.serializer(), context)
        val markdown = FeedbackMarkdown.context(context)
        val payload = FeedbackPayload.of(FeedbackDraft("01JBXYZ0000000000000000002", type = "bug", priority = 3, title = "Odd", description = "Odd"), app.version, context)
        val request = issueBody(payload, emptyList())
        for ((what, text) in listOf("context" to json, "markdown" to markdown, "payload" to payload, "request" to request)) {
            for (secret in listOf("Secret merger plan", "Acme", "Clients Zeta", "confidential-tag", id, "epoch-of-the-secret-store", "Ryan's Pixel", "acme-notes", "2026-10-01", "Quarterly")) {
                assertFalse("$secret is in the $what", text.contains(secret, ignoreCase = true))
            }
        }
        val groups = context.groups.associateBy { it.id }
        assertEquals(listOf("app", "where", "sync", "note", "errors"), context.groups.map { it.id })
        val where = groups.getValue("where").rows.associate { it[0] to it[1] }
        assertEquals("note", where["Screen"])
        assertEquals("a git notebook", where["Source"])
        // The preview says so.
        assertEquals(FeedbackContextBuilder.GIT_NOTICE, where["Git notebook"])
        assertTrue(markdown.contains(FeedbackContextBuilder.GIT_NOTICE))
        val note = groups.getValue("note").rows.associate { it[0] to it[1] }
        assertEquals(setOf("Source", "Words", "Characters", "Attachments", "Size in bytes", "Unsynced", "In Trash", "Backlinks", "Outgoing links"), note.keys)
        assertEquals("2", note["Words"])
        assertEquals("yes (not sent from a git notebook)", groups.getValue("sync").rows.associate { it[0] to it[1] }["Last sync error"])
    }

    /** A note in a notebook names it (T43), in the note's facts and, when selected, in Where. */
    @Test
    fun aNoteInANotebookNamesItInTheNoteAndWhere() = runTest {
        db.folders().put(FolderEntity("w", "Work", null, "a0", "manual", notebook = true))
        db.folders().put(FolderEntity("c", "Clients", "w", "a0", "manual"))
        db.notes().insert(NoteEntity("n2", title = "Acme", folderId = "c"))
        val collector = FeedbackCollector(db, RecentErrors(), names = { emptyList() }, app = { app }, sync = { sync })
        assertEquals("Work", collector.notebookName("c"))
        assertEquals(null, collector.notebookName(null))
        val context = collector.collect(where.copy(folderPath = "Work / Clients", notebook = collector.notebookName("c")), "n2")
        val note = context.groups.first { it.id == "note" }.rows.associate { it[0] to it[1] }
        assertEquals("Work / Clients", note["Folder"])
        assertEquals("Work", note["Notebook"])
        val whereRows = context.groups.first { it.id == "where" }.rows.map { it[0] }
        assertEquals("Notebook", whereRows[whereRows.indexOf("Selected folder") + 1])
    }

    @Test
    fun withNoNoteOpenTheNotesGroupsAreLeftOut() = runTest {
        val collector = FeedbackCollector(db, RecentErrors(), names = { emptyList() }, app = { app }, sync = { sync })
        val context = collector.collect(where.copy(route = "/home", screen = "home"), null)
        assertEquals(listOf("app", "where", "sync", "errors"), context.groups.map { it.id })
        val rows = context.groups.first { it.id == "sync" }.rows.associate { it[0] to it[1] }
        assertEquals("2026-10-27T15:04:05.000Z", rows["Last synced"])
        assertEquals("yes", rows["Online"])
    }

    @Test
    fun anErrorQuotingTheNoteIsDroppedWhateverItsQuotes() {
        val note = "The quarterly plan says we ship the widget in November, then rest."
        assertTrue(FeedbackRedaction.quotesNoteText("Failed on “ship the widget”", note))
        assertTrue(FeedbackRedaction.quotesNoteText("x: THE QUARTERLY   PLAN SAYS WE SHIP the", note))
        assertFalse(FeedbackRedaction.quotesNoteText("IOException: timeout after 30 s", note))
        assertFalse(FeedbackRedaction.quotesNoteText("short 'plan'", note))
        assertFalse(FeedbackRedaction.quotesNoteText("anything", ""))
    }

    @Test
    fun everyUrlAndRootPathLosesItsQueryAndFragment() {
        val cases = mapOf(
            "open /notes/x?q=secret failed" to "open /notes/x failed",
            "penmoss://note/abc?heading=Secret" to "penmoss://note/abc",
            "content://media/external/images/1?token=x#frag" to "content://media/external/images/1",
            "HTTPS://E.com/a#frag" to "HTTPS://E.com/a",
            "(see /notes/x?q=1)" to "(see /notes/x)",
            "at file:///data/x.db?mode=ro," to "at file:///data/x.db",
            // Not a URL or a path from the root: left as it is.
            "a/b?c and what? yes" to "a/b?c and what? yes",
            "ok./x?y" to "ok./x?y",
        )
        for ((text, expected) in cases) assertEquals(text, expected, FeedbackRedaction.secrets(text))
        // And so in the errors a report captures.
        val entry = RecentErrors.Entry(1_793_113_200_000, "IOException", "GET penmoss://notes/x?q=groceries#top", "")
        val row = FeedbackContextBuilder.errors(listOf(entry), "", listOf("Shopping list")).single()
        assertFalse(row.joinToString().contains("groceries"))
    }

    @Test
    fun routesKeepTheirIdsAndNeverAQuery() {
        val args = mapOf("id" to "01JBXYZ0000000000000000000", "heading" to "Secret heading", "note" to "01JBXYZ0000000000000000009", "actions" to "true")
        assertEquals("/note/01JBXYZ0000000000000000000", FeedbackWhere.route("note/{id}?new={new}&folder={folder}&focusTitle={focusTitle}&heading={heading}", args::get))
        assertEquals("/graph/01JBXYZ0000000000000000009", FeedbackWhere.route("graph?note={note}", args::get))
        assertEquals("/search", FeedbackWhere.route("search?actions={actions}", args::get))
        assertEquals("note", FeedbackWhere.screen("note/{id}?new={new}"))
        assertEquals("settings", FeedbackWhere.screen("settings/about"))
        assertEquals("412×915 dp at 2.625×", FeedbackAppFacts.screen(412, 915, 2.625f))
        assertEquals("411×914 dp at 3×", FeedbackAppFacts.screen(411, 914, 3f))
    }

    @Test
    fun theScrubIsTheReportsAndTheLastTenErrorsAreKept() {
        val errors = RecentErrors()
        // No names known yet: the free text is withheld, as a report's was.
        assertEquals("IOException: ‹withheld›" to "", ErrorScrub.scrubbed("IOException", "reading Groceries", "", null))
        assertEquals("IOException: reading ‹name› ‹name›" to "", ErrorScrub.scrubbed("IOException", "reading Groceries \"x\"", "", listOf("Groceries")))
        repeat(12) { errors.report("error $it") }
        assertEquals((2..11).map { "error $it" }, errors.all().map { it.free })
    }

    /** The issue body the GitHub path files for [payload] (A1010), as GitHubFeedbackApi makes it. */
    private fun issueBody(payload: String, screenshots: List<Pair<String, String>>): String {
        val submission = FeedbackSubmissions.read(payload)
        return FeedbackMarkdown.issueBody(
            description = FeedbackRedaction.redactSecrets(submission.description),
            screenshots = screenshots,
            context = FeedbackRedaction.contextWithoutSecrets(submission.context),
            client = "android",
            version = submission.version,
            submissionId = submission.submissionId,
        )
    }
}
