package app.penmoss.git

import androidx.compose.ui.test.assert
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.git.CommitKeyType
import app.penmoss.engine.git.GitEngineStatus
import app.penmoss.engine.git.GitNotebookView
import app.penmoss.engine.git.PendingPurge
import app.penmoss.engine.settings.Settings
import app.penmoss.ui.PenmossTheme
import app.penmoss.ui.settingsSections
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.time.ZoneId

/**
 * Settings → Git notebooks (T50 G7, A855, A856, A859): what each notebook shows, and what only the
 * person can do, each through its own confirmation.
 */
@RunWith(AndroidJUnit4::class)
class GitNotebooksScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private val id = "01JBL0000000000000000000L1"
    private val zone = ZoneId.of("America/Chicago")

    private fun view() = GitNotebookView(
        localId = id,
        notebookId = "01JBN0000000000000000000N1",
        name = "Work",
        create = false,
        remote = "https://github.com/htxryan/work",
        repository = "github.com/htxryan/work",
        host = "github.com",
        branch = "main",
        dir = "docs/notes",
        pushDelayS = 60,
        pullEveryMin = 2,
        wifiOnly = false,
        hasToken = true,
    )

    /**
     * T39 pass 3 (A893): a file edited by hand in the repository is written again from its note, as
     * the Mac and the CLI say; the phone said it was "read back", as if the edit had been kept.
     */
    @Test
    fun handEditedFilesAreSaidToBeWrittenAgainFromTheNotes() {
        assertEquals(
            "Edited by hand: Penmoss wrote it again from the notes (edit them in Penmoss): Garden.md",
            handEditsText(listOf("Garden.md")),
        )
        val many = handEditsText((1..7).map { "n$it.md" })
        assertEquals("Edited by hand: Penmoss wrote these again from the notes (edit them in Penmoss): n1.md, n2.md, n3.md, n4.md, n5.md…", many)
        assertFalse(many.contains("read back"))
    }

    @Test
    fun aSyncThatRunsLongSaysItWaitsForTheHostNeverSyncingForEver() {
        val at = 1_761_750_000_000L
        assertEquals("Syncing…", gitStatusLine(GitEngineStatus(phase = "syncing", since = at), "github.com", now = at + 2_000, zone = zone))
        assertEquals("Waiting for github.com…", gitStatusLine(GitEngineStatus(phase = "syncing", since = at), "github.com", now = at + 20_000, zone = zone))
        assertEquals(
            "Offline: changes stay on this phone. Tries again at 10:04 AM · 2 changes not pushed",
            gitStatusLine(GitEngineStatus(phase = "offline", nextRetryAt = at + 4 * 60_000, pending = listOf("a", "b")), "github.com", now = at, zone = zone),
        )
        assertEquals("Synced at 10:00 AM", gitStatusLine(GitEngineStatus(phase = "synced", lastSyncAt = at), "github.com", now = at, zone = zone))
        assertEquals("Delete for good waits.", gitStatusLine(GitEngineStatus(phase = "stopped", detail = "Delete for good waits."), "github.com"))
    }

    /**
     * #172 (A921): Sign commits per notebook, this phone's public key to add to GitHub with Copy,
     * and a sync that could not sign says "Sync stopped: signing".
     */
    @Test
    fun signCommitsIsPerNotebookShowsThePublicKeyAndASigningFailureStopsTheSync() {
        val signed = mutableListOf<Pair<String, Boolean>>()
        val copied = mutableListOf<String>()
        val made = mutableListOf<CommitKeyType>()
        val key = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY= Penmoss for Pixel 9"
        var shown by mutableStateOf(GitNotebooksUi(rows = listOf(GitRow(view(), GitEngineStatus(phase = "synced")))))
        compose.setContent {
            PenmossTheme {
                GitNotebooksScreen(
                    shown,
                    GitNotebooksActions(
                        onSignCommits = { localId, on -> signed += localId to on },
                        onCopySigningKey = { copied += it },
                        onNewSigningKey = { made += it },
                    ),
                    onBack = {},
                )
            }
        }
        // No key until signing is first turned on.
        compose.onNodeWithTag("gitSigningKey").assertDoesNotExist()
        compose.onNodeWithTag("gitSign-$id").performScrollTo().performClick()
        assertEquals(listOf(id to true), signed)
        shown = GitNotebooksUi(
            rows = listOf(
                GitRow(
                    view().copy(signCommits = true),
                    GitEngineStatus(phase = "stopped", detail = "Sync stopped: signing. This phone could not sign the commit (the key is gone), so nothing was committed; turn Sign commits off, or make a new key, in Settings → Git notebooks."),
                ),
            ),
            signingKey = key,
        )
        compose.onNodeWithTag("gitStatus-$id").assertTextContains("Sync stopped: signing.", substring = true)
        compose.onNodeWithTag("gitSigningKey").performScrollTo().assertTextEquals(key)
        compose.onNodeWithTag("gitSigningKeyCopy").performScrollTo().performClick()
        assertEquals(listOf(key), copied)
        // #174 delta review: a new key replaces this phone's for every notebook, so it asks first,
        // naming what changes; Cancel keeps the key.
        compose.onNodeWithTag("gitSigningKeyNew").performScrollTo().performClick()
        compose.onNodeWithTag("gitSigningKeyWords").assertTextContains("Work", substring = true)
            .assertTextContains("add its public key to GitHub", substring = true)
            .assertTextContains("deletes this phone's signing key", substring = true)
        compose.onNodeWithTag("gitSigningKeyCancel").performClick()
        compose.onNodeWithTag("gitSigningKeyWords").assertDoesNotExist()
        assertEquals(emptyList<CommitKeyType>(), made)
        compose.onNodeWithTag("gitSigningKeyNew").performScrollTo().performClick()
        compose.onNodeWithTag("gitSigningKeyConfirm").performClick()
        assertEquals(listOf(CommitKeyType.P256), made)
        // #174 review: an Ed25519 key, where the phone's Keystore can make one; it asks as well.
        compose.onNodeWithTag("gitSigningKeyNewEd25519").performScrollTo().assertTextEquals("Make an Ed25519 Key").performClick()
        compose.onNodeWithTag("gitSigningKeyWords").assertTextContains("Ed25519", substring = true)
        compose.onNodeWithTag("gitSigningKeyConfirm").performClick()
        assertEquals(listOf(CommitKeyType.P256, CommitKeyType.ED25519), made)
        compose.onNodeWithTag("gitSign-$id").performScrollTo().performClick()
        assertEquals(listOf(id to true, id to false), signed)
    }

    /** #170 F6: a notebook's own commit name and email, saved for it alone; blank is the phone's. */
    @Test
    fun aNotebooksCommitNameAndEmailAreSavedForItAlone() {
        val saved = mutableListOf<Triple<String, String, String>>()
        var shown by mutableStateOf(GitNotebooksUi(rows = listOf(GitRow(view(), GitEngineStatus(phase = "synced")))))
        compose.setContent {
            PenmossTheme {
                GitNotebooksScreen(
                    shown,
                    GitNotebooksActions(onAuthor = { localId, name, email -> saved += Triple(localId, name, email) }),
                    onBack = {},
                )
            }
        }
        compose.onNodeWithTag("gitAuthorSave-$id").assertDoesNotExist()
        compose.onNodeWithTag("gitAuthorName-$id").performScrollTo().performTextInput("Ryan")
        compose.onNodeWithTag("gitAuthorEmail-$id").performScrollTo().performTextInput("1234+ryan@users.noreply.github.com")
        compose.onNodeWithTag("gitAuthorSave-$id").performScrollTo().performClick()
        assertEquals(listOf(Triple(id, "Ryan", "1234+ryan@users.noreply.github.com")), saved)
        shown = GitNotebooksUi(
            rows = listOf(GitRow(view().copy(author = app.penmoss.engine.git.GitIdentity("Ryan", "1234+ryan@users.noreply.github.com")), GitEngineStatus(phase = "synced"))),
        )
        compose.onNodeWithTag("gitAuthorEmail-$id").performScrollTo().assertTextContains("1234+ryan@users.noreply.github.com")
        compose.onNodeWithTag("gitAuthorSave-$id").assertDoesNotExist()
    }

    @Test
    fun removeSaysWhatIsLostAndRemovesOnlyOnceConfirmed() {
        val removed = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                GitNotebooksScreen(
                    GitNotebooksUi(rows = listOf(GitRow(view(), GitEngineStatus(phase = "synced", pending = listOf("n1", "n2", "workspace"))))),
                    GitNotebooksActions(onRemove = { removed += it }),
                    onBack = {},
                )
            }
        }
        compose.onNodeWithText("github.com/htxryan/work · docs/notes/").assertIsDisplayed()
        // No privacy line: Penmoss asks GitHub nothing about who can read the repository (D61).
        compose.onNodeWithText("GitHub says so", substring = true).assertDoesNotExist()
        compose.onNodeWithTag("gitRemove-$id").performScrollTo().performClick()
        compose.onNodeWithText("3 changes not pushed yet are lost", substring = true).assertIsDisplayed()
        assertTrue(removed.isEmpty())
        compose.onNodeWithTag("gitRemoveConfirm").performClick()
        assertEquals(listOf(id), removed)
    }

    /**
     * T39 pass 3 review (R1, A913): with changes not pushed, Remove offers Push first, as the Mac
     * does, and its own button says Remove anyway; with everything pushed, just Remove.
     */
    @Test
    fun removeOffersPushFirstWhileChangesAreNotPushed() {
        val removed = mutableListOf<String>()
        val synced = mutableListOf<String>()
        var status by mutableStateOf(GitEngineStatus(phase = "synced", pending = listOf("n1", "n2")))
        compose.setContent {
            PenmossTheme {
                GitNotebooksScreen(
                    GitNotebooksUi(rows = listOf(GitRow(view(), status))),
                    GitNotebooksActions(onRemove = { removed += it }, onSyncNow = { synced += it }, unpushed = { status.pending.size }),
                    onBack = {},
                )
            }
        }
        compose.onNodeWithTag("gitRemove-$id").performScrollTo().performClick()
        compose.onNodeWithTag("gitRemoveConfirm").assertTextEquals("Remove Anyway")
        compose.onNodeWithTag("gitRemovePushFirst").performClick()
        assertEquals(listOf(id), synced)
        assertTrue(removed.isEmpty())
        compose.onNodeWithTag("gitRemovePushFirst").assertDoesNotExist()
        compose.onNodeWithText("Pushing first. Remove once it says Synced.").performScrollTo().assertIsDisplayed()
        // Pushed: no Push first, and the button is Remove.
        status = GitEngineStatus(phase = "synced", pending = emptyList())
        compose.onNodeWithTag("gitRemove-$id").performScrollTo().performClick()
        compose.onNodeWithTag("gitRemovePushFirst").assertDoesNotExist()
        compose.onNodeWithTag("gitRemoveConfirm").assertTextEquals("Remove").performClick()
        assertEquals(listOf(id), removed)
    }

    /**
     * T39 pass 3 delta review (A913): Remove counts Room's unsent edits too, not only the engine's
     * changes, so "Everything here is pushed" is said only when both are pushed.
     */
    @Test
    fun removeCountsRoomsUnsentEditsAsNotPushed() {
        // The engine has pushed everything; Room still has 2 edits to send.
        var unsent: Int? = 2
        compose.setContent {
            PenmossTheme {
                GitNotebooksScreen(
                    GitNotebooksUi(rows = listOf(GitRow(view(), GitEngineStatus(phase = "synced", pending = emptyList())))),
                    GitNotebooksActions(unpushed = { unsent }),
                    onBack = {},
                )
            }
        }
        compose.onNodeWithTag("gitRemove-$id").performScrollTo().performClick()
        compose.onNodeWithTag("gitRemoveWords").assertTextContains("2 changes not pushed yet are lost.", substring = true)
        compose.onNodeWithTag("gitRemovePushFirst").assertIsDisplayed()
        compose.onNodeWithTag("gitRemoveConfirm").assertTextEquals("Remove Anyway")
        compose.onNodeWithText("Cancel").performClick()
        // Not known (the notebook's page not open): it may lose changes, and Push first is offered.
        unsent = null
        compose.onNodeWithTag("gitRemove-$id").performScrollTo().performClick()
        compose.onNodeWithTag("gitRemoveWords").assertTextContains("Changes not pushed yet, if any, are lost.", substring = true)
        compose.onNodeWithTag("gitRemovePushFirst").assertIsDisplayed()
        compose.onNodeWithText("Cancel").performClick()
        // Both pushed: Remove, and it says so.
        unsent = 0
        compose.onNodeWithTag("gitRemove-$id").performScrollTo().performClick()
        compose.onNodeWithTag("gitRemoveWords").assertTextContains("Everything here is pushed.", substring = true)
        compose.onNodeWithTag("gitRemovePushFirst").assertDoesNotExist()
        compose.onNodeWithTag("gitRemoveConfirm").assertTextEquals("Remove")
    }

    /**
     * T39 pass 3 review (R1, A913): a Delete for good never confirmed on this phone can be confirmed
     * here (the phone's own check, in the engine), and a Keep note has its Undo, as on the Mac.
     */
    @Test
    fun aNoteNeverConfirmedHereCanBeDeletedForGoodAndAKeepCanBeUndone() {
        val confirmed = mutableListOf<String>()
        val undone = mutableListOf<String>()
        val purges = listOf(PendingPurge("01JBN0000000000000000000P2", "Marked by a script", confirmedBefore = false))
        val kept = listOf(PendingPurge("01JBN0000000000000000000P4", "Seed list", confirmedBefore = false))
        compose.setContent {
            PenmossTheme {
                GitNotebooksScreen(
                    GitNotebooksUi(rows = listOf(GitRow(view(), GitEngineStatus(phase = "stopped", code = "purge_unconfirmed", detail = "Delete for good waits."), purges, kept = kept))),
                    GitNotebooksActions(onConfirmPurge = { _, note -> confirmed += note }, onUndoKeep = { _, note -> undone += note }),
                    onBack = {},
                )
            }
        }
        compose.onNodeWithTag("gitPurgeNote-01JBN0000000000000000000P2").performScrollTo().assertTextEquals("Delete for Good").performClick()
        assertEquals(listOf("01JBN0000000000000000000P2"), confirmed)
        compose.onNodeWithTag("gitKept-01JBN0000000000000000000P4", useUnmergedTree = true).performScrollTo()
            .assert(hasText("Kept \u2068Seed list\u2069.", substring = true))
        compose.onNodeWithTag("gitKeepUndo-01JBN0000000000000000000P4").performScrollTo().performClick()
        assertEquals(listOf("01JBN0000000000000000000P4"), undone)
    }

    @Test
    fun onlyANoteConfirmedHereCanBeConfirmedAgainAndEveryOneCanBeKept() {
        val again = mutableListOf<List<String>>()
        val kept = mutableListOf<String>()
        val purges = listOf(
            PendingPurge("01JBN0000000000000000000P1", "Budget", confirmedBefore = true),
            PendingPurge("01JBN0000000000000000000P2", "Marked by a script", confirmedBefore = false),
            // A title from the branch that would reorder or fake the words around it.
            PendingPurge("01JBN0000000000000000000P3", "Budget \u202Egnirts\u2069 \u201D] Keep", confirmedBefore = true),
        )
        compose.setContent {
            PenmossTheme {
                GitNotebooksScreen(
                    GitNotebooksUi(rows = listOf(GitRow(view(), GitEngineStatus(phase = "stopped", code = "purge_unconfirmed", detail = "Delete for good waits."), purges))),
                    GitNotebooksActions(onConfirmPurges = { _, ids -> again += ids }, onKeep = { _, note -> kept += note }),
                    onBack = {},
                )
            }
        }
        compose.onNodeWithText("Never confirmed on this phone").performScrollTo().assertIsDisplayed()
        // Shown cleaned and isolated, as the owner check names it.
        compose.onNodeWithTag("gitPurgeTitle-01JBN0000000000000000000P3", useUnmergedTree = true).performScrollTo()
            .assert(hasText("\u2068Budget gnirts Keep\u2069"))
        compose.onNodeWithTag("gitConfirmPurges-$id").performScrollTo().performClick()
        assertEquals(listOf(listOf("01JBN0000000000000000000P1", "01JBN0000000000000000000P3")), again)
        compose.onNodeWithTag("gitKeep-01JBN0000000000000000000P2").performScrollTo().performClick()
        assertEquals(listOf("01JBN0000000000000000000P2"), kept)
    }

    @Test
    fun notesBroughtBackAfterAndroidClearedTheStoreAreNamedUntilDismissed() {
        val dismissed = mutableListOf<String>()
        val notice = GitRecoveryNotice(1_761_750_000_000L, listOf("Budget for 2027 (recovered)", "Draft (recovered)"))
        compose.setContent {
            PenmossTheme {
                GitNotebooksScreen(
                    GitNotebooksUi(rows = listOf(GitRow(view(), GitEngineStatus(phase = "synced"), recovered = notice, storageKept = false))),
                    GitNotebooksActions(onDismissRecovery = { dismissed += it }),
                    onBack = {},
                )
            }
        }
        compose.onNodeWithText("2 notes held changes not pushed yet", substring = true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("“Budget for 2027 (recovered)”", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("gitStorage-$id").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("gitRecoveredDismiss").performScrollTo().performClick()
        assertEquals(listOf(id), dismissed)
        assertEquals(notice, GitRecoveryNotice.decode(notice.encode()))
    }

    @Test
    fun copiesThatCouldNotBeBroughtBackAreNamedWithAWayToSaveTheirText() {
        val saved = mutableListOf<String>()
        val notice = GitRecoveryNotice(1_761_750_000_000L, listOf("Draft (recovered)"), unrecovered = listOf("Broken"))
        compose.setContent {
            PenmossTheme {
                GitNotebooksScreen(
                    GitNotebooksUi(rows = listOf(GitRow(view(), GitEngineStatus(phase = "synced"), recovered = notice))),
                    GitNotebooksActions(onSaveUnrecovered = { saved += it }),
                    onBack = {},
                )
            }
        }
        compose.onNodeWithText("1 copy couldn't be recovered, “Broken”", substring = true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("“Draft (recovered)”", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("gitRecoveredSave").performScrollTo().performClick()
        assertEquals(listOf(id), saved)
        // Dismissed, it says nothing until something new; the kept copy stays named in it.
        val quiet = notice.copy(titles = emptyList(), quiet = true)
        assertFalse(quiet.shown)
        assertEquals(quiet, GitRecoveryNotice.decode(quiet.encode()))
        // A notice saved before these fields reads as it was.
        assertEquals(GitRecoveryNotice(1L, listOf("A")), GitRecoveryNotice.decode("""{"at":1,"titles":["A"]}"""))
    }

    @Test
    fun aCopyWithheldFromThePushIsSaidWithSaveTheirTextDeleteForGoodAndKeepAndSync() {
        val saved = mutableListOf<String>()
        val dropped = mutableListOf<Pair<String, String>>()
        val keptAndSynced = mutableListOf<Pair<String, String>>()
        val copy = "01JBN0000000000000000000C1"
        compose.setContent {
            PenmossTheme {
                GitNotebooksScreen(
                    GitNotebooksUi(
                        rows = listOf(
                            GitRow(
                                view(),
                                GitEngineStatus(phase = "synced"),
                                oldCopies = GitOldCopies(waiting = 0, kept = 0, withheld = 1),
                                withheld = listOf(WithheldView(copy, "Passwords NEWEDIT (recovered)")),
                            ),
                        ),
                    ),
                    GitNotebooksActions(
                        onSaveWithheld = { saved += it },
                        onDropWithheld = { id, note -> dropped += id to note },
                        onKeepWithheld = { id, note -> keptAndSynced += id to note },
                    ),
                    onBack = {},
                )
            }
        }
        compose.onNodeWithText("A recovered copy of a note deleted for good on another device was kept on this device only.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("gitWithheldTitle-$copy").assertIsDisplayed()
        compose.onNodeWithText("Passwords NEWEDIT (recovered)", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("gitWithheldSave").performScrollTo().performClick()
        compose.onNodeWithTag("gitWithheldDelete-$copy").performScrollTo().performClick()
        compose.onNodeWithTag("gitWithheldKeep-$copy").performScrollTo().performClick()
        assertEquals(listOf(id), saved)
        assertEquals(listOf(id to copy), dropped)
        assertEquals(listOf(id to copy), keptAndSynced)
        // Remove says it is lost too.
        compose.onNodeWithTag("gitRemove-$id").performScrollTo().performClick()
        compose.onNodeWithText("Lost too: 1 recovered copy is kept on this phone only.", substring = true).assertIsDisplayed()
    }

    @Test
    fun copiesHeldForASyncAreSaidInSettingsAndRemoveSaysTheyAreLostAndOffersToSaveThem() {
        val saved = mutableListOf<String>()
        val removed = mutableListOf<String>()
        compose.setContent {
            PenmossTheme {
                GitNotebooksScreen(
                    GitNotebooksUi(rows = listOf(GitRow(view(), GitEngineStatus(phase = "offline", pending = emptyList()), oldCopies = GitOldCopies(waiting = 2, kept = 1)))),
                    GitNotebooksActions(onSaveUnrecovered = { saved += it }, onRemove = { removed += it }),
                    onBack = {},
                )
            }
        }
        compose.onNodeWithTag("gitWaiting-$id").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("2 notes from before the store was cleared are waiting for a sync", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("gitWaitingSave-$id").performScrollTo().performClick()
        assertEquals(listOf(id), saved)
        compose.onNodeWithTag("gitRemove-$id").performScrollTo().performClick()
        compose.onNodeWithText(
            "Lost too: 2 notes from before the store was cleared are waiting for a sync; 1 copy couldn't be recovered.",
            substring = true,
        ).assertIsDisplayed()
        compose.onNodeWithTag("gitRemoveSave").performClick()
        assertEquals(listOf(id, id), saved)
        assertEquals(emptyList<String>(), removed)
    }

    @Test
    fun anyRepositorySyncsAndNobodyConfirmsIt() {
        val added = mutableListOf<AddForm>()
        compose.setContent {
            PenmossTheme {
                GitNotebooksScreen(
                    GitNotebooksUi(rows = listOf(GitRow(view(), null))),
                    GitNotebooksActions(onAdd = { added += it }),
                    onBack = {},
                )
            }
        }
        // D51, D61: no privacy line, and no Confirm private anywhere.
        assertTrue(compose.onAllNodes(hasTestTag("gitPrivacy-$id")).fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodes(hasText("Confirm Private", substring = true, ignoreCase = true)).fetchSemanticsNodes().isEmpty())
        assertTrue(compose.onAllNodes(hasTestTag("gitConfirmPrivate-$id")).fetchSemanticsNodes().isEmpty())
        compose.onNodeWithText("Opens when you open the notebook", substring = true).performScrollTo().assertIsDisplayed()
        // Add is the one button, with no confirmation to give.
        compose.onNodeWithTag("gitAddRemote").performScrollTo().performTextInput("https://git.example.com/me/notes.git")
        compose.onNode(hasTestTag("gitAdd")).performScrollTo().performClick()
        assertEquals(listOf("https://git.example.com/me/notes.git"), added.map { it.remote })
        assertTrue(compose.onAllNodes(hasTestTag("gitAddConfirm")).fetchSemanticsNodes().isEmpty())
    }

    /** The app's home (A1040): the notebooks under "Penmoss", with no first-run words once there is one. */
    @Test
    fun theHomeListsTheNotebooksAndTheFirstRunAsksToAddOne() {
        compose.setContent { PenmossTheme { GitNotebooksScreen(GitNotebooksUi(home = true), GitNotebooksActions(), onBack = {}) } }
        compose.onNodeWithText("Penmoss").assertExists()
        compose.onNodeWithTag("gitFirstRun").assertTextEquals(FIRST_RUN)
        compose.onNode(hasTestTag("gitAdd")).performScrollTo().assertExists()
        compose.onNodeWithText("Sign In", substring = true).assertDoesNotExist()
    }

    @Test
    fun withANotebookThereAreNoFirstRunWords() {
        compose.setContent { PenmossTheme { GitNotebooksScreen(GitNotebooksUi(rows = listOf(GitRow(view(), null)), home = true), GitNotebooksActions(), onBack = {}) } }
        compose.onNodeWithTag("gitFirstRun").assertDoesNotExist()
        compose.onNodeWithTag("gitNotebook-${view().localId}").assertExists()
        // The Journal notebook is a git notebook's only: no personal notes to pick.
        compose.onNodeWithTag("gitJournal-personal").assertDoesNotExist()
    }

    @Test
    fun aGitNotebooksSettingsKeepAppearanceFirstAndNothingOfTheAccount() {
        val ids = settingsSections(Settings(), "Penmoss", "", 0).map { it.id }
        assertEquals("appearance", ids.first())
        assertEquals(listOf("appearance", "display", "symbols", "git", "daily", "capture", "shortcuts", "sync", "about"), ids)
        for (account in listOf("notebooks", "mirror", "status", "devices", "phone")) assertFalse(account, account in ids)
        assertEquals("Notes in a private GitHub repository", gitSummary(0))
        assertEquals("2 notebooks on this phone", gitSummary(2))
    }
}
