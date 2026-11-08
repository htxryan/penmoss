package app.penmoss.engine.settings

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.math.abs

/**
 * The theme editor's contrast warnings (T40 P1b, A419) give the web's answers:
 * `contract/theme-contrast-v1.json`, written from `@penmoss/ui` by the editor page's vitest,
 * holds every check's label, kind and minimum, and for every built-in variant and a few failing
 * ones each pair's colours and ratio, plus the colour functions' results.
 */
class ContrastContractTest {
    private val contract: JsonObject = run {
        val file = System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("theme-contrast-v1.json") }
            ?: File("../contract/theme-contrast-v1.json")
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun near(expected: Double, actual: Double, what: String) =
        assertTrue("$what: $actual, the web says $expected", abs(expected - actual) <= 1e-9 * expected)

    @Test
    fun theColourFunctionsGiveTheWebsColours() {
        for (each in contract.getValue("functions").jsonArray.map { it.jsonObject }) {
            val a = each.string("a")!!
            val b = each.string("b")!!
            near(each.getValue("contrast").jsonPrimitive.double, Colour.contrast(a, b), "contrast($a, $b)")
            for (mix in each.getValue("mix").jsonArray.map { it.jsonObject }) {
                val weight = mix.getValue("weight").jsonPrimitive.double
                assertEquals("mix($a, $b, $weight)", mix.string("colour"), Colour.mix(a, b, weight))
            }
            for (over in each.getValue("over").jsonArray.map { it.jsonObject }) {
                val alpha = over.getValue("alpha").jsonPrimitive.double
                assertEquals("over($a, $alpha, $b)", over.string("colour"), Colour.over(a, alpha, b))
            }
        }
    }

    @Test
    fun everyCheckIsTheWebsPairForPair() {
        val checks = contract.getValue("checks").jsonArray.map { it.jsonObject }
        for (case in contract.getValue("cases").jsonArray.map { it.jsonObject }) {
            val name = case.string("name")!!
            val colours = case.getValue("colours").jsonObject.mapValues { it.value.jsonPrimitive.content }
            val mine = Contrast.checks(colours)
            assertEquals(name, checks.map { it.string("label") }, mine.map { it.label })
            assertEquals(name, checks.map { it.string("kind") }, mine.map { it.kind })
            assertEquals(name, checks.map { it.getValue("min").jsonPrimitive.double }, mine.map { it.min })
            case.getValue("pairs").jsonArray.forEachIndexed { index, pair ->
                val (fg, bg, ratio) = pair.jsonArray
                val check = mine[index]
                assertEquals("$name: ${check.label}", fg.jsonPrimitive.content to bg.jsonPrimitive.content, check.fg to check.bg)
                near(ratio.jsonPrimitive.double, check.ratio, "$name: ${check.label}")
            }
            val failing = case.getValue("failing").jsonArray.map { it.jsonPrimitive.content }
            assertEquals(name, failing, Contrast.problems(colours).map { it.label })
        }
    }

    @Test
    fun aFailingPairNamesTheTokensItIsMadeFrom() {
        val pale = contract.getValue("cases").jsonArray.map { it.jsonObject }.first { it.string("name") == "Nord light with pale text and a yellow accent" }
        val colours = pale.getValue("colours").jsonObject.mapValues { it.value.jsonPrimitive.content }
        val problems = Contrast.problems(colours)
        val text = problems.first { it.label == "Text on the page" }
        assertEquals(setOf("fg", "bg"), text.tokens)
        // Every token a check names is a colour of the theme.
        for (check in Contrast.checks(colours)) assertTrue(check.label, colours.keys.containsAll(check.tokens))
    }

    /**
     * A pair names every token whose change changes it, those its derived colours are made from
     * too: the focus ring and code are mixed with the text colour, hovered rows laid over with it.
     */
    @Test
    fun everyPairNamesEveryTokenThatChangesIt() {
        for (case in contract.getValue("cases").jsonArray.map { it.jsonObject }) {
            val colours = case.getValue("colours").jsonObject.mapValues { it.value.jsonPrimitive.content }
            val before = Contrast.checks(colours)
            for (token in colours.keys) {
                val other = if (colours.getValue(token) == "#7f3fbf") "#3fbf7f" else "#7f3fbf"
                val after = Contrast.checks(colours + (token to other))
                before.zip(after).forEach { (was, now) ->
                    if (was.fg != now.fg || was.bg != now.bg) assertTrue("${case.string("name")}: ${was.label} is made from $token", token in was.tokens)
                }
            }
        }
        val nord = contract.getValue("cases").jsonArray.map { it.jsonObject }.first().getValue("colours").jsonObject.mapValues { it.value.jsonPrimitive.content }
        val checks = Contrast.checks(nord).associateBy { it.label }
        assertEquals(setOf("accent", "fg", "bg"), checks.getValue("Focus ring on the page").tokens)
        assertEquals(setOf("codeKeyword", "bg", "fg"), checks.getValue("Code: Keywords").tokens)
        assertEquals(setOf("muted", "fg", "sidebar"), checks.getValue("Secondary text on a hovered sidebar row").tokens)
    }
}
