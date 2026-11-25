package app.penmoss.engine.settings

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The settings this phone keeps alone (A1626), held to core's by `contract/platform-settings-v1.json`'s
 * `local` (written by the web's `android-platform-settings-contract.test.ts`). Settings' device-only
 * marks come from them (A1685).
 */
class LocalSettingsTest {
    private val folder: File = System.getProperty("penmoss.contract")?.let { File(it).parentFile } ?: File("../contract")
    private val contract: JsonObject = Json.parseToJsonElement(folder.resolve("platform-settings-v1.json").readText()).jsonObject

    @Test
    fun theLocalKeysAreCores() {
        val local = contract.getValue("local").jsonObject
        assertEquals(local.getValue("keys").jsonArray.map { it.jsonPrimitive.content }, LocalSettings.KEYS)
        assertEquals(local.getValue("prefixes").jsonArray.map { it.jsonPrimitive.content }, LocalSettings.PREFIXES)
        for ((key, kept) in local.getValue("samples").jsonObject) {
            assertEquals(key, kept.jsonPrimitive.boolean, LocalSettings.isLocal(key))
        }
    }
}
