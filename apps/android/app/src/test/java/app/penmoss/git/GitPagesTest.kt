package app.penmoss.git

import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The git pages' origins (T50 G7, A872, A876; PR #167 review): the commit check runs on an origin
 * of its own, so it shares no IndexedDB, storage or BroadcastChannel with the engine pages it
 * checks, and each page loads only its own origin's assets.
 */
@RunWith(AndroidJUnit4::class)
class GitPagesTest {
    @Test
    fun theGuardHasAnOriginOfItsOwnApartFromTheEngines() {
        assertEquals("git.penmoss.invalid", GitPages.hostOf("engine"))
        assertEquals("git-guard.penmoss.invalid", GitPages.hostOf("guard"))
        assertNotEquals(GitPages.ORIGIN, GitPages.GUARD_ORIGIN)
        val engineAsset = Uri.parse("https://git.penmoss.invalid/assets/editor/git.js")
        val guardAsset = Uri.parse("https://git-guard.penmoss.invalid/assets/editor/git.js")
        assertTrue(GitPages.isPageAsset(engineAsset, GitPages.hostOf("engine")))
        assertTrue(GitPages.isPageAsset(guardAsset, GitPages.hostOf("guard")))
        // Neither serves the other's origin, nor anything outside the editor's assets.
        assertFalse(GitPages.isPageAsset(engineAsset, GitPages.hostOf("guard")))
        assertFalse(GitPages.isPageAsset(guardAsset, GitPages.hostOf("engine")))
        assertFalse(GitPages.isPageAsset(Uri.parse("https://git-guard.penmoss.invalid/assets/other/x.js"), GitPages.hostOf("guard")))
        assertFalse(GitPages.isPageAsset(Uri.parse("https://git-guard.penmoss.invalid/assets/editor/../x.js"), GitPages.hostOf("guard")))
    }
}
