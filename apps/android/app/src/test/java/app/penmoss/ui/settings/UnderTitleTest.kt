package app.penmoss.ui.settings

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Settings → Note's Description Under the Title (PEN-161): core's `metadata.underTitle`, kept with the Mac's other fields. */
class UnderTitleTest {
    private fun values(vararg fields: String) = JsonObject(mapOf(UNDER_TITLE to JsonArray(fields.map(::JsonPrimitive))))

    @Test
    fun readsAndWritesTheDescriptionKeepingTheOtherFields() {
        assertFalse(descriptionUnderTitle(JsonObject(emptyMap())))
        assertTrue(descriptionUnderTitle(values("tags", "description")))
        assertEquals(JsonArray(listOf(JsonPrimitive("tags"), JsonPrimitive("description"))), withDescription(values("tags"), true))
        assertEquals(JsonArray(listOf(JsonPrimitive("tags"))), withDescription(values("tags", "description"), false))
    }
}
