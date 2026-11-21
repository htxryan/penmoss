package app.penmoss.analytics

import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Refs on the phone (PEN-177, AC1–AC4, AC22): a note or folder named in session detail is its
 * keyed hash, never its id; the same note has the same ref until the analytics ID is reset; Reset
 * My Analytics ID and Delete My Shared Data make a new key; the key is kept with the answer and
 * never leaves the phone. analytics-v1.json's `refVectors` pin the hash itself
 * (AnalyticsContractTest).
 */
@RunWith(AndroidJUnit4::class)
class AnalyticsRefsTest {
    private val phone = AnalyticsHarness()
    private val service = phone.service

    @After
    fun close() = phone.close()

    private val noteId = "01JD2Z7Q8R4T6Y8W0E2R4T6YB1"
    private val folderId = "01JD2Z7Q8R4T6Y8W0E2R4T6YF1"

    private suspend fun cursor(): JsonObject {
        assertTrue(service.recordWithRefs("note", "cursor", mapOf("block" to 2), mapOf("note" to ("note" to noteId))))
        service.flush()
        return Json.parseToJsonElement(phone.store.page(null, null, 1).single().props) as JsonObject
    }

    @Test
    fun aNoteIsNamedByItsRefTheSameEachTime() = runBlocking {
        val key = service.stateNow().refKey
        assertTrue(AnalyticsRefs.KEY.matches(key))
        // Kept with the answer, read back the same.
        assertEquals(key, phone.consent.now().refKey)
        val first = cursor()
        val again = cursor()
        val ref = first.getValue("note").jsonPrimitive.content
        assertTrue(SessionDetail.REF.matches(ref))
        assertEquals(AnalyticsRefs.refOf(key, "note", noteId), ref)
        assertEquals(ref, again.getValue("note").jsonPrimitive.content)
        // A folder's ref is its own; one at the top level is left out.
        service.recordWithRefs(
            "tree",
            "open",
            mapOf("depth" to 1, "source" to "click"),
            mapOf("note" to ("note" to noteId), "folder" to ("folder" to folderId)),
        )
        service.recordWithRefs("tree", "open", mapOf("depth" to 0, "source" to "click"), mapOf("note" to ("note" to noteId), "folder" to ("folder" to null)))
        service.flush()
        val (top, inFolder) = phone.store.page(null, null, 2).map { Json.parseToJsonElement(it.props) as JsonObject }
        assertEquals(AnalyticsRefs.refOf(key, "folder", folderId), inFolder.getValue("folder").jsonPrimitive.content)
        assertFalse("folder" in top)
        for (row in phone.store.page(null, null, 10)) assertFalse(row.props, row.props.contains(noteId) || row.props.contains(folderId))
    }

    @Test
    fun aNewIdMakesANewKeyAndANewRef() = runBlocking {
        val before = service.stateNow().refKey
        val ref = cursor().getValue("note").jsonPrimitive.content
        service.resetId()
        val after = service.stateNow().refKey
        assertNotEquals(before, after)
        assertTrue(AnalyticsRefs.KEY.matches(after))
        assertNotEquals(ref, cursor().getValue("note").jsonPrimitive.content)
        // Delete My Shared Data: the server forgets, then a new ID and a new key.
        assertEquals(ForgetOutcome.OK, service.forget())
        assertNotEquals(after, service.stateNow().refKey)
    }

    @Test
    fun theKeyNeverLeavesThePhone() = runBlocking {
        service.answer(ConsentAnswer.YES, "0.4.2")
        val key = service.stateNow().refKey
        cursor()
        assertTrue(service.sendDue())
        val bodies = phone.endpoint.requests.map { it.second }
        assertTrue(bodies.isNotEmpty())
        for (body in bodies) assertFalse(body.contains(key))
        // Nor the record the viewer shows and copies.
        for (row in phone.store.page(null, null, 100)) assertFalse(row.props.contains(key))
    }
}
