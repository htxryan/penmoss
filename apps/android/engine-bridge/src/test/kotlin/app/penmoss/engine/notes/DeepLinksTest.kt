package app.penmoss.engine.notes

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

/**
 * Deep links read as the Mac app reads them (T40 P7, PL5, A476): every case of
 * apps/android/contract/deep-links-v1.json, which the desktop suite checks too.
 */
class DeepLinksTest {
    private val contract = Json.parseToJsonElement(File("../contract/deep-links-v1.json").readText()).jsonObject

    @Test
    fun opensEachNoteLinkAtItsNote() {
        for (case in contract.getValue("notes").jsonArray) {
            val link = case.jsonObject.getValue("link").jsonPrimitive.content
            val id = case.jsonObject.getValue("id").jsonPrimitive.content
            assertEquals(link, DeepLink.Note(id), DeepLinks.parse(link))
        }
    }

    @Test
    fun opensTheCaptureSheet() {
        for (link in contract.getValue("capture").jsonArray) {
            assertEquals(DeepLink.Capture, DeepLinks.parse(link.jsonPrimitive.content))
        }
    }

    @Test
    fun ignoresEverythingElse() {
        for (link in contract.getValue("ignored").jsonArray) {
            val raw = link.jsonPrimitive.content
            assertNull(raw, DeepLinks.parse(raw))
        }
        assertNull(DeepLinks.parse(null))
        // The sign-in's own link is never a deep link (A283).
        assertNull(DeepLinks.parse("penmoss://auth/callback?code=x&state=y"))
    }
}
