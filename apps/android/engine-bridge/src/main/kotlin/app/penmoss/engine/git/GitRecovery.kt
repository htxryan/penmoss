package app.penmoss.engine.git

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

/** A note's copy as the phone's store (Room) holds it from before the page's current epoch (A886). */
data class OldCopy(
    val noteId: String,
    val title: String,
    val folderId: String?,
    /** Room's updates of it, the strings Room keeps; only the page reads them (A11). */
    val updates: List<String>,
    /** Kept aside after an earlier try could not bring it back: the note itself syncs again. */
    val kept: Boolean = false,
)

/** Where the old copies are: Room in the app, the in-memory store in the tests. */
interface OldCopies {
    /** The epochs Room holds notes of, for the page to hold those of another epoch than its own. */
    suspend fun epochs(): List<String>

    /** Notes whose copy is from another epoch than [epoch], and the copies kept aside, with what they hold. */
    suspend fun before(epoch: String): List<OldCopy>

    /** Done with [copy] (brought back, or git had all of it): it is not offered again. */
    suspend fun done(copy: OldCopy)

    /** [copy] could not be brought back: kept aside, never sent, while the note syncs again. */
    suspend fun keep(copy: OldCopy)
}

/**
 * A copy withheld from the push (A886): brought back after the store was cleared, its original
 * ([origin]) deleted for good on another device before the copy first reached the branch. Kept on
 * this phone only, every edit typed on it included, until the person saves its text, deletes it for
 * good or keeps and syncs it (Settings and the notebook's Sync).
 */
data class WithheldCopy(
    val noteId: String,
    val origin: String,
    val title: String,
    val folderId: String?,
    /** Its rows, the strings Room keeps; only the page reads them (A11). */
    val updates: List<String>,
)

/** Where withheld copies are kept: Room in the app, memory in the tests. */
interface WithheldCopies {
    /** Before each copy leaves the notebook: kept aside with every row of it, never sent. */
    suspend fun withhold(copies: List<WithheldCopy>)

    /** The copies kept aside, with what they hold. */
    suspend fun withheld(): List<WithheldCopy>

    /** Deleted for good here, or kept and synced (the page has it again): gone from the phone's store. */
    suspend fun drop(noteId: String)
}

/** One pass over the old copies (A886). */
data class RecoveryPass(
    val recovered: List<RecoveredNote>,
    /** Copies the page could not bring back this time: kept, for the person to save. */
    val unrecovered: List<OldCopy>,
    /** No sync had landed since the page opened: nothing was compared, every copy waits. */
    val later: Boolean,
)

/**
 * When Android clears a git notebook's engine store (A886). A WebView's IndexedDB can be evicted
 * when storage runs low; the page then opens afresh with a new epoch, and the edits its old store
 * took in but never pushed are gone from it. Room still has them: every note's whole copy, under
 * the old epoch. The page holds Room's exchanges of those notes (so Room keeps them) and, once a
 * sync has fetched the head, each copy goes to it, and any that holds something git lacks comes
 * back as "<title> (recovered)"; one deleted for good never does.
 *
 * It runs after the open, in the background, so it never holds the notebook up; a copy that fails
 * (unreadable, too slow) is logged, kept aside in Room and named, and the rest go on.
 */
class GitRecovery(
    private val engine: GitEngine,
    private val copies: OldCopies,
    private val partChars: Int = GitEngine.PART_CHARS,
    private val callMs: Long = GitEngine.HTTP_MS,
    private val log: (String) -> Unit = {},
) {
    /** One pass: null when there was nothing to bring back. [onEach] hears of each note as it comes back. */
    suspend fun run(onEach: (RecoveredNote) -> Unit = {}): RecoveryPass? {
        val epoch = engine.epoch ?: return null
        val old = copies.before(epoch)
        if (old.isEmpty()) {
            ended()
            return null
        }
        val recovered = mutableListOf<RecoveredNote>()
        val unrecovered = mutableListOf<OldCopy>()
        for (copy in old) {
            val answer = try {
                engine.recover(copy.noteId, copy.updates, copy.folderId, partChars, callMs)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                log("An old copy of a note could not be brought back (kept): ${error.message ?: error::class.java.simpleName}")
                // Kept aside, the note syncs again (the page may be gone, and its hold with it);
                // not kept, it stays held as it is, for the next pass.
                if (runCatching { copies.keep(copy) }.isSuccess) runCatching { engine.releaseOldCopy(copy.noteId) }
                unrecovered += copy
                continue
            }
            when (answer) {
                // Nothing compared yet: every copy waits, held, for the next pass.
                RecoverAnswer.Later -> return RecoveryPass(recovered, unrecovered, later = true)
                RecoverAnswer.Done -> copies.done(copy)
                is RecoverAnswer.Recovered -> {
                    recovered += answer.note
                    onEach(answer.note)
                    copies.done(copy)
                }
            }
        }
        ended()
        return RecoveryPass(recovered, unrecovered, later = false)
    }

    /** Old copies (waiting or kept aside), as one markdown file the person can save: what of each can be read. */
    suspend fun export(kept: List<OldCopy>): String = buildString {
        append("# Notes Penmoss has not brought back\n\n")
        append("Android cleared this notebook's storage on the phone. These copies were on the phone from before, ")
        append("and have not been brought back as notes: waiting for a sync, or they could not be. What of each can be read follows.\n")
        for (copy in kept) {
            val text = runCatching { engine.oldCopyText(copy.noteId, copy.updates, partChars, callMs) }.getOrNull()
            append("\n---\n\n## ").append(text?.title ?: copy.title.ifBlank { "Untitled" }).append("\n\n")
            if (text != null) {
                append(text.markdown.trimEnd()).append('\n')
            } else {
                append("_None of this copy can be read._\n")
            }
        }
    }

    /** Withheld copies (A886), as one markdown file the person can save: every edit typed on them included. */
    suspend fun exportWithheld(copies: List<WithheldCopy>): String = buildString {
        append("# Notes kept on this phone only\n\n")
        append("Each was brought back after Android cleared this notebook's storage on the phone, and its original was then ")
        append("deleted for good on another device, so it was kept on this phone and never pushed. What of each can be read follows.\n")
        for (copy in copies) {
            val text = runCatching { engine.oldCopyText(copy.noteId, copy.updates, partChars, callMs) }.getOrNull()
            append("\n---\n\n## ").append(text?.title ?: copy.title.ifBlank { "Untitled" }).append("\n\n")
            if (text != null) append(text.markdown.trimEnd()).append('\n') else append("_None of this copy can be read._\n")
        }
    }

    private suspend fun ended() {
        runCatching { engine.endOldCopies() }
    }

    /**
     * Runs passes in [scope], one at a time: asked during one, another follows it (a sync landed
     * meanwhile). Never throws; [onPass] hears of each pass that had copies.
     */
    class Runner(private val scope: CoroutineScope, private val pass: suspend () -> RecoveryPass?, private val onPass: (RecoveryPass) -> Unit, private val log: (String) -> Unit = {}) {
        private val again = AtomicBoolean(false)
        private val running = AtomicBoolean(false)

        fun soon() {
            again.set(true)
            if (!running.compareAndSet(false, true)) return
            scope.launch {
                try {
                    while (again.getAndSet(false)) {
                        try {
                            pass()?.let(onPass)
                        } catch (error: CancellationException) {
                            throw error
                        } catch (error: Exception) {
                            log("Bringing back old copies failed (they stay): ${error.message ?: error::class.java.simpleName}")
                        }
                    }
                } finally {
                    running.set(false)
                    if (again.get()) soon()
                }
            }
        }
    }
}
