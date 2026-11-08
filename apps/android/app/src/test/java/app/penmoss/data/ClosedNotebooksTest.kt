package app.penmoss.data

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * T39 pass 3 delta review (A912): a git notebook has no notebooks in it, so a notebook folder
 * closed in one before A912 took Close away is shown again; there is no way left to reopen it.
 */
@RunWith(AndroidJUnit4::class)
class ClosedNotebooksTest {
    private val prefs = ApplicationProvider.getApplicationContext<Context>()
        .getSharedPreferences("git.local-1.${ClosedNotebooks.PREFS}", Context.MODE_PRIVATE)

    @Test
    fun aGitNotebookIgnoresTheNotebooksClosedInItBefore() {
        ClosedNotebooks(prefs, workspace = { null }).setOpen("ideas", false)
        assertEquals(setOf("ideas"), ClosedNotebooks(prefs, workspace = { null }).closed.value)

        val git = ClosedNotebooks(prefs, workspace = { null }, inGitNotebook = true)
        assertEquals(emptySet<String>(), git.closed.value)
        git.setOpen("plans", false)
        assertEquals(emptySet<String>(), git.closed.value)
    }
}
