package app.penmoss.engine.git

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The sync cadence (A1013): git notebooks push 12 s after edits settle and pull every minute while
 * the app is visible; notebooks still on the old defaults (60 s, 2 min) move to the new ones once.
 */
class GitCadenceTest {
    @get:Rule
    val temp = TemporaryFolder()

    private val seal = object : SecretSeal {
        override fun seal(plain: String) = "sealed:$plain"

        override fun unseal(sealed: String) = sealed.removePrefix("sealed:")
    }

    private val noGuard = object : GitGuard {
        override suspend fun commitPurges(localId: String, root: String, head: String?, changes: Map<String, ByteArray?>) = CommitPurges(emptyList(), emptyList(), emptyList(), emptyList())

        override suspend fun purgedAt(localId: String, root: String, head: String?) = emptySet<String>()

        override suspend fun titles(localId: String, root: String, head: String?, ids: List<String>) = emptyMap<String, String>()
    }

    private fun notebooks(dir: File) = GitNotebooks(
        dir,
        seal,
        OwnerConfirm { OwnerAnswer.Confirmed },
        noGuard,
        identity = { GitIdentity("Ryan", "ryan@example.invalid") },
    )

    private fun entry(n: Int, push: Int, pull: Int) =
        """{"localId":"01JBQQQQ00000000000000000$n","notebookId":"01JBNOTEBOOK0000000000000$n","name":"N$n","remote":"https://github.com/htxryan/n$n.git","pushDelayS":$push,"pullEveryMin":$pull}"""

    @Test
    fun newNotebooksPushAfter12SecondsAndPullEveryMinute() {
        val entry = GitNotebookEntry(localId = "01JBQQQQ0000000000000000A1", notebookId = "01JBNOTEBOOK000000000000A1", name = "Work", remote = "https://github.com/htxryan/work.git")
        assertEquals(12, entry.pushDelayS)
        assertEquals(1, entry.pullEveryMin)
    }

    @Test
    fun theOldDefaultsMoveToTheNewOnceAndOtherCadencesStay() = runBlocking {
        val dir = temp.newFolder()
        // A registry from before A1013: version 1, with no version at all for older ones.
        File(dir, "git-notebooks.json").writeText(
            """{"version":1,"notebooks":[${entry(1, 60, 2)},${entry(2, 30, 2)},${entry(3, 60, 5)},${entry(4, 60, 1)}]}""",
        )
        val first = notebooks(dir)
        val cadences = first.entries().associate { it.name to (it.pushDelayS to it.pullEveryMin) }
        assertEquals(mapOf("N1" to (12 to 1), "N2" to (30 to 2), "N3" to (60 to 5), "N4" to (60 to 1)), cadences)
        // Written back once, in version 2.
        val written = Json.parseToJsonElement(File(dir, "git-notebooks.json").readText()).jsonObject
        assertEquals(2, written["version"]!!.jsonPrimitive.int)
        assertEquals(12, written["notebooks"]!!.let { it as kotlinx.serialization.json.JsonArray }[0].jsonObject["pushDelayS"]!!.jsonPrimitive.int)

        // Set to 60 s and 2 min by hand after that: kept, never migrated again.
        first.update("01JBQQQQ000000000000000001", pushDelayS = 60, pullEveryMin = 2)
        val again = notebooks(dir).entry("01JBQQQQ000000000000000001")!!
        assertEquals(60 to 2, again.pushDelayS to again.pullEveryMin)
    }

    @Test
    fun aRegistryWithoutAVersionIsMigratedToo() {
        val dir = temp.newFolder()
        File(dir, "git-notebooks.json").writeText("""{"notebooks":[${entry(1, 60, 2)}]}""")
        val only = notebooks(dir).entries().single()
        assertEquals(12 to 1, only.pushDelayS to only.pullEveryMin)
    }
}
