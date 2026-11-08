package app.penmoss.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * T32's acceptance criterion "Kotlin never parses Yjs" (A11), checked on the
 * source: no Kotlin file in the app decodes base64 updates or reads Yjs's
 * encoding (varints, state vectors, structs), and none depends on a Yjs port
 * (y-crdt, yrs). Updates are stored and sent as the strings they arrived as.
 */
class NoYjsInKotlinTest {
    private val root = File(System.getProperty("penmoss.androidRoot") ?: "..")

    private val forbidden = listOf(
        Regex("""Base64\.getDecoder|android\.util\.Base64\.decode|\.decodeBase64\("""),
        Regex("""readVarUint|readVarInt|decodeStateVector|encodeStateVector|readUpdate|mergeUpdates"""),
        Regex("""\by[-_]?crdt\b|\byrs\b|\bYDoc\b""", RegexOption.IGNORE_CASE),
    )

    @Test
    fun noKotlinSourceReadsYjs() {
        val sources = root.walkTopDown()
            .filter { it.isFile && it.extension in setOf("kt", "kts") }
            .filter { "/build/" !in it.path && it.name != "NoYjsInKotlinTest.kt" }
            .toList()
        assertTrue("found no Kotlin sources under $root", sources.size > 10)
        val hits = sources.flatMap { file ->
            file.readLines().withIndex().flatMap { (index, line) ->
                forbidden.filter { it.containsMatchIn(line) }.map { "${file.relativeTo(root)}:${index + 1}: $line" }
            }
        }
        assertEquals(emptyList<String>(), hits)
    }
}
