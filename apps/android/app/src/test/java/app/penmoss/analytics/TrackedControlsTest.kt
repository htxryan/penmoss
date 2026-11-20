package app.penmoss.analytics

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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

    private val contract: String = (
        System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("analytics-v1.json") }
            ?: File("../contract/analytics-v1.json")
        ).readText()

    private val catalogue: AnalyticsCatalogue = AnalyticsCatalogue.parse(contract)

    private val json by lazy { Json.parseToJsonElement(contract).jsonObject }

    private val scan by lazy { ControlScan.scan(sources) }

    @Test
    fun everyControlHasATrackedIdOrACommand() {
        assertTrue("No sources at ${sources.absolutePath}", sources.isDirectory)
        println("ControlScan: ${scan.controls} controls, ${scan.dialogs} dialogs, ${scan.uses.size} ids written, ${scan.problems.size} problems")
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
            // The forms PEN-175 added, each without its id and then with it.
            File(dir, "More.kt").writeText(
                """
                package x
                fun Screen() {
                    Slider(value = v, onValueChange = { v = it }, onValueChangeFinished = { save() })
                    Slider(value = v, onValueChange = { v = it }, onValueChangeFinished = trackedClick("settings.font.size") { save() })
                    RangeSlider(value = r, onValueChange = { r = it })
                    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }) { DropdownMenuItem(text = {}, onClick = trackedClick("a.b") {}) }
                    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }, modifier = Modifier.trackedId("theme-editor.font")) {}
                    PullToRefreshBox(isRefreshing = busy, onRefresh = refresh) {}
                    PullToRefreshBox(isRefreshing = busy, onRefresh = trackedClick("home.pull-to-refresh", refresh)) {}
                    Box(Modifier.pointerInput(Unit) { detectTapGestures { pick(it) } })
                    Box(Modifier.pointerInput(Unit) { detectTapGestures { Analytics.click("colour-picker.wheel"); pick(it) } })
                    Box(Modifier.pointerInput(Unit) { detectDragGestures { _, _ -> } })
                    pushLink(LinkAnnotation.Url(url, styles))
                    pushLink(LinkAnnotation.Url(url, styles, linkInteractionListener = { Analytics.click("markdown-preview.link") }))
                    Primary("Continue", "first-run-continue", "arrow-right") { go() }
                    Plain("Open", "first-run-open", "folder-open", event = "firstrun.setup.open-now") { go() }
                    Options(pick, listOf(Option(1, "One", "", "one"))) { pick = it }
                    Link("Refresh", "first-run-refresh", "refresh-cw", event = "firstrun.list.refresh", onClick = refresh)
                    DropdownMenuItem(text = { Text("Copy", Modifier.tracked("note.copy")) }, onClick = { copy() })
                    Card(onClick = { open() }) { Text("Open", Modifier.tracked("note.open")) }
                    Row(Modifier.clickable(onClick = { open() }) ) { IconButton(onClick = trackedClick("x.y") {}) {} }
                    // untracked: shield
                    Box(Modifier.clickable {})
                    // untracked: swallows taps over the preview
                    Box(Modifier.clickable {})
                    Plain("Open", "first-run-open", "folder-open") { go() }
                    Link("Refresh", "first-run-refresh", "refresh-cw", onClick = refresh)
                }
                """.trimIndent(),
            )
            val result = ControlScan.scan(dir)
            assertEquals(
                listOf(
                    "Bare.kt:3: TextButton has no tracked id or command",
                    "Bare.kt:5: clickable has no tracked id or command",
                    "Bare.kt:13: AlertDialog is not tracked by name (rememberTrackedDialog)",
                    "Bare.kt:15: \"x.y-${'$'}z\" is built from data",
                    "More.kt:19: DropdownMenuItem has no tracked id or command",
                    "More.kt:20: Card has no tracked id or command",
                    "More.kt:6: ExposedDropdownMenuBox has no tracked id or command",
                    "More.kt:8: PullToRefreshBox has no tracked id or command",
                    "More.kt:13: LinkAnnotation.Url has no tracked id or command",
                    "More.kt:3: Slider has no tracked onValueChangeFinished",
                    "More.kt:5: RangeSlider has no tracked onValueChangeFinished",
                    "More.kt:15: Primary has no event =",
                    "More.kt:17: Options has no event =",
                    "More.kt:26: Plain has no event =",
                    "More.kt:27: Link has no event =",
                    "More.kt:10: pointerInput tap gesture has no tracked id or command",
                    "More.kt:22: `// untracked:` needs a reason of three words or more",
                    "More.kt:21: clickable has no tracked id or command",
                    "More.kt:23: clickable has no tracked id or command",
                ),
                result.problems,
            )
            assertEquals(
                listOf("click feedback.send", "click tags.row.show", "click settings.switch", "dialog confirm"),
                result.uses.filter { it.where.startsWith("Bare.kt") }.map { "${it.kind} ${it.name}" },
            )
        } finally {
            dir.deleteRecursively()
        }
    }

    /**
     * No control writes a retired id (PEN-175): the shared fallbacks (`toast.dismiss`,
     * `firstrun.action`…) said nothing of which control was used. They stay in the catalogue, as
     * events already recorded under them do, but no source of the app may write one.
     */
    @Test
    fun noSourceWritesARetiredId() {
        val retired = json.getValue("retiredClickNames").jsonArray.map { it.jsonPrimitive.content }
        assertTrue("The contract lists no retired ids", retired.contains("toast.dismiss"))
        val written = kotlinFiles().flatMap { (file, text) ->
            retired.filter { "\"$it\"" in text }.map { "${file.relativeTo(sources)}: $it" }
        }
        assertEquals("Sources that write a retired id (give the control its own):\n" + written.joinToString("\n"), emptyList<String>(), written)
    }

    /**
     * Every setting the catalogue lists that the phone has is recorded (PEN-175), as the Mac's
     * catalogue test asks of the Mac: each is a key the app writes through the settings' write
     * path, which records every key it writes ([SettingEvents.record]), or a name it records
     * itself ([SettingEvents.recordValue], `Analytics.setting`, `record("setting", …)`), written
     * as a literal or a template's fixed start (`privacy.limits.$key`). Any other must be on
     * [NOT_ON_ANDROID] with why; one on it that the phone does record fails too.
     */
    @Test
    fun everySettingAndroidHasIsRecorded() {
        val settings = json.getValue("catalogue").jsonObject.getValue("setting").jsonArray.map { it.jsonPrimitive.content }
        // The engine's keys too (SettingKeys), but not LocalSettings' list, which only mirrors core's.
        val engine = kotlinFiles(File("../engine-bridge/src/main/kotlin")).filter { it.first.name != "LocalSettings.kt" }
        val texts = (kotlinFiles() + engine).map { it.second }
        val literals = texts.flatMap { text -> LITERAL.findAll(text).map { it.groupValues[1] } }.toSet()
        val templates = texts.flatMap { text -> TEMPLATE.findAll(text).map { it.groupValues[1] } }.toSet()
        fun recorded(name: String) = name in literals || templates.any { name.startsWith(it) }
        val missing = settings.filter { !recorded(it) && it !in NOT_ON_ANDROID }
        assertEquals(
            "Settings in the catalogue the phone neither records nor lists as not on Android:\n" + missing.joinToString("\n"),
            emptyList<String>(),
            missing,
        )
        val stale = NOT_ON_ANDROID.keys.filter { recorded(it) || it !in settings }
        assertEquals("Settings listed as not on Android that it has, or that the catalogue lacks", emptyList<String>(), stale)
        // The names it records are the catalogue's, so none is dropped.
        for (name in settings.filter(::recorded)) {
            assertTrue("$name is not recorded", SettingEvents.eventOf(name, kotlinx.serialization.json.JsonPrimitive(true), catalogue) != null)
        }
    }

    private fun kotlinFiles(root: File = sources): List<Pair<File, String>> =
        root.walkTopDown().filter { it.isFile && it.extension == "kt" }.map { it to it.readText() }.toList()

    private companion object {
        /** A setting's name written whole, as a key's constant or a recorded name. */
        val LITERAL = Regex("\"([a-zA-Z][a-zA-Z0-9]*(?:\\.[a-zA-Z0-9]+)*)\"")

        /** A recorded setting's name built from its fixed start: `"privacy.limits.$key"`. */
        val TEMPLATE = Regex("(?:setting|recordValue|record)\\(\\s*(?:\"setting\",\\s*)?\"([a-z][a-zA-Z0-9.]*\\.)\\${'$'}")

        /** The catalogue's settings the phone has no such setting for, and why. */
        val NOT_ON_ANDROID = mapOf(
            "titleBar.compact" to "the Mac's window title bar; a phone's app has none",
            "menuBar.icon" to "the Mac's menu bar icon; a phone has no menu bar",
            "capture.hotkey" to "the Mac's system-wide Quick Capture shortcut; the phone captures from its widget and the share sheet",
            "updates.auto" to "the Mac updates itself; Google Play updates the phone's app",
            "updates.channel" to "the Mac's update channel; Google Play's tracks are the phone's",
            "meaning.enabled" to "Semantic Search runs on the Mac only",
            "tooltip.delay" to "tooltips show on hover; a phone has no pointer to hover with",
            "home.dadJokes" to "the Mac's Home shows dad jokes; the phone's Home has none",
            "metadata.statusBar" to "the Mac's note status bar; the phone's note has none",
        )
    }
}
