package app.penmoss.engine.settings

import app.penmoss.engine.api.ApiException
import app.penmoss.engine.api.HttpPenmossApi
import app.penmoss.engine.api.SettingsChange
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The settings channel's contract (T40 P1, A410, A412): `contract/settings-v1.json`, which the
 * server's vitest checks against the web's rules, and `contract/themes-v1.json`, which the editor
 * page's vitest checks against `@penmoss/ui`. Kotlin reads both the same way here.
 */
class SettingsContractTest {
    private fun contract(name: String): JsonObject {
        val file = System.getProperty("penmoss.contract")?.let { File(it).resolveSibling(name) } ?: File("../contract/$name")
        return Json.parseToJsonElement(file.readText()).jsonObject
    }

    private val settings = contract("settings-v1.json")

    @Test
    fun namesTheSettingsAndTheirDefaultsAsTheServerDoes() {
        assertEquals(settings.getValue("keys").jsonArray.map { it.jsonPrimitive.content }, SettingKeys.ALL)
        assertEquals(settings.getValue("defaults").jsonObject, JsonObject(SettingDefaults.ALL))
        // What the phone shows with nothing set is each default.
        val none = Settings()
        assertEquals(SettingDefaults.THEME, none.themeId)
        assertEquals(SettingDefaults.MODE, none.mode)
        assertEquals(SettingDefaults.TIME_ZONE, none.timeZone)
        assertEquals(SettingDefaults.DAILY_TEMPLATE, none.templateOrDefault(SettingKeys.DAILY_TEMPLATE))
        assertEquals(SettingDefaults.WEEKLY_TEMPLATE, none.templateOrDefault(SettingKeys.WEEKLY_TEMPLATE))
        assertEquals(SettingDefaults.CAPTURE, none.captureDestination)
        assertFalse(none.fullWidth)
        assertEquals(FontSettings.THEME, none.interfaceFont)
        assertEquals(FontSettings.THEME, none.noteFont)
        assertEquals(FontSettings.SIZE_DEFAULT, none.noteFontSize)
        assertEquals(emptyList<String>(), none.quickAccess)
        assertEquals(SidebarLayout.SECTIONS, none.sectionOrder)
        assertEquals(emptySet<String>(), none.hiddenSections)
        assertEquals(SidebarLayout.RECENT_DEFAULT, none.recentCount)
        assertFalse(none.quickAccessShowsNotebook)
    }

    /** The sidebar's sections and Quick Access's notebook names (T53, A983), by core `sidebar-layout.ts`'s rules. */
    @Test
    fun readsAndChecksTheSidebarLayoutAsTheWebDoes() {
        val values = settings.getValue("values").jsonObject
        for (key in listOf(SettingKeys.SECTION_ORDER, SettingKeys.HIDDEN_SECTIONS, SettingKeys.RECENT_COUNT, SettingKeys.QUICK_ACCESS_NOTEBOOK)) {
            val cases = values.getValue(key).jsonObject
            for (valid in cases.getValue("valid").jsonArray) assertNull("$key $valid", SidebarLayout.problem(key, valid))
            for (invalid in cases.getValue("invalid").jsonArray) assertTrue("$key $invalid", SidebarLayout.problem(key, invalid) != null)
        }
        // Unknown ids are skipped; missing sections follow in the default order.
        val stored = Settings(
            JsonObject(
                mapOf(
                    SettingKeys.SECTION_ORDER to SidebarLayout.toJson(listOf("tags", "later", "calendar")),
                    SettingKeys.HIDDEN_SECTIONS to SidebarLayout.toJson(listOf("recent")),
                    SettingKeys.RECENT_COUNT to JsonPrimitive(3),
                    SettingKeys.QUICK_ACCESS_NOTEBOOK to JsonPrimitive(true),
                ),
            ),
        )
        assertEquals(listOf("tags", "calendar", "quickAccess", "recent", "notebooks"), stored.sectionOrder)
        assertEquals(setOf("recent"), stored.hiddenSections)
        assertEquals(3, stored.recentCount)
        assertTrue(stored.quickAccessShowsNotebook)
        assertEquals(listOf("tags", "quickAccess", "recent", "notebooks", "calendar"), SidebarLayout.moved(SidebarLayout.SECTIONS, "tags", 0))
        assertEquals(listOf("recent", "tags"), SidebarLayout.withHidden(setOf("tags"), "recent", true))
        assertEquals(
            listOf("Hide Calendar", "Hide Notebooks", "Hide Quick Access", "Show Recent Notes", "Hide Tags"),
            SidebarLayout.toggles(setOf("recent")).map { it.second },
        )
        assertEquals(listOf("c", "a", "b"), QuickAccess.moved(listOf("a", "b", "c"), "c", 0))
    }

    /**
     * Interface Font, Note Font and Note Font Size (T51, A944): the phone checks and reads them by
     * core `fonts.ts`'s rules, which the server's vitest checks against the same examples.
     */
    @Test
    fun readsAndChecksTheFontsAsTheWebDoes() {
        val values = settings.getValue("values").jsonObject
        for (key in listOf(SettingKeys.INTERFACE_FONT, SettingKeys.NOTE_FONT, SettingKeys.NOTE_FONT_SIZE)) {
            for (valid in values.getValue(key).jsonObject.getValue("valid").jsonArray) {
                assertNull("$key $valid", FontSettings.problem(key, valid))
                if (valid is JsonNull) continue
                val read = Settings(JsonObject(mapOf(key to valid)))
                val shown = when (key) {
                    SettingKeys.INTERFACE_FONT -> JsonPrimitive(read.interfaceFont)
                    SettingKeys.NOTE_FONT -> JsonPrimitive(read.noteFont)
                    else -> JsonPrimitive(read.noteFontSize)
                }
                assertEquals("$key", valid, shown)
            }
            for (invalid in values.getValue(key).jsonObject.getValue("invalid").jsonArray) {
                assertTrue("$key $invalid", FontSettings.problem(key, invalid) != null)
                // An unreadable value shows the default, as on the web.
                val read = Settings(JsonObject(mapOf(key to invalid)))
                assertEquals(FontSettings.THEME, read.interfaceFont)
                assertEquals(FontSettings.THEME, read.noteFont)
                assertEquals(FontSettings.SIZE_DEFAULT, read.noteFontSize)
            }
        }
        // Each valid preset is one Settings offers, with core's names.
        val presets = values.getValue(SettingKeys.INTERFACE_FONT).jsonObject.getValue("valid").jsonArray
            .filter { it !is JsonNull }.map { it.jsonPrimitive.content }.filterNot { it.startsWith(FontSettings.CUSTOM_PREFIX) }
        assertEquals(presets, FontSettings.PRESETS.map { it.first })
        assertEquals("Theme Default", FontSettings.label("theme"))
        assertEquals("Monospace", FontSettings.label("mono"))
        assertEquals("Avenir Next", FontSettings.label("custom:Avenir Next"))
        assertEquals("Note Font Size", SettingLabels.of(SettingKeys.NOTE_FONT_SIZE))
        assertEquals("Show Notebook Names in Quick Access", SettingLabels.of(SettingKeys.QUICK_ACCESS_NOTEBOOK))
    }

    /** Quick Access (T51, A946): the pinned notes, by core `quick-access.ts`'s rules. */
    @Test
    fun readsAndChecksQuickAccessAsTheWebDoes() {
        val values = settings.getValue("values").jsonObject.getValue(SettingKeys.QUICK_ACCESS).jsonObject
        for (valid in values.getValue("valid").jsonArray) {
            assertNull("$valid", QuickAccess.problem(valid))
            if (valid is JsonNull) continue
            val read = Settings(JsonObject(mapOf(SettingKeys.QUICK_ACCESS to valid))).quickAccess
            assertEquals(valid, QuickAccess.toJson(read))
        }
        for (invalid in values.getValue("invalid").jsonArray) {
            assertTrue("$invalid", QuickAccess.problem(invalid) != null)
            assertEquals(emptyList<String>(), Settings(JsonObject(mapOf(SettingKeys.QUICK_ACCESS to invalid))).quickAccess)
        }
        // Pinning adds at the end, unpinning removes, and a full list takes no more.
        assertEquals(listOf("a", "b"), QuickAccess.toggled(listOf("a"), "b"))
        assertEquals(listOf("b"), QuickAccess.toggled(listOf("a", "b"), "a"))
        val full = (0 until QuickAccess.MAX).map { "n$it" }
        assertNull(QuickAccess.toggled(full, "x"))
        assertEquals(full - "n3", QuickAccess.toggled(full, "n3"))
    }

    @Test
    fun offersOnlyTheValuesTheServerTakes() {
        val values = settings.getValue("values").jsonObject
        fun valid(key: String) = values.getValue(key).jsonObject.getValue("valid").jsonArray.filter { it !is JsonNull }.map { it.jsonPrimitive.content }
        assertEquals(valid(SettingKeys.MODE).toSet(), SettingChoices.MODES.toSet())
        assertEquals(valid(SettingKeys.CAPTURE).toSet(), SettingChoices.DESTINATIONS.toSet())
        // Every built-in may be chosen.
        val builtIns = ThemeCatalogue.bundled.builtIns.map { it.getValue("id").jsonPrimitive.content }
        assertTrue(valid(SettingKeys.THEME).containsAll(builtIns))
        // The phone stops a template at the server's limit, from the same contract (A410).
        assertEquals(SettingLimits.TEMPLATE_MAX_CHARS, settings.getValue("templateMaxChars").jsonPrimitive.int)
        // The phone sends no more settings at once than the server takes, nor offers a theme past its limit.
        assertEquals(SettingLimits.PER_REQUEST, settings.getValue("settingsPerRequest").jsonPrimitive.int)
        assertEquals(SettingLimits.CUSTOM_THEMES_MAX, settings.getValue("customThemesMax").jsonPrimitive.int)
    }

    @Test
    fun readsWhatTheTreeSendsAsTheWebDoes() {
        val sent = Settings(settings.getValue("sync").jsonObject.getValue("sent").jsonObject)
        assertEquals("custom-ink", sent.themeId)
        assertEquals("dark", sent.mode)
        assertEquals("Asia/Tokyo", sent.timeZone)
        assertEquals("## Today\n\n{{longDate}}\n", sent.template(SettingKeys.DAILY_TEMPLATE))
        assertNull(sent.template(SettingKeys.WEEKLY_TEMPLATE))
        assertEquals("inbox", sent.captureDestination)
        assertFalse(sent.fullWidth)
        assertEquals(listOf("custom-ink"), sent.customThemes.map { it.getValue("id").jsonPrimitive.content })
        assertEquals("nord", sent.deletedBase("custom-old"))
    }

    @Test
    fun resolvesEachCasesThemeAndModeAsTheWebDoes() {
        for (case in settings.getValue("resolve").jsonArray.map { it.jsonObject }) {
            val name = case.getValue("name").jsonPrimitive.content
            val resolved = ThemeCatalogue.bundled.resolve(Settings(case.getValue("sent").jsonObject))
            assertEquals(name, case.getValue("theme").jsonPrimitive.content, resolved.id)
            assertEquals(name, case.getValue("mode").jsonPrimitive.content, resolved.mode)
        }
    }

    @Test
    fun laysAChangeOverWhatWasSent() {
        val sent = Settings(JsonObject(mapOf(SettingKeys.MODE to JsonPrimitive("dark"))))
        assertEquals("light", sent.with(SettingKeys.MODE, JsonPrimitive("light")).mode)
        assertEquals(SettingDefaults.MODE, sent.with(SettingKeys.MODE, null).mode)
        assertEquals(SettingDefaults.MODE, sent.with(SettingKeys.MODE, JsonNull).mode)
    }

    @Test
    fun sendsAChangeAndReadsARefusalInTheContractsShape() = runTest {
        MockWebServer().use { server ->
            server.start()
            val api = HttpPenmossApi(server.url("/").toString(), OkHttpClient())
            val request = settings.getValue("request").jsonObject
            server.enqueue(json("""{"settings":{"theme.mode":"dark"},"changed":true}"""))
            val reply = api.putSettings(SettingsChange(request.getValue("set").jsonObject, request.getValue("base").jsonObject))
            assertEquals(JsonObject(mapOf(SettingKeys.MODE to JsonPrimitive("dark"))), reply.settings)
            val sent = server.takeRequest()
            assertEquals("PUT", sent.method)
            assertEquals("/api/settings", sent.url.encodedPath)
            assertEquals(request, Json.parseToJsonElement(sent.body!!.utf8()))

            val conflict = settings.getValue("conflict").jsonObject
            server.enqueue(json(conflict.getValue("body").toString(), conflict.getValue("status").jsonPrimitive.int))
            val refused = runCatching { api.putSettings(SettingsChange(JsonObject(emptyMap()), JsonObject(emptyMap()))) }
                .exceptionOrNull() as ApiException
            assertEquals(409, refused.status)
            assertEquals("setting_changed", refused.code)
            assertEquals(listOf(SettingKeys.MODE), refused.keys)
        }
    }

    @Test
    fun bundlesTheBuiltInThemesWithEveryTokenInBothVariants() {
        val themes = contract("themes-v1.json")
        val catalogue = ThemeCatalogue.bundled
        // The resource is the contract file itself.
        assertEquals(themes.getValue("themes").jsonArray.map { it.jsonObject }, catalogue.builtIns)
        assertEquals(
            listOf("penmoss", "paper", "slate", "nord", "solarized", "gruvbox", "rose-pine", "high-contrast"),
            catalogue.builtIns.map { it.getValue("id").jsonPrimitive.content },
        )
        val keys = catalogue.tokens.map { it.key }.toSet()
        assertTrue("bg" in keys && "fg" in keys && "accent" in keys)
        for (theme in catalogue.builtIns) {
            for (variant in listOf("light", "dark")) {
                val colours = theme.getValue(variant).jsonObject
                assertEquals(keys, colours.keys)
                assertTrue(colours.values.all { Regex("^#[0-9a-f]{6}$").matches(it.jsonPrimitive.content) })
            }
        }
    }

    /**
     * Settings → Display (T42, A576; T40 ST12, A650): the contract's `display` block, which the
     * server's vitest checks with the web's rules. Only `false` hides a shortcut; true, null and
     * anything else show it, as core's `sidebarShows`.
     */
    @Test
    fun readsTheDisplaySettingsAsTheWebDoes() {
        val display = settings.getValue("display").jsonObject
        assertEquals(display.getValue("keys").jsonArray.map { it.jsonPrimitive.content }, DisplayKeys.ALL)
        assertEquals(display.getValue("defaults").jsonObject, JsonObject(DisplayKeys.ALL.associateWith { JsonPrimitive(true) }))
        // Search and New note are not shortcuts that hide.
        for (refused in display.getValue("refused").jsonArray.map { it.jsonPrimitive.content }) assertFalse(refused in DisplayKeys.ALL)
        val none = Settings()
        assertTrue(DisplayKeys.ALL.all(none::shows))
        val sent = Settings(display.getValue("sync").jsonObject.getValue("sent").jsonObject)
        assertFalse(sent.shows(DisplayKeys.GRAPH))
        assertTrue(sent.shows(DisplayKeys.COMMANDS))
        assertTrue(sent.shows(DisplayKeys.TODAY))
        // A value the server would not store (a string) shows the shortcut, as the web reads it.
        assertTrue(Settings(JsonObject(mapOf(DisplayKeys.TODAY to JsonPrimitive("false")))).shows(DisplayKeys.TODAY))
        assertTrue(Settings(JsonObject(mapOf(DisplayKeys.TODAY to JsonNull))).shows(DisplayKeys.TODAY))
        // Every valid value is one the phone may send: it sends false to hide and true to show again.
        val valid = display.getValue("values").jsonObject.getValue("valid").jsonArray
        assertTrue(JsonPrimitive(false) in valid && JsonPrimitive(true) in valid)
        assertEquals("Today", SettingLabels.of(DisplayKeys.TODAY))
        assertEquals("Commands", SettingLabels.of(DisplayKeys.COMMANDS))
    }

    /**
     * Settings → Symbols (T44, A743, A747): the phone reads and offers `symbols.list` by the web's
     * rules (core `line-symbols.ts`), which the server's vitest checks against the same examples.
     */
    @Test
    fun readsAndChecksTheSymbolsAsTheWebDoes() {
        assertEquals(LineSymbols.MAX, settings.getValue("symbolsMax").jsonPrimitive.int)
        assertEquals(settings.getValue("symbolColours").jsonArray.map { it.jsonPrimitive.content }, LineSymbols.COLOURS.map { it.first })
        assertEquals(LineSymbols.DEFAULTS, Settings().symbols)
        assertFalse(Settings().customSymbols)
        val values = settings.getValue("values").jsonObject.getValue(SettingKeys.SYMBOLS).jsonObject
        for (valid in values.getValue("valid").jsonArray) {
            if (valid is JsonNull) continue
            val read = LineSymbols.read(valid)
            assertTrue("$valid", read != null)
            // What the phone would send back is the same list.
            assertEquals(valid, LineSymbols.toJson(read!!))
        }
        for (invalid in values.getValue("invalid").jsonArray) {
            assertNull("$invalid", LineSymbols.read(invalid))
            // An unreadable list shows the defaults, as on the web.
            assertEquals(LineSymbols.DEFAULTS, Settings(JsonObject(mapOf(SettingKeys.SYMBOLS to invalid))).symbols)
        }
        // What the tree sends, read with names trimmed and fields from a newer build left out.
        val sync = settings.getValue("sync").jsonObject
        val stored = Settings(sync.getValue("stored").jsonObject).symbols
        val sent = Settings(sync.getValue("sent").jsonObject).symbols
        assertEquals(listOf(LineSymbol("✓", "Done", "success"), LineSymbol("★", "Important", "calloutWarning")), sent)
        assertEquals(sent, stored)
        assertTrue(Settings(sync.getValue("sent").jsonObject).customSymbols)
        // Glyphs as the web compares them, and its messages.
        assertEquals(LineSymbols.glyphKey("💡"), LineSymbols.glyphKey("💡\uFE0F"))
        assertEquals("Glyph cannot hold # - + * > = | ` ~ [ ] \\ < _ $", LineSymbols.glyphProblem("#"))
        assertEquals("Glyph cannot hold letters or digits", LineSymbols.glyphProblem("A1"))
        assertEquals("Glyph cannot hold a space", LineSymbols.glyphProblem("★\u00a0"))
        assertNull(LineSymbols.glyphProblem("👨‍👩‍👧‍👦"))
        // Nothing that shows nothing or turns text around (T44 review), as the web refuses.
        assertEquals("Glyph cannot hold invisible or direction characters", LineSymbols.glyphProblem("\u200b★"))
        assertEquals("Glyph cannot hold invisible or direction characters", LineSymbols.glyphProblem("\u202e!"))
        assertEquals("Glyph cannot start with a combining mark", LineSymbols.glyphProblem("\u0301"))
        assertEquals("✓", LineSymbols.nextGlyph(LineSymbols.DEFAULTS))
        // Any colour as #rrggbb(aa), lower case (T51, A939), named by its hex in capitals.
        assertTrue(LineSymbols.isHexColour("#2e7d32") && LineSymbols.isHexColour("#ff000080"))
        assertFalse(LineSymbols.isHexColour("#2E7D32") || LineSymbols.isHexColour("#2e7d3"))
        assertEquals("#FF000080", LineSymbols.colourLabel("#ff000080"))
        assertEquals("Orange", LineSymbols.colourLabel("calloutWarning"))
        // The picker's presets are core's, in its order (the editor page's vitest checks the contract against core).
        assertEquals(settings.getValue("symbolGlyphPresets").jsonArray.map { it.jsonPrimitive.content }, LineSymbols.PRESET_GLYPHS)
        // Every glyph the picker offers is one the rules take, once each.
        for (glyph in LineSymbols.PRESET_GLYPHS) assertNull(glyph, LineSymbols.glyphProblem(glyph))
        assertEquals(LineSymbols.PRESET_GLYPHS.size, LineSymbols.PRESET_GLYPHS.map(LineSymbols::glyphKey).toSet().size)
        assertEquals("Symbols", SettingLabels.of(SettingKeys.SYMBOLS))
    }

    private fun json(body: String, code: Int = 200) =
        MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").body(body).build()
}
