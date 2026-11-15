package app.penmoss.engine.settings

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The open source notices on the phone (A1580): the web's `third-party-notices.txt` itself, so
 * it holds Lucide's licence and, word for word, the notice shipped beside the Characters.
 */
class NoticesTest {
    @Test
    fun theNoticesAreTheWebsFileWithLucidesLicenceAndTheCharactersNotice() {
        val text = Notices.text
        // From apps/android/contract, as the contract tests find their files.
        val contract = System.getProperty("penmoss.contract")?.let { File(it).parentFile } ?: File("../contract")
        assertEquals(contract.resolve("../../web/public/third-party-notices.txt").readText(), text)
        assertTrue(text.contains("Lucide 1.70.0"))
        assertTrue(text.contains("ISC License"))
        assertTrue(text.contains("derived from the Feather project"))
        val characters = Notices::class.java.getResourceAsStream("/characters-NOTICE.txt")!!
            .bufferedReader(Charsets.UTF_8).use { it.readText() }
        assertTrue(text.contains(characters.trim()))
        assertTrue(characters.contains("UNICODE LICENSE V3"))
    }
}
