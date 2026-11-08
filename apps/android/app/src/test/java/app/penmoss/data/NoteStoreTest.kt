package app.penmoss.data

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.api.BatchNoteReply
import app.penmoss.engine.api.ChangedNote
import app.penmoss.engine.api.ChangesPage
import app.penmoss.engine.api.SyncTree
import app.penmoss.engine.api.TreeFolder
import app.penmoss.engine.api.TreeNote
import app.penmoss.engine.bridge.Compacted
import app.penmoss.engine.bridge.DirectoryEntry
import app.penmoss.engine.bridge.PageNote
import app.penmoss.engine.sync.Exchange
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** The Room store's side of sync (T32, A280): what a reply leaves behind, in one transaction. */
@RunWith(AndroidJUnit4::class)
class NoteStoreTest {
    private lateinit var db: PenmossDatabase
    private lateinit var store: NoteStore

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        store = NoteStore(db, now = { 1_000 })
    }

    @After
    fun close() = db.close()

    private suspend fun stored(noteId: String, state: Int) = db.updates().updates(noteId, state).map { it.update }

    @Test
    fun keepsMetadataTreeAndClock() = runTest {
        store.saveChanges(
            ChangesPage(
                clock = 9,
                notes = listOf(
                    ChangedNote("a", 8, "Groceries", "eggs", 100),
                    ChangedNote("b", 9, "Old", "", 50, deleted = true),
                ),
            ),
        )
        store.saveTree(
            SyncTree(
                hash = "h",
                rootSortMode = "alpha",
                folders = listOf(TreeFolder("f", "Projects")),
                notes = listOf(TreeNote("a", "f", "a0"), TreeNote("c", null, "a1")),
            ),
        )
        assertEquals(9L, store.changesClock())
        assertEquals("h", store.treeHash())
        assertEquals("alpha", store.observeRootSortMode().first())
        // Trash is left out; a note filed before it was indexed is listed.
        val listed = store.observeList().first()
        assertEquals(listOf("a", "c"), listed.map { it.id })
        assertEquals("f", listed.first { it.id == "a" }.folderId)
        // The tree does not touch metadata, and metadata does not touch placements.
        store.saveChanges(ChangesPage(10, notes = listOf(ChangedNote("a", 10, "Groceries!", "", 200))))
        assertEquals("f", store.note("a")?.folderId)
    }

    @Test
    fun dueContentPutsUnsentEditsFirstThenStaleThenNew() = runTest {
        store.saveChanges(
            ChangesPage(
                5,
                notes = listOf(ChangedNote("held", 5, updatedAt = 1), ChangedNote("new", 5, updatedAt = 9), ChangedNote("edited", 5, updatedAt = 2)),
            ),
        )
        db.notes().updateContentState("held", "SV", "e", contentClock = 3, gone = false)
        store.addPending("edited", "EDIT", null)
        val due = store.dueContent(limit = 10, prefetch = true, skip = emptySet())
        assertEquals(listOf("edited", "held", "new"), due.map { it.noteId })
        assertEquals(listOf("EDIT"), due.first().pending.map { it.update })
        assertEquals(listOf("edited", "held"), store.dueContent(10, prefetch = false, skip = emptySet()).map { it.noteId })
        assertEquals(listOf("held"), store.dueContent(10, prefetch = false, skip = setOf("edited")).map { it.noteId })
    }

    @Test
    fun aReplyStoresItsUpdateAndCursorTogetherAndConfirmsTheEdits() = runTest {
        store.saveChanges(ChangesPage(4, notes = listOf(ChangedNote("n", 4))))
        store.addPending("n", "EDIT", null)
        val sent = store.content("n")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("n", "e", "WHOLE", "SV1", null)))
        assertEquals(listOf("WHOLE"), stored("n", UpdateEntity.SYNCED))
        assertEquals(emptyList<String>(), stored("n", UpdateEntity.PENDING))
        val note = store.note("n")!!
        assertEquals("SV1", note.cursor)
        assertEquals("e", note.epoch)
        assertEquals(4L, note.contentClock)
        assertTrue(store.holds("n"))
        // Caught up: not due again for its content.
        assertEquals(emptyList<String>(), store.dueContent(10, prefetch = false, skip = emptySet()).map { it.noteId })
        // That exchange asked for no text (a metered pass, A328): the next pass that may prefetch
        // asks for it once (T40 P6, FD4), and then it is not due at all.
        assertEquals(listOf("n"), store.dueContent(10, prefetch = true, skip = emptySet()).map { it.noteId })
        val again = store.content("n")
        store.saveExchange(Exchange.decide(again, Exchange.entry(again, withText = true), BatchNoteReply("n", "e", "", "SV1", null, text = "", textHash = textHash(""))))
        assertEquals(emptyList<String>(), store.dueContent(10, prefetch = true, skip = emptySet()).map { it.noteId })
    }

    @Test
    fun aRestoreReplacesTheCopyAndKeepsTheEditsApart() = runTest {
        store.saveExchange(Exchange.decide(store.content("n"), Exchange.entry(store.content("n")), BatchNoteReply("n", "e1", "OLD", "SV1", null)))
        store.addPending("n", "EDIT", null)
        val sent = store.content("n")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("n", "e2", "RESTORED", "SV9", "Epoch mismatch")))
        assertEquals(listOf("RESTORED"), stored("n", UpdateEntity.SYNCED))
        assertEquals(listOf("EDIT"), stored("n", UpdateEntity.CONFLICT))
        assertEquals(emptyList<String>(), stored("n", UpdateEntity.PENDING))
        assertEquals("e2", store.note("n")?.epoch)
        assertEquals(1, store.unsentCount())
    }

    @Test
    fun compactionSwapsOnlyUpdatesStillStoredAsTheyWere() = runTest {
        val a = db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "A"))
        val b = db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.SYNCED, update = "B"))
        assertTrue(store.compact("n", Compacted(listOf(a, b), "AB"), UpdateEntity.SYNCED))
        assertEquals(listOf("AB"), stored("n", UpdateEntity.SYNCED))
        // An id already replaced (an exchange got there first): nothing changes.
        val p = store.addPending("n", "P", null)
        assertFalse(store.compact("n", Compacted(listOf(a, p), "AP"), UpdateEntity.PENDING))
        assertEquals(listOf("P"), stored("n", UpdateEntity.PENDING))
    }

    @Test
    fun aPurgedNoteGoesButNeverAnUnsentEdit() = runTest {
        store.saveChanges(ChangesPage(1, notes = listOf(ChangedNote("gone", 1), ChangedNote("kept", 1), ChangedNote("apart", 1))))
        store.addPending("kept", "EDIT", null)
        // Edits kept apart by a restore (S4): the only copy until T33 makes them a conflict note.
        db.updates().insert(UpdateEntity(noteId = "apart", state = UpdateEntity.SYNCED, update = "SERVER"))
        db.updates().insert(UpdateEntity(noteId = "apart", state = UpdateEntity.CONFLICT, update = "MINE"))
        store.saveChanges(
            ChangesPage(
                2,
                notes = listOf(ChangedNote("gone", 2, purged = true), ChangedNote("kept", 2, purged = true), ChangedNote("apart", 2, purged = true)),
            ),
        )
        assertNull(store.note("gone"))
        // Kept, as an edit kept apart now: it can never upload, and becomes a conflict copy (A310).
        assertEquals(listOf("EDIT"), stored("kept", UpdateEntity.CONFLICT))
        assertEquals(listOf("MINE"), stored("apart", UpdateEntity.CONFLICT))
        assertEquals(emptyList<String>(), stored("apart", UpdateEntity.SYNCED))
        assertTrue(store.note("apart") != null)
        assertEquals(2, store.unsentCount())
    }

    @Test
    fun anOlderCatchUpFinishingLastNeverMovesTheClockOrANoteBack() = runTest {
        store.saveChanges(ChangesPage(9, notes = listOf(ChangedNote("n", 9, "New title", "", 900))))
        // The open note's poll asked earlier and is stored after the pass (nit 4).
        store.saveChanges(ChangesPage(7, notes = listOf(ChangedNote("n", 7, "Old title", "", 700))))
        assertEquals(9L, store.changesClock())
        assertEquals("New title", store.note("n")?.title)
        assertEquals(9L, store.note("n")?.clock)
    }

    @Test
    fun editsMadeOnACopyARestoreReplacedAreKeptApartWhenEverTheyArrive() = runTest {
        // Synced at e1; the editor has the e1 copy open.
        store.saveExchange(Exchange.decide(store.content("n"), Exchange.entry(store.content("n")), BatchNoteReply("n", "e1", "OLD", "SV1", null)))
        store.addPending("n", "SENT", "e1")
        val sent = store.content("n")
        // While that request is out, the editor stores another edit of the e1 copy (S3).
        store.addPending("n", "TYPED-MEANWHILE", "e1")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("n", "e2", "RESTORED", "SV9", "Epoch mismatch")))
        assertEquals(listOf("SENT", "TYPED-MEANWHILE"), stored("n", UpdateEntity.CONFLICT))
        assertEquals(emptyList<String>(), stored("n", UpdateEntity.PENDING))
        // The page's last edits of the old copy, flushed as it reopens, arrive after the reset.
        store.addPending("n", "FLUSHED-ON-REOPEN", "e1")
        // Edits of the restored copy are ordinary pending edits.
        store.addPending("n", "ON-THE-NEW-COPY", "e2")
        assertEquals(listOf("SENT", "TYPED-MEANWHILE", "FLUSHED-ON-REOPEN"), stored("n", UpdateEntity.CONFLICT))
        assertEquals(listOf("ON-THE-NEW-COPY"), stored("n", UpdateEntity.PENDING))
        // The editor reopens on the restored copy and this device's edits of it, never the old ones.
        val opened = store.editorContent("n")
        assertEquals(listOf("RESTORED"), opened.synced.map { it.update })
        assertEquals(listOf("ON-THE-NEW-COPY"), opened.pending.map { it.update })
        assertEquals("e2", opened.epoch)
        assertEquals(listOf("ON-THE-NEW-COPY"), Exchange.entry(store.content("n")).update)
    }

    @Test
    fun compactsPendingEditsOfOneCopyOnly() = runTest {
        store.saveExchange(Exchange.decide(store.content("n"), Exchange.entry(store.content("n")), BatchNoteReply("n", "e1", "OLD", "SV1", null)))
        val a = store.addPending("n", "A", "e1")
        val b = store.addPending("n", "B", "e1")
        assertTrue(store.compact("n", Compacted(listOf(a, b), "AB"), UpdateEntity.PENDING))
        assertEquals(listOf("e1"), db.updates().updates("n", UpdateEntity.PENDING).map { it.epoch })
        val c = store.addPending("n", "C", null)
        val ab = db.updates().ids("n", UpdateEntity.PENDING).first()
        assertFalse(store.compact("n", Compacted(listOf(ab, c), "ABC"), UpdateEntity.PENDING))
    }

    // --- T33 ---

    private suspend fun syncedAt(noteId: String, epoch: String, update: String) =
        store.saveExchange(Exchange.decide(store.content(noteId), Exchange.entry(store.content(noteId)), BatchNoteReply(noteId, epoch, update, "SV", null)))

    @Test
    fun aRestoreKeepsTheReplacedCopyAsTheBaseOfTheEditsMadeOnIt() = runTest {
        syncedAt("n", "e1", "OLD")
        // An edit stored before the editor knew the copy's epoch is still known to be made on e1.
        store.addPending("n", "EDIT", null)
        val sent = store.content("n")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("n", "e2", "RESTORED", "SV9", "Epoch mismatch")))
        assertEquals(listOf("OLD"), stored("n", UpdateEntity.BASE))
        assertEquals(listOf("e1"), db.updates().updates("n", UpdateEntity.BASE).map { it.epoch })
        assertEquals(listOf("e1"), db.updates().updates("n", UpdateEntity.CONFLICT).map { it.epoch })
        // Base rows are what the server had: never counted as unsent.
        assertEquals(1, store.unsentCount())
        val set = store.conflictSet("n")!!
        assertEquals(listOf("OLD"), set.base.map { it.update })
        assertEquals(listOf("EDIT"), set.edits.map { it.update })
        assertEquals(listOf("n"), store.notesWithConflicts())
        assertEquals(1, store.observeConflictCount().first())
    }

    @Test
    fun editsTheServerRefusedForGoodAreCopiedOnTheCopyItHas() = runTest {
        syncedAt("n", "e1", "SERVER")
        db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.CONFLICT, update = "REFUSED", epoch = "e1"))
        val set = store.conflictSet("n")!!
        assertEquals(listOf("SERVER"), set.base.map { it.update })
        assertEquals(listOf("REFUSED"), set.edits.map { it.update })
        assertNull(store.conflictSet("other"))
    }

    @Test
    fun conflictsAreCopiedOneReplacedCopyAtATime() = runTest {
        syncedAt("n", "e1", "ONE")
        store.addPending("n", "ON-ONE", "e1")
        var sent = store.content("n")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("n", "e2", "TWO", "SV2", "Epoch mismatch")))
        store.addPending("n", "ON-TWO", "e2")
        sent = store.content("n")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("n", "e3", "THREE", "SV3", "Epoch mismatch")))
        val first = store.conflictSet("n")!!
        assertEquals(listOf("ONE"), first.base.map { it.update })
        assertEquals(listOf("ON-ONE"), first.edits.map { it.update })
        assertTrue(store.saveConflictCopy("n", PageNote("copy1", "Note (conflict)", "COPY1"), first.edits.map { it.id }))
        val second = store.conflictSet("n")!!
        assertEquals(listOf("TWO"), second.base.map { it.update })
        assertEquals(listOf("ON-TWO"), second.edits.map { it.update })
    }

    @Test
    fun aConflictCopyIsStoredWithTheEditsItHoldsInOneGo() = runTest {
        syncedAt("n", "e1", "OLD")
        store.addPending("n", "EDIT", "e1")
        val sent = store.content("n")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("n", "e2", "RESTORED", "SV9", "Epoch mismatch")))
        val set = store.conflictSet("n")!!
        val ids = set.edits.map { it.id }
        // Rows of another note, or ones that are not edits kept apart, refuse the copy.
        val other = store.addPending("x", "X", null)
        assertFalse(store.saveConflictCopy("n", PageNote("c", "T", "U"), ids + other))
        assertFalse(store.saveConflictCopy("n", PageNote("c", "T", "U"), set.base.map { it.id }))
        assertFalse(store.saveConflictCopy("n", PageNote("c", "T", "U"), emptyList()))
        assertNull(store.note("c"))

        assertTrue(store.saveConflictCopy("n", PageNote("c", "Note (conflict)", "COPY"), ids))
        assertEquals(emptyList<String>(), stored("n", UpdateEntity.CONFLICT))
        // Marked, never deleted (A309): a later edit of e1 may build on them.
        assertEquals(listOf("EDIT"), stored("n", UpdateEntity.COPIED))
        assertEquals(listOf("c"), db.updates().updates("n", UpdateEntity.COPIED).map { it.copiedTo })
        assertEquals(listOf("OLD"), stored("n", UpdateEntity.BASE))
        assertEquals(listOf("RESTORED"), stored("n", UpdateEntity.SYNCED))
        assertEquals(listOf("COPY"), stored("c", UpdateEntity.PENDING))
        val copy = store.note("c")!!
        assertEquals("Note (conflict)", copy.title)
        assertTrue(copy.toFile)
        assertNull(copy.fileIn)
        assertEquals(1_000L, copy.updatedAt)
        // The same copy twice: refused.
        assertFalse(store.saveConflictCopy("n", PageNote("c", "Again", "COPY"), ids))
    }

    /**
     * A conflict copy is filed beside its original (T43, A757: fail closed): in the original's
     * folder, a notebook's included, never the top level by default, which is the default notebook.
     */
    @Test
    fun aConflictCopyIsFiledBesideItsOriginalNeverAtTheTopLevel() = runTest {
        store.saveTree(
            SyncTree("h1", folders = listOf(TreeFolder("w", "Work", position = "a0", notebook = true), TreeFolder("plans", "Plans", "w")), notes = listOf(TreeNote("n", "plans", "a0"))),
        )
        syncedAt("n", "e1", "OLD")
        store.addPending("n", "EDIT", "e1")
        val sent = store.content("n")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("n", "e2", "RESTORED", "SV9", "Epoch mismatch")))
        val set = store.conflictSet("n")!!
        assertTrue(store.saveConflictCopy("n", PageNote("c", "Note (conflict)", "COPY"), set.edits.map { it.id }))
        val copy = store.note("c")!!
        assertTrue(copy.toFile)
        assertEquals("plans", copy.fileIn)
        // Its move names the notebook its folder is in (T43, fix c).
        assertEquals("w", copy.moveNotebook)
        // Listed there at once, offline too.
        assertEquals("plans", store.folderOf("c"))

        // A note moved here and not filed yet: the copy goes where the move takes it.
        store.moveNote("n", "w")
        store.addPending("n", "LATER", "e2")
        val again = store.content("n")
        store.saveExchange(Exchange.decide(again, Exchange.entry(again), BatchNoteReply("n", "e3", "NEWER", "SV10", "Epoch mismatch")))
        val second = store.conflictSet("n")!!
        assertTrue(store.saveConflictCopy("n", PageNote("c2", "Note (conflict 2)", "COPY2"), second.edits.map { it.id }))
        assertEquals("w", store.note("c2")!!.fileIn)
    }

    @Test
    fun aDeletedNotesLastEditsBecomeACopyAndTheNoteStaysGone() = runTest {
        syncedAt("n", "e1", "OLD")
        store.addPending("n", "EDIT", "e1")
        val sent = store.content("n")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("n", error = "Gone")))
        assertTrue(store.note("n")!!.gone)
        assertEquals(listOf("OLD"), stored("n", UpdateEntity.BASE))
        val set = store.conflictSet("n")!!
        assertTrue(store.saveConflictCopy("n", PageNote("c", "Copy", "COPY"), set.edits.map { it.id }))
        // A tombstone (A310): listed nowhere, and a late edit of it joins its copy instead of reviving it.
        assertTrue(store.note("n")!!.gone)
        assertFalse(store.observeList().first().any { it.id == "n" })
        store.addPending("n", "LATE", "e1")
        assertEquals(listOf("LATE"), stored("n", UpdateEntity.CONFLICT))
        assertEquals(2, store.unsentCount())
    }

    @Test
    fun aPurgeKeepsWhatTheServerHadForTheEditsLeft() = runTest {
        syncedAt("apart", "e1", "SERVER")
        db.updates().insert(UpdateEntity(noteId = "apart", state = UpdateEntity.CONFLICT, update = "MINE", epoch = "e1"))
        store.saveChanges(ChangesPage(2, notes = listOf(ChangedNote("apart", 2, purged = true))))
        assertEquals(listOf("SERVER"), stored("apart", UpdateEntity.BASE))
        assertEquals(listOf("SERVER"), store.conflictSet("apart")!!.base.map { it.update })
        // Deleted for good elsewhere: it leaves every list (S5).
        assertTrue(store.note("apart")!!.gone)
        assertFalse(store.observeList().first().any { it.id == "apart" })
    }

    @Test
    fun basesNoEditNeedsAreDropped() = runTest {
        syncedAt("n", "e1", "OLD")
        val sent = store.content("n")
        // A restore with no edits of the old copy: its base is kept for an editor's last flush only.
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("n", "e2", "RESTORED", "SV9", "Epoch mismatch")))
        assertEquals(listOf("OLD"), stored("n", UpdateEntity.BASE))
        syncedAt("m", "f1", "M-OLD")
        store.addPending("m", "M-EDIT", "f1")
        val m = store.content("m")
        store.saveExchange(Exchange.decide(m, Exchange.entry(m), BatchNoteReply("m", "f2", "M-NEW", "SV9", "Epoch mismatch")))
        assertEquals(1, store.dropUnneededBases())
        assertEquals(emptyList<String>(), stored("n", UpdateEntity.BASE))
        assertEquals(listOf("M-OLD"), stored("m", UpdateEntity.BASE))
    }

    @Test
    fun aNoteTheEditorMadeIsStoredToUploadThenFile() = runTest {
        assertTrue(store.addLocalNote(PageNote("new", "Plans", "WHOLE"), fileIn = "f"))
        assertFalse(store.addLocalNote(PageNote("new", "Again", "X"), fileIn = null))
        assertEquals(listOf("WHOLE"), stored("new", UpdateEntity.PENDING))
        assertEquals("Plans", store.note("new")?.title)
        // Not filed until the server has its content.
        assertEquals(emptyList<String>(), store.readyToFile().map { it.id })
        val sent = store.content("new")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("new", "e", "", "SV", null)))
        assertEquals(listOf("f"), store.readyToFile().map { it.fileIn })
        store.markFiled("new", "f")
        assertEquals(emptyList<String>(), store.readyToFile().map { it.id })
    }

    @Test
    fun theDirectoryListsLiveNotesWithTheirFolderNames() = runTest {
        store.saveChanges(
            ChangesPage(
                1,
                notes = listOf(
                    ChangedNote("a", 1, "Alpha", "", 1),
                    ChangedNote("b", 1, "Beta", "", 2),
                    ChangedNote("t", 1, "Trashed", "", 3, deleted = true),
                ),
            ),
        )
        store.saveTree(SyncTree(hash = "h", rootSortMode = "manual", folders = listOf(TreeFolder("f", "Projects")), notes = listOf(TreeNote("a", "f", "a0"))))
        assertEquals(
            listOf(DirectoryEntry("b", "Beta", null), DirectoryEntry("a", "Alpha", "Projects")),
            store.observeDirectory().first(),
        )
    }

    @Test
    fun keepsTheAppearanceTheTreeCameWith() = runTest {
        assertNull(store.observeAppearance().first())
        val appearance = buildJsonObject { put("mode", JsonPrimitive("dark")) }
        store.saveTree(SyncTree(hash = "h", rootSortMode = "manual", appearance = appearance))
        assertEquals("""{"mode":"dark"}""", store.observeAppearance().first())
        // A tree from an older server leaves it as it was.
        store.saveTree(SyncTree(hash = "h2", rootSortMode = "manual"))
        assertEquals("""{"mode":"dark"}""", store.observeAppearance().first())
    }

    // --- review B1 and S5: conflict copies keep every edit (A309, A310) ---

    /** Synced at e1, edited, then the server restored it (e2): the edits kept apart, and their base. */
    private suspend fun restoredAfter(vararg edits: String) {
        syncedAt("n", "e1", "OLD")
        edits.forEach { store.addPending("n", it, "e1") }
        val sent = store.content("n")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("n", "e2", "RESTORED", "SV9", "Epoch mismatch")))
    }

    @Test
    fun aLateEditOfACopiedCopyBuildsOnEverythingAndMergesIntoTheCopy() = runTest {
        // Trigger (a): the page's last seconds of typing arrive after the copy was made.
        restoredAfter("EDIT")
        val first = store.conflictSet("n")!!
        assertTrue(store.saveConflictCopy("n", PageNote("c", "Note (conflict copy)", "COPY"), first.edits.map { it.id }))
        store.addPending("n", "FLUSHED-LATE", "e1")
        val late = store.conflictSet("n")!!
        assertEquals("e1", late.epoch)
        // Never an empty base: what the server had of e1 and the edit already copied.
        assertEquals(listOf("OLD", "EDIT"), late.base.map { it.update })
        assertEquals(listOf("FLUSHED-LATE"), late.edits.map { it.update })
        assertEquals("c", late.into?.noteId)
        assertEquals(listOf("COPY"), late.into?.updates?.map { it.update })
        assertTrue(store.saveConflictCopy("n", PageNote("c", "Note (conflict copy)", "MERGED"), late.edits.map { it.id }, merged = true))
        assertEquals(listOf("COPY", "MERGED"), stored("c", UpdateEntity.PENDING))
        assertEquals(listOf("EDIT", "FLUSHED-LATE"), stored("n", UpdateEntity.COPIED))
        // A merge into a copy the phone does not have is refused.
        store.addPending("n", "LATER", "e1")
        val later = store.conflictSet("n")!!
        assertFalse(store.saveConflictCopy("n", PageNote("missing", "T", "U"), later.edits.map { it.id }, merged = true))
    }

    @Test
    fun editsTheServerRefusesOneAfterAnotherAreCopiedWithTheEarlierOnes() = runTest {
        // Trigger (b): refused for good on the current copy, one per exchange.
        syncedAt("n", "e1", "SERVER")
        db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.CONFLICT, update = "REFUSED-1", epoch = "e1"))
        val first = store.conflictSet("n")!!
        assertTrue(store.saveConflictCopy("n", PageNote("c1", "T", "C1"), first.edits.map { it.id }))
        db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.CONFLICT, update = "REFUSED-2", epoch = "e1"))
        val second = store.conflictSet("n")!!
        assertEquals(listOf("SERVER", "REFUSED-1"), second.base.map { it.update })
        assertEquals(listOf("REFUSED-2"), second.edits.map { it.update })
    }

    @Test
    fun aPurgeWithPendingEditsKeepsTheirBaseThroughThePassThatFollows() = runTest {
        // Trigger (c): purged while edits were still pending.
        syncedAt("n", "e1", "SERVER")
        store.addPending("n", "PENDING", "e1")
        store.saveChanges(ChangesPage(2, notes = listOf(ChangedNote("n", 2, purged = true))))
        assertEquals(0, store.dropUnneededBases())
        assertEquals(listOf("SERVER"), stored("n", UpdateEntity.BASE))
        // Kept apart at once: they can never upload. And the note leaves the lists (S5).
        assertEquals(listOf("PENDING"), stored("n", UpdateEntity.CONFLICT))
        assertTrue(store.note("n")!!.gone)
        // Still due if anything else sent them: the server's Gone keeps the base too.
        val sent = store.content("n")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("n", error = "Gone")))
        assertEquals(listOf("SERVER"), store.conflictSet("n")!!.base.map { it.update })
    }

    @Test
    fun aBaseStaysWhileAnEditOfItsCopyIsPendingOrAnEditorHoldsIt() = runTest {
        syncedAt("n", "e1", "OLD")
        val sent = store.content("n")
        store.saveExchange(Exchange.decide(sent, Exchange.entry(sent), BatchNoteReply("n", "e2", "RESTORED", "SV9", "Epoch mismatch")))
        // An open editor may still flush its last edits of e1.
        assertEquals(0, store.dropUnneededBases { noteId, epoch -> noteId == "n" && epoch == "e1" })
        assertEquals(listOf("OLD"), stored("n", UpdateEntity.BASE))
        // A pending edit of e1 (stored as the reply landed) keeps it too.
        val pending = db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.PENDING, update = "P", epoch = "e1"))
        assertEquals(0, store.dropUnneededBases())
        db.updates().delete(listOf(pending))
        assertEquals(1, store.dropUnneededBases())
    }

    @Test
    fun copiedEditsGoOnlyOnceNothingOfTheirCopyCanCome() = runTest {
        restoredAfter("EDIT")
        val set = store.conflictSet("n")!!
        store.saveConflictCopy("n", PageNote("c", "T", "COPY"), set.edits.map { it.id })
        assertEquals(0, store.dropUnneededBases { _, epoch -> epoch == "e1" })
        assertEquals(listOf("EDIT"), stored("n", UpdateEntity.COPIED))
        assertEquals(2, store.dropUnneededBases())
        assertEquals(emptyList<String>(), stored("n", UpdateEntity.COPIED))
        assertEquals(emptyList<String>(), stored("n", UpdateEntity.BASE))
        // The copy is not touched.
        assertEquals(listOf("COPY"), stored("c", UpdateEntity.PENDING))
    }

    @Test
    fun editsKeptByAT32BuildWithNoBaseAreNeverCopiedOntoNothing() = runTest {
        // Trigger (d): conflict rows from schema 2, made on e1, with no base rows; the note is at e2.
        syncedAt("n", "e2", "RESTORED")
        db.updates().insert(UpdateEntity(noteId = "n", state = UpdateEntity.CONFLICT, update = "T32-EDIT", epoch = "e1"))
        val set = store.conflictSet("n")!!
        assertEquals(emptyList<String>(), set.base.map { it.update })
        assertNull(set.into)
        // The page refuses such a copy; the edits are kept, counted, and not asked about again.
        assertTrue(store.saveNoCopy("n", set.edits.map { it.id }, NoteStore.NoCopy.INCOMPLETE))
        assertEquals(listOf("T32-EDIT"), stored("n", UpdateEntity.KEPT))
        assertEquals(1, store.observeKeptCount().first())
        assertEquals(1, store.unsentCount())
        assertEquals(emptyList<String>(), store.notesWithConflicts())
        assertNull(store.conflictSet("n"))
        // Never dropped.
        store.dropUnneededBases()
        assertEquals(listOf("T32-EDIT"), stored("n", UpdateEntity.KEPT))
    }

    @Test
    fun editsThatLeaveNothingToKeepAreMarkedCopiedWithNoCopy() = runTest {
        restoredAfter("TYPED-AND-DELETED")
        val set = store.conflictSet("n")!!
        assertTrue(store.saveNoCopy("n", set.edits.map { it.id }, NoteStore.NoCopy.EMPTY))
        assertEquals(listOf<String?>(null), db.updates().updates("n", UpdateEntity.COPIED).map { it.copiedTo })
        assertEquals(0, store.unsentCount())
        assertEquals(0, store.observeKeptCount().first())
        // Rows no longer kept apart refuse a second answer.
        assertFalse(store.saveNoCopy("n", set.edits.map { it.id }, NoteStore.NoCopy.INCOMPLETE))
    }
}
