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
 * The per-platform settings (PEN-156, A1605), held to core's by `contract/platform-settings-v1.json`
 * (written by the web's `android-platform-settings-contract.test.ts`).
 */
class PlatformSettingsTest {
    private val folder: File = System.getProperty("penmoss.contract")?.let { File(it).parentFile } ?: File("../contract")
    private val contract: JsonObject = Json.parseToJsonElement(folder.resolve("platform-settings-v1.json").readText()).jsonObject

    @Test
    fun theKeysAndPrefixesAreCores() {
        assertEquals(contract.getValue("keys").jsonArray.map { it.jsonPrimitive.content }, PlatformSettings.KEYS)
        assertEquals(contract.getValue("prefixes").jsonArray.map { it.jsonPrimitive.content }, PlatformSettings.PREFIXES)
        assertEquals("mobile", contract.getValue("android").jsonPrimitive.content)
    }

    @Test
    fun eachSampleIsKeptPerPlatformOrSharedAsCoreSays() {
        for ((key, kept) in contract.getValue("samples").jsonObject) {
            assertEquals(key, kept.jsonPrimitive.boolean, PlatformSettings.isPlatform(key))
        }
    }
}
