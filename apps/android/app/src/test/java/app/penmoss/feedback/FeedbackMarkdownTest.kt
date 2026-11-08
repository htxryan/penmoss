package app.penmoss.feedback

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The captured context's markdown matches core's byte for byte (T49, A791, A794):
 * `apps/android/contract/feedback-v1.json` holds contexts with the markdown core's
 * `contextMarkdown` writes for each, and issue bodies, so what the phone's form previews is what
 * the issue holds. Core writes the file (`apps/web/test/unit/feedback-contract.test.ts`).
 */
class FeedbackMarkdownTest {
    private val contract: JsonObject = run {
        val file = System.getProperty("penmoss.contract")?.let { File(it).resolveSibling("feedback-v1.json") }
            ?: File("../contract/feedback-v1.json")
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun contextOf(value: JsonObject) = FeedbackContextData(
        value.getValue("groups").jsonArray.map { raw ->
            val group = raw.jsonObject
            FeedbackGroup(
                group.getValue("id").jsonPrimitive.content,
                group.getValue("columns").jsonArray.map { it.jsonPrimitive.content },
                group.getValue("rows").jsonArray.map { row -> row.jsonArray.map { it.jsonPrimitive.content } },
            )
        },
    )

    @Test
    fun everyContextRendersExactlyAsCoreRendersIt() {
        val contexts = contract.getValue("contexts").jsonArray.map { it.jsonObject }
        assertTrue(contexts.size >= 3)
        for (case in contexts) {
            val name = case.getValue("name").jsonPrimitive.content
            val expected = case.getValue("markdown").jsonPrimitive.content
            assertEquals(name, expected, FeedbackMarkdown.context(contextOf(case.getValue("context").jsonObject)))
        }
    }

    @Test
    fun everyIssueBodyMatchesIncludingItsContextPart() {
        for (case in contract.getValue("bodies").jsonArray.map { it.jsonObject }) {
            val input = case.getValue("input").jsonObject
            val context = contextOf(input.getValue("context").jsonObject)
            val body = FeedbackMarkdown.issueBody(
                description = input.getValue("description").jsonPrimitive.content,
                screenshots = input.getValue("screenshots").jsonArray.map { it.jsonObject }.map {
                    it.getValue("name").jsonPrimitive.content to it.getValue("url").jsonPrimitive.content
                },
                context = context,
                client = input.getValue("client").jsonPrimitive.content,
                version = input.getValue("version").jsonPrimitive.content,
                submissionId = input.getValue("submissionId").jsonPrimitive.content,
            )
            val expected = case.getValue("body").jsonPrimitive.content
            assertEquals(case.getValue("name").jsonPrimitive.content, expected, body)
            // The context part, which the form previews, is in the body as it renders it.
            val markdown = FeedbackMarkdown.context(context)
            if (markdown.isNotEmpty()) assertTrue(expected.contains(markdown))
        }
    }

    @Test
    fun everyFieldGroupIsCutAsCoreCutsIt() {
        val cases = contract.getValue("fieldGroups").jsonArray.map { it.jsonObject }
        assertTrue(cases.size >= 2)
        for (case in cases) {
            val fields = case.getValue("fields").jsonArray.map { raw ->
                val (name, value) = raw.jsonArray
                val primitive = value as JsonPrimitive
                val typed: Any? = when {
                    primitive.isString -> primitive.content
                    primitive.booleanOrNull != null -> primitive.booleanOrNull
                    primitive.longOrNull != null -> primitive.longOrNull
                    else -> null
                }
                name.jsonPrimitive.content to typed
            }
            val expected = case.getValue("rows").jsonArray.map { row -> row.jsonArray.map { it.jsonPrimitive.content } }
            assertEquals(case.getValue("name").jsonPrimitive.content, expected, fieldGroup(FeedbackGroupId.NOTE, fields).rows)
        }
    }

    @Test
    fun aCellsMentionsAndReferencesAreInertAndTheFooterVersionCannotFormat() {
        val zwj = "\u200d"
        assertEquals(
            "@${zwj}ryan @${zwj}é @ a#${zwj}1 #x GH$zwj-12 xGH-3 _GH-4 é GH$zwj-5 @${zwj}_ éGH$zwj-6 @😀 @${zwj}𝟘",
            FeedbackMarkdown.inertReferences("@ryan @é @ a#1 #x GH-12 xGH-3 _GH-4 é GH-5 @_ éGH-6 @😀 @𝟘"),
        )
        // In a table cell, not in the JSON copy agents read.
        val context = FeedbackContextData(listOf(fieldGroup(FeedbackGroupId.NOTE, listOf("Tags" to "#100, @ryan"))))
        val markdown = FeedbackMarkdown.context(context)
        assertTrue(markdown.contains("| Tags | #${zwj}100, @${zwj}ryan |"))
        assertTrue(markdown.contains("\"Tags\": \"#100, @ryan\""))
        assertEquals("0.31(build 431425)", FeedbackMarkdown.footerVersion("  0.31\t(build 431425)\n"))
        assertEquals("unknown", FeedbackMarkdown.footerVersion("@#!"))
        assertEquals("a".repeat(79), FeedbackMarkdown.footerVersion("a".repeat(79) + " b"))
    }

    @Test
    fun theLabelsTypesPrioritiesAndLimitsAreCores() {
        for (case in contract.getValue("labels").jsonArray.map { it.jsonObject }) {
            val type = FeedbackType.of(case.getValue("type").jsonPrimitive.content)!!
            val priority = case.getValue("priority").jsonPrimitive.int
            assertEquals(case.getValue("labels").jsonArray.map { it.jsonPrimitive.content }, feedbackLabels(type, priority))
        }
        val types = contract.getValue("types").jsonObject
        for (type in FeedbackType.entries) assertEquals(types.getValue(type.wire).jsonPrimitive.content, type.label)
        val priorities = contract.getValue("priorities").jsonObject
        assertEquals(FeedbackPriority.all.map(Int::toString), priorities.keys.toList())
        for (priority in FeedbackPriority.all) assertEquals(priorities.getValue("$priority").jsonPrimitive.content, FeedbackPriority.label(priority))
        val limits = contract.getValue("limits").jsonObject
        assertEquals(limits.getValue("titleMax").jsonPrimitive.int, FeedbackLimits.TITLE_MAX)
        assertEquals(limits.getValue("descriptionMax").jsonPrimitive.int, FeedbackLimits.DESCRIPTION_MAX)
        assertEquals(limits.getValue("versionMax").jsonPrimitive.int, FeedbackLimits.VERSION_MAX)
        assertEquals(limits.getValue("screenshots").jsonPrimitive.int, FeedbackLimits.SCREENSHOTS)
        assertEquals(limits.getValue("screenshotBytes").jsonPrimitive.long, FeedbackLimits.SCREENSHOT_BYTES)
        assertEquals(limits.getValue("requestBytes").jsonPrimitive.long, FeedbackLimits.REQUEST_BYTES)
        assertEquals(limits.getValue("longSide").jsonPrimitive.int, FeedbackLimits.LONG_SIDE)
        assertEquals(limits.getValue("jpegQuality").jsonPrimitive.content.toDouble(), FeedbackLimits.JPEG_QUALITY / 100.0, 0.0)
        assertEquals(limits.getValue("groupRows").jsonPrimitive.int, FeedbackLimits.GROUP_ROWS)
        assertEquals(limits.getValue("cell").jsonPrimitive.int, FeedbackLimits.CELL)
        assertEquals(limits.getValue("recent").jsonPrimitive.int, FeedbackLimits.RECENT)
    }

    @Test
    fun jsonIsJavaScriptsStringify() {
        // Integer keys first, as JavaScript orders an object's keys; controls and lone surrogates escaped.
        val obj = Js.Obj().apply {
            this["b"] = "x"
            this["10"] = "ten"
            this["2"] = "two"
            this["01"] = "zero-one"
            this["c"] = "\u0001\b\u000C\uD800 😀  "
        }
        assertEquals(
            "{\n  \"2\": \"two\",\n  \"10\": \"ten\",\n  \"b\": \"x\",\n  \"01\": \"zero-one\",\n  \"c\": \"\\u0001\\b\\f\\ud800 😀  \"\n}",
            Js.stringify(obj),
        )
        // JavaScript's whitespace, not Kotlin's: a no-break space and U+FEFF are trimmed.
        assertEquals("a b", FeedbackMarkdown.cell(" a  b﻿"))
    }

    @Test
    fun aCellIsClippedWithAnEllipsisNeverHalfASurrogatePair() {
        assertEquals("abc", clipCell("abc", 3))
        assertEquals("ab…", clipCell("abcd", 3))
        assertEquals("a…", clipCell("a😀b", 3))
        val rows = fieldGroup(FeedbackGroupId.NOTE, List(50) { "F$it" to "v" }).rows
        assertEquals(FeedbackLimits.GROUP_ROWS, rows.size)
        assertEquals(listOf(listOf("Online", "yes")), fieldGroup(FeedbackGroupId.SYNC, listOf("Online" to true, "Gone" to null)).rows)
    }
}
