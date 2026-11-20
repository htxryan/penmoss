package app.penmoss.analytics

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Every control is counted by name (PEN-137, AC15): each clickable control in the app's sources
 * carries a tracked id or runs a command, each dialog and sheet is tracked by name, and every id
 * written is in the catalogue the app ships (`apps/android/contract/analytics-v1.json`), so none
 * is dropped. A failure names the file and line. [ControlScan] says what counts as a control.
 */
class TrackedControlsTest {
    private val sources = File("src/main/java")

    private val catalogue: AnalyticsCatalogue = run {
        val file = System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("analytics-v1.json") }
            ?: File("../contract/analytics-v1.json")
        AnalyticsCatalogue.parse(file.readText())
    }

    private val scan by lazy { ControlScan.scan(sources) }

    @Test
    fun everyControlHasATrackedIdOrACommand() {
        assertTrue("No sources at ${sources.absolutePath}", sources.isDirectory)
        // The scan finds the app's controls at all.
        assertTrue("Only ${scan.controls} controls found", scan.controls > 300)
        assertTrue("Only ${scan.dialogs} dialogs found", scan.dialogs > 20)
        assertEquals("Controls and dialogs without an id:\n" + scan.problems.joinToString("\n"), emptyList<String>(), scan.problems)
    }

    @Test
    fun everyIdIsInTheCatalogue() {
        val pattern = Regex("^[a-z][a-z0-9-]*(\\.[a-z0-9-]+){1,4}$")
        val unknown = scan.uses.filter { use ->
            !catalogue.has(use.kind, use.name) || (use.kind == "click" && !pattern.matches(use.name))
        }
        assertEquals(
            "Ids not in the catalogue (add them to core's catalogue.ts and write analytics-v1.json again):\n" +
                unknown.joinToString("\n") { "${it.where}: ${it.kind} ${it.name}" },
            emptyList<ControlScan.Use>(),
            unknown,
        )
        assertTrue(scan.uses.count { it.kind == "click" } > 100)
    }

    @Test
    fun theScanFindsAControlWithoutAnId() {
        val dir = kotlin.io.path.createTempDirectory("scan").toFile()
        try {
            File(dir, "Bare.kt").writeText(
                """
                package x
                fun Screen() {
                    TextButton(onClick = { go() }) { Text("Go") }
                    TextButton(onClick = trackedClick("feedback.send") { go() }) { Text("Send") }
                    Row(Modifier.clickable { open() }) {}
                    Row(Modifier.clickable(onClick = trackedClick("tags.row.show") { open() })) {}
                    // untracked: swallows taps over the preview
                    Box(Modifier.clickable(enabled = false) {})
                    Switch(checked = on, onCheckedChange = null)
                    Switch(checked = on, onCheckedChange = trackedToggle("settings.switch") { set(it) })
                    IconButton(onClick = { commands.run("app.search", source = "button") }) {}
                    Text("Button(onClick = { })")
                    AlertDialog(onDismissRequest = {}, title = { Text("Delete This?") })
                    val d = rememberTrackedDialog("confirm")
                    AlertDialog(onDismissRequest = {}, confirmButton = { TextButton(onClick = d.done(trackedClick("x.y-${'$'}z") {})) {} })
                }
                fun TextButton(onClick: () -> Unit) {}
                """.trimIndent(),
            )
            val result = ControlScan.scan(dir)
            assertEquals(
                listOf(
                    "Bare.kt:3: TextButton has no tracked id or command",
                    "Bare.kt:5: clickable has no tracked id or command",
                    "Bare.kt:13: AlertDialog is not tracked by name (rememberTrackedDialog)",
                    "Bare.kt:15: \"x.y-${'$'}z\" is built from data",
                ),
                result.problems,
            )
            assertEquals(
                listOf("click feedback.send", "click tags.row.show", "click settings.switch", "dialog confirm"),
                result.uses.map { "${it.kind} ${it.name}" },
            )
        } finally {
            dir.deleteRecursively()
        }
    }
}
