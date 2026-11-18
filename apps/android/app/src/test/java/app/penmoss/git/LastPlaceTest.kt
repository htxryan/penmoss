package app.penmoss.git

import android.content.Context
import androidx.core.os.bundleOf
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.ui.NOTE_ROUTE
import app.penmoss.ui.settings.SettingsRoutes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/** Where the app was left (A1624): what each screen leaves to come back to, kept across launches. */
@RunWith(AndroidJUnit4::class)
class LastPlaceTest {
    @Test
    fun aNoteOrAFolderIsKeptAndEverySettingsPageIsSettingsItself() {
        assertEquals(LastPlace("nb", LastPlace.Kind.NOTE, "n1"), LastPlace.of("nb", NOTE_ROUTE, bundleOf("id" to "n1")))
        assertEquals(LastPlace("nb", LastPlace.Kind.FOLDER, "f1"), LastPlace.of("nb", "folder/{id}", bundleOf("id" to "f1")))
        assertEquals(LastPlace("nb", LastPlace.Kind.NOTES), LastPlace.of("nb", "home", null))
        // Settings, any page of it: its first page, Add Notebook too.
        for (route in listOf(SettingsRoutes.HOME, SettingsRoutes.APPEARANCE, SettingsRoutes.GITHUB, SettingsRoutes.ADD_NOTEBOOK, SettingsRoutes.NOTEBOOK)) {
            assertEquals(route, LastPlace("nb", LastPlace.Kind.SETTINGS), LastPlace.of("nb", route, null))
        }
        // Another screen (Search, Trash…): the notes list.
        assertEquals(LastPlace("nb", LastPlace.Kind.NOTES), LastPlace.of("nb", "trash", null))
    }

    @Test
    fun theLastPlaceIsReadBackAfterARestart() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        assertNull(LastPlace.read(context))
        LastPlace.write(context, LastPlace("nb2", LastPlace.Kind.FOLDER, "f9"))
        assertEquals(LastPlace("nb2", LastPlace.Kind.FOLDER, "f9"), LastPlace.read(context))
        LastPlace.write(context, LastPlace("nb2", LastPlace.Kind.SETTINGS))
        assertEquals(LastPlace("nb2", LastPlace.Kind.SETTINGS), LastPlace.read(context))
    }
}
