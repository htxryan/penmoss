package app.penmoss.analytics

import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.engine.bridge.BridgeProtocol
import app.penmoss.engine.bridge.FromEditor
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * A tracked control inside the note's editor page is recorded under the id the Mac records
 * (PEN-175, AC5): the page posts `{v: 1, type: 'click', id, state?}` for a widget's `data-event`
 * (a callout's fold, a code block's Copy, a task's check box), the bridge reads its shape, and the
 * app records `click <id>` only when the catalogue lists the id; any other is dropped.
 */
@RunWith(AndroidJUnit4::class)
class EditorClicksTest {
    private val phone = AnalyticsHarness()

    private val catalogue = AnalyticsCatalogue.parse(
        (System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("analytics-v1.json") } ?: File("../contract/analytics-v1.json")).readText(),
    )

    @After
    fun close() {
        Analytics.install(null)
        phone.close()
    }

    /** What the app does with a message from the page: NoteEditorController's `FromEditor.Click`. */
    private fun fromPage(raw: String): Boolean {
        val message = BridgeProtocol.decodeFromEditor(raw) as? FromEditor.Click ?: return false
        return recordPageClick(message.id, message.state, catalogue)
    }

    @Test
    fun aClickInTheNoteIsRecordedUnderTheMacsId() = runBlocking {
        Analytics.install(phone.service)
        assertTrue(fromPage("""{"v":1,"type":"click","id":"editor.callout.fold"}"""))
        assertTrue(fromPage("""{"v":1,"type":"click","id":"editor.code.copy"}"""))
        assertTrue(fromPage("""{"v":1,"type":"click","id":"editor.task.toggle","state":"on"}"""))
        phone.service.flush()
        val clicks = phone.store.page(null, null, 100).filter { it.kind == "click" }
        assertEquals(listOf("editor.callout.fold", "editor.code.copy", "editor.task.toggle"), clicks.map { it.name }.sorted())
        assertEquals("""{"state":"on"}""", clicks.single { it.name == "editor.task.toggle" }.props)
        assertEquals("{}", clicks.single { it.name == "editor.callout.fold" }.props)
    }

    @Test
    fun anIdTheCatalogueLacksIsDropped() = runBlocking {
        Analytics.install(phone.service)
        // Well formed, so the bridge reads it; the catalogue has no such click.
        assertFalse(fromPage("""{"v":1,"type":"click","id":"editor.callout.unknown"}"""))
        // Not an id's shape at all: the bridge refuses it.
        assertNull(BridgeProtocol.decodeFromEditor("""{"v":1,"type":"click","id":"Editor/../x"}"""))
        assertNull(BridgeProtocol.decodeFromEditor("""{"v":1,"type":"click","id":"editor.task.toggle","state":"yes"}"""))
        phone.service.flush()
        assertEquals(emptyList<String>(), phone.store.page(null, null, 100).filter { it.kind == "click" }.map { it.name })
    }
}
