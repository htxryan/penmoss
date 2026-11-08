package app.penmoss.feedback

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.auth.SecretBox
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.FeedbackAnswer
import app.penmoss.engine.api.FeedbackImage
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Send feedback filed from the phone with the person's own GitHub token (T57, A1010–A1012),
 * against a fake GitHub as strict as the Worker's (apps/server/test/support/fake-github-feedback.ts):
 * attachments with their own type and length, the issue's body, labels and footer, no token in
 * what is posted, a retry that never files twice, plain refusals and the outbox waiting for a token.
 */
@RunWith(AndroidJUnit4::class)
class GitHubFeedbackTest {
    private val server = MockWebServer()
    private val github = FakeGitHub()
    private val dir: File = Files.createTempDirectory("github-feedback").toFile()
    private var clock = 1_762_000_000_000L
    private var token: String? = TOKEN
    private val ledger = MemoryFeedbackLedger()
    private lateinit var api: GitHubFeedbackApi

    @Before
    fun start() {
        server.dispatcher = github
        server.start()
        val base = server.url("/").toString().trimEnd('/')
        api = GitHubFeedbackApi(OkHttpClient(), GitHubFeedbackConfig(api = base, uploads = base), { token }, ledger, now = { clock })
    }

    @After
    fun stop() {
        server.close()
        dir.deleteRecursively()
    }

    /** A fake of what feedback calls on GitHub; tests fail the next calls to a path. */
    private class FakeGitHub : Dispatcher() {
        data class Upload(val name: String, val repositoryId: String?, val contentType: String?, val contentLength: Long?, val bytes: ByteArray)

        data class Issue(val number: Long, val title: String, val body: String, val labels: List<String>)

        data class Failure(val method: String, val path: String, val status: Int, val body: String, val headers: Map<String, String> = emptyMap(), val after: Boolean = false, var times: Int = 1)

        val uploads = CopyOnWriteArrayList<Upload>()
        val issues = CopyOnWriteArrayList<Issue>()
        val calls = CopyOnWriteArrayList<RecordedRequest>()
        val failures = CopyOnWriteArrayList<Failure>()
        var login = "htxryan"
        var permissions = """{"push":true,"triage":true}"""
        var isPrivate = true

        private fun json(code: Int, body: String, headers: Map<String, String> = emptyMap()) =
            MockResponse.Builder().code(code).addHeader("Content-Type", "application/json").apply { headers.forEach { (k, v) -> addHeader(k, v) } }.body(body).build()

        override fun dispatch(request: RecordedRequest): MockResponse {
            calls += request
            val path = request.url.encodedPath
            if (request.headers["Authorization"]?.startsWith("Bearer ") != true || request.headers["User-Agent"].isNullOrEmpty()) {
                return json(401, """{"message":"Requires authentication"}""")
            }
            val failure = failures.firstOrNull { it.method == request.method && it.path == path && it.times > 0 }
            if (failure != null) {
                failure.times--
                if (!failure.after) return json(failure.status, failure.body, failure.headers)
            }
            val answer = answer(request, path)
            return if (failure != null) json(failure.status, failure.body, failure.headers) else answer
        }

        private fun answer(request: RecordedRequest, path: String): MockResponse = when {
            path == "/user" && request.method == "GET" -> json(200, """{"login":"$login"}""")
            path == "/repos/htxryan/penmoss" && request.method == "GET" -> json(200, """{"full_name":"htxryan/penmoss","private":$isPrivate,"permissions":$permissions}""")
            path == "/user-attachments/assets" && request.method == "POST" -> {
                val type = request.headers["Content-Type"]
                val name = request.url.queryParameter("name")!!
                val bytes = request.body!!.toByteArray()
                val length = request.headers["Content-Length"]?.toLong()
                val matches = mapOf("png" to "image/png", "jpg" to "image/jpeg")[name.substringAfterLast('.')] == type?.substringBefore(';')
                when {
                    request.url.queryParameter("repository_id") != "1450019106" -> json(404, """{"message":"Not Found"}""")
                    !matches -> json(422, """{"message":"Bad Content-Type"}""")
                    length != bytes.size.toLong() -> json(400, """{"message":"Bad length"}""")
                    else -> {
                        uploads += Upload(name, request.url.queryParameter("repository_id"), type, length, bytes)
                        json(201, """{"url":"https://github.com/user-attachments/assets/${"%08d".format(uploads.size)}-0000-0000-0000-000000000000"}""")
                    }
                }
            }
            path == "/repos/htxryan/penmoss/issues" && request.method == "POST" -> {
                val body = Json.parseToJsonElement(request.body!!.utf8()) as JsonObject
                val number = 100L + issues.size
                issues += Issue(
                    number,
                    body["title"]!!.jsonPrimitive.content,
                    body["body"]!!.jsonPrimitive.content,
                    // GitHub drops, without an error, the labels of an account that cannot triage.
                    if (permissions.contains("\"triage\":true") || permissions.contains("\"push\":true")) {
                        (body["labels"] as JsonArray).map { it.jsonPrimitive.content }
                    } else {
                        emptyList()
                    },
                )
                json(201, """{"number":$number,"html_url":"https://github.com/htxryan/penmoss/issues/$number"}""")
            }
            path == "/repos/htxryan/penmoss/issues" && request.method == "GET" -> {
                val label = request.url.queryParameter("labels")
                val listed = issues.reversed().filter { label == null || it.labels.contains(label) }
                val page = request.url.queryParameter("page")!!.toInt()
                val shown = listed.drop((page - 1) * 100).take(100)
                json(200, shown.joinToString(",", "[", "]") { issue -> """{"number":${issue.number},"html_url":"https://github.com/htxryan/penmoss/issues/${issue.number}","body":${Json.encodeToString(kotlinx.serialization.json.JsonPrimitive(issue.body))}}""" })
            }
            else -> json(404, """{"message":"Not Found"}""")
        }
    }

    private fun payload(
        id: String = SUBMISSION,
        title: String = "Sync stops after ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        description: String = "It said **Offline**. My token pmd_secret123456 and github_pat_11ABCDEFGHIJKLMNOPQRSTUV_xyz were in the log.",
    ) = """{"submissionId":"$id","type":"bug","priority":2,"title":${Json.encodeToString(kotlinx.serialization.json.JsonPrimitive(title))},"description":${Json.encodeToString(kotlinx.serialization.json.JsonPrimitive(description))},"version":"0.31 (build 431425)","context":{"groups":[{"id":"app","columns":["Field","Value"],"rows":[["Version","0.31 (build 431425)"],["Header","Bearer abc.def-123"],["Note","ghs_abcdefghijklmnopqrstuvwxyz"]]}]}}"""

    private fun png(name: String = "a.png"): FeedbackImage {
        val file = File(dir, name).apply { writeBytes(byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82)) }
        return FeedbackImage(file, "image/png", "screenshot-1.png")
    }

    private fun jpg(name: String = "b.jpg"): FeedbackImage {
        val file = File(dir, name).apply { writeBytes(byteArrayOf(-1, -40, -1, -32, 0, 16, 74, 70, 73, 70, 0, 1)) }
        return FeedbackImage(file, "image/jpeg", "screenshot-2.jpg")
    }

    @Test
    fun filesTheIssueWithItsScreenshotsLabelsAndFooterAndNoToken() = runBlocking {
        val answer = api.sendFeedback(payload(), listOf(png(), jpg()))
        assertEquals(FeedbackAnswer.Filed(100, "https://github.com/htxryan/penmoss/issues/100", duplicate = false), answer)

        // A1011: each screenshot from the phone, its own type and length, named in order.
        assertEquals(listOf("screenshot-1.png" to "image/png", "screenshot-2.jpg" to "image/jpeg"), github.uploads.map { it.name to it.contentType })
        assertEquals(listOf(16L, 12L), github.uploads.map { it.contentLength })
        assertEquals(setOf("1450019106"), github.uploads.map { it.repositoryId }.toSet())

        val issue = github.issues.single()
        assertEquals(listOf("in-app feedback", "bug", "P2"), issue.labels)
        assertEquals("Sync stops after [token removed]", issue.title)
        assertTrue(issue.body, issue.body.startsWith("It said **Offline**. My token [token removed] and [token removed] were in the log."))
        assertTrue(issue.body.contains("![screenshot-1.png](https://github.com/user-attachments/assets/00000001-0000-0000-0000-000000000000)"))
        assertTrue(issue.body.contains("![screenshot-2.jpg](https://github.com/user-attachments/assets/00000002-0000-0000-0000-000000000000)"))
        assertTrue(issue.body.contains("Bearer [token removed]"))
        assertTrue(issue.body.trimEnd().endsWith("Sent from Penmoss Android 0.31 (build 431425) · submission $SUBMISSION"))
        // No token of the person's anywhere in what was posted.
        for (text in listOf(issue.title, issue.body)) {
            assertFalse(text.contains("ghp_") || text.contains("github_pat_") || text.contains("pmd_") || text.contains("ghs_"))
        }
        // The body is what the contract-tested markdown makes.
        assertEquals(
            FeedbackMarkdown.issueBody(
                FeedbackRedaction.redactSecrets("It said **Offline**. My token pmd_secret123456 and github_pat_11ABCDEFGHIJKLMNOPQRSTUV_xyz were in the log."),
                listOf(
                    "screenshot-1.png" to "https://github.com/user-attachments/assets/00000001-0000-0000-0000-000000000000",
                    "screenshot-2.jpg" to "https://github.com/user-attachments/assets/00000002-0000-0000-0000-000000000000",
                ),
                FeedbackContextData(listOf(FeedbackGroup("app", FIELD_COLUMNS, listOf(listOf("Version", "0.31 (build 431425)"), listOf("Header", "Bearer [token removed]"), listOf("Note", "[token removed]"))))),
                "android",
                "0.31 (build 431425)",
                SUBMISSION,
            ),
            issue.body,
        )
        // GitHub's headers on every call, the person's token as the bearer.
        for (call in github.calls) {
            assertEquals("Bearer $TOKEN", call.headers["Authorization"])
            assertEquals("application/vnd.github+json", call.headers["Accept"])
            assertEquals("2022-11-28", call.headers["X-GitHub-Api-Version"])
            assertEquals("penmoss-feedback", call.headers["User-Agent"])
        }
        assertEquals(FeedbackLedgerEntry.SENT, ledger.rows[SUBMISSION]!!.status)

        // Sent again (a lost answer on the phone's side): the same issue, nothing called.
        val before = github.calls.size
        assertEquals(FeedbackAnswer.Filed(100, "https://github.com/htxryan/penmoss/issues/100", duplicate = true), api.sendFeedback(payload(), listOf(png(), jpg())))
        assertEquals(before, github.calls.size)
    }

    @Test
    fun aCreateWhoseAnswerWasLostIsFoundByItsFooterNeverFiledTwice() = runBlocking {
        // GitHub files it, then answers 502.
        github.failures += FakeGitHub.Failure("POST", "/repos/htxryan/penmoss/issues", 502, """{"message":"Bad Gateway"}""", after = true)
        val first = api.sendFeedback(payload(), emptyList()) as FeedbackAnswer.Refused
        assertEquals(503, first.status)
        assertEquals("github_failed", first.code)
        assertEquals(60_000L, first.retryAfterMs)
        assertEquals(1, github.issues.size)

        // Within the settle: in progress, nothing called.
        val calls = github.calls.size
        clock += 30_000
        val waiting = api.sendFeedback(payload(), emptyList()) as FeedbackAnswer.Refused
        assertEquals(409 to "in_progress", waiting.status to waiting.code)
        assertEquals(30_000L, waiting.retryAfterMs)
        assertEquals(calls, github.calls.size)
        // The outbox tries it again later, as before (A803).
        assertEquals(FeedbackOutbox.Verdict.RETRY, FeedbackOutbox.verdict(waiting))

        // After it: looked up by its footer and adopted.
        clock += 31_000
        assertEquals(FeedbackAnswer.Filed(100, "https://github.com/htxryan/penmoss/issues/100", duplicate = true), api.sendFeedback(payload(), emptyList()))
        assertEquals(1, github.issues.size)
        val lookup = github.calls.last { it.method == "GET" }
        // Not by label: GitHub drops the labels of an account that cannot triage (T80.3).
        assertEquals(null, lookup.url.queryParameter("labels"))
        assertEquals("all", lookup.url.queryParameter("state"))
        assertEquals("created", lookup.url.queryParameter("sort"))
        assertEquals("desc", lookup.url.queryParameter("direction"))
        assertEquals("100", lookup.url.queryParameter("per_page"))
        assertTrue(lookup.url.queryParameter("since")!!.endsWith("Z"))
    }

    @Test
    fun aRetryOfOneNeverFiledFilesItOnce() = runBlocking {
        github.failures += FakeGitHub.Failure("POST", "/user-attachments/assets", 500, """{"message":"Server Error"}""")
        val first = api.sendFeedback(payload(), listOf(png()))
        assertEquals(503, (first as FeedbackAnswer.Refused).status)
        // No create was tried: no settle.
        assertNull(first.retryAfterMs)
        assertEquals(FeedbackAnswer.Filed(100, "https://github.com/htxryan/penmoss/issues/100", duplicate = false), api.sendFeedback(payload(), listOf(png())))
        assertEquals(1, github.issues.size)
    }

    @Test
    fun aTokenGitHubRefusesIsSaidPlainlyAndAFinalAnswer() = runBlocking {
        github.failures += FakeGitHub.Failure("POST", "/repos/htxryan/penmoss/issues", 403, """{"message":"Resource not accessible by personal access token"}""")
        val refused = api.sendFeedback(payload(), emptyList()) as FeedbackAnswer.Refused
        assertEquals(424 to "token_cannot_file", refused.status to refused.code)
        assertEquals(GitHubTokenMessages.cannotFile("htxryan/penmoss"), refused.message)
        assertEquals(FeedbackOutbox.Verdict.FINAL, FeedbackOutbox.verdict(refused))

        github.failures += FakeGitHub.Failure("POST", "/repos/htxryan/penmoss/issues", 401, """{"message":"Bad credentials"}""")
        val invalid = api.sendFeedback(payload(id = SECOND), emptyList()) as FeedbackAnswer.Refused
        assertEquals(424 to GitHubTokenMessages.INVALID, invalid.status to invalid.message)
    }

    @Test
    fun aRateLimitWaitsForGitHubsRetryAfter() = runBlocking {
        github.failures += FakeGitHub.Failure(
            "POST",
            "/repos/htxryan/penmoss/issues",
            403,
            """{"message":"API rate limit exceeded"}""",
            headers = mapOf("x-ratelimit-remaining" to "0", "Retry-After" to "30"),
        )
        val limited = api.sendFeedback(payload(), emptyList()) as FeedbackAnswer.Refused
        assertEquals(503 to "github_failed", limited.status to limited.code)
        assertEquals(30_000L, limited.retryAfterMs)
        assertEquals(FeedbackOutbox.Verdict.RETRY, FeedbackOutbox.verdict(limited))
    }

    @Test
    fun aPayloadOrImageGitHubWouldNeverTakeIsRefusedBeforeAnyCall() = runBlocking {
        val noType = api.sendFeedback(payload().replace("\"type\":\"bug\"", "\"type\":\"idea\""), emptyList()) as FeedbackAnswer.Refused
        assertEquals(400 to "invalid_request", noType.status to noType.code)
        val notPng = FeedbackImage(File(dir, "x.png").apply { writeBytes(byteArrayOf(1, 2, 3, 4)) }, "image/png", "screenshot-1.png")
        val wrong = api.sendFeedback(payload(), listOf(notPng)) as FeedbackAnswer.Refused
        assertEquals("A screenshot is not the image/png it says it is", wrong.message)
        val long = api.sendFeedback(payload(description = "x".repeat(FeedbackLimits.DESCRIPTION_MAX + 1)), emptyList()) as FeedbackAnswer.Refused
        assertEquals(413 to "too_large", long.status to long.code)
        assertEquals(0, github.calls.size)
    }

    @Test
    fun withNoTokenItWaitsQueuedAndGoesOnceOneIsSaved() = runBlocking {
        token = null
        val db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        try {
            val outbox = FeedbackOutbox(db.feedback(), File(dir, "outbox"), api, now = { clock })
            outbox.folder(SUBMISSION).mkdirs()
            png().file.copyTo(File(outbox.folder(SUBMISSION), "screenshot-1.png"))
            outbox.enqueue(SUBMISSION, payload(), "Sync stops", listOf("screenshot-1.png"))
            val outcome = outbox.send(SUBMISSION)
            assertEquals(FeedbackOutbox.Outcome.Queued(FeedbackOutbox.NO_TOKEN), outcome)
            val row = db.feedback().get(SUBMISSION)!!
            assertEquals(FeedbackOutboxEntity.QUEUED, row.state)
            assertEquals(0, row.attempts)
            assertEquals("Add your GitHub token in Settings → About → GitHub Token to send it.", row.lastError)
            assertEquals("Queued Nov 1. Add your GitHub token in Settings → About → GitHub Token to send it.", outboxLine(row) { "Nov 1" })
            assertEquals("Queued. Add your GitHub token in Settings → About → GitHub Token to send it.", FeedbackFormModel.queuedMessage((outcome as FeedbackOutbox.Outcome.Queued).why))
            assertEquals(0, github.calls.size)

            // A token is saved: what waited goes.
            token = TOKEN
            assertEquals(1, outbox.tokenSaved())
            assertNull(db.feedback().get(SUBMISSION))
            assertEquals(1, github.issues.size)
        } finally {
            db.close()
        }
    }

    @Test
    fun aReportRefusedForTheTokenGoesAgainWithTheNextTokenSaved() = runBlocking {
        val db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        try {
            val outbox = FeedbackOutbox(db.feedback(), File(dir, "outbox"), api, now = { clock })
            outbox.enqueue(SUBMISSION, payload(), "Sync stops", emptyList())
            github.failures += FakeGitHub.Failure("POST", "/repos/htxryan/penmoss/issues", 404, """{"message":"Not Found"}""")
            assertTrue(outbox.send(SUBMISSION) is FeedbackOutbox.Outcome.Failed)
            assertEquals(FeedbackOutboxEntity.FAILED, db.feedback().get(SUBMISSION)!!.state)
            assertEquals(1, outbox.tokenSaved())
            assertEquals(1, github.issues.size)
        } finally {
            db.close()
        }
    }

    @Test
    fun noNetworkAtAllIsOfflineForTheOutbox() = runBlocking {
        server.close()
        try {
            api.sendFeedback(payload(), emptyList())
            fail("expected IOException")
        } catch (expected: IOException) {
            // The outbox waits without counting it (A803).
        }
    }

    @Test
    fun theTokenIsCheckedWhenSaved() = runBlocking {
        assertEquals(TokenCheck.Ok("htxryan"), api.checkToken("ghp_new"))
        github.permissions = """{"push":false,"triage":false,"pull":true}"""
        assertEquals(TokenCheck.Problem("htxryan", TokenCheck.CANNOT_FILE, GitHubTokenMessages.cannotFile("htxryan/penmoss")), api.checkToken("ghp_new"))
        github.failures += FakeGitHub.Failure("GET", "/repos/htxryan/penmoss", 404, """{"message":"Not Found"}""")
        assertEquals(TokenCheck.CANNOT_FILE, (api.checkToken("ghp_new") as TokenCheck.Problem).problem)
        github.failures += FakeGitHub.Failure("GET", "/user", 401, """{"message":"Bad credentials"}""")
        assertEquals(TokenCheck.Problem(null, TokenCheck.INVALID, GitHubTokenMessages.INVALID), api.checkToken("ghp_old"))
        assertEquals("Bearer ghp_old", github.calls.last().headers["Authorization"])
    }

    @Test
    fun anAccountOutsideTheProjectFilesOnThePublicRepositoryWithItsLabelsDropped() = runBlocking {
        github.isPrivate = false
        github.permissions = """{"push":false,"triage":false,"pull":true}"""
        assertEquals(TokenCheck.Ok("htxryan"), api.checkToken("ghp_new"))
        // GitHub files it, then answers 502; the retry finds the unlabelled issue by its footer.
        github.failures += FakeGitHub.Failure("POST", "/repos/htxryan/penmoss/issues", 502, """{"message":"Bad Gateway"}""", after = true)
        assertEquals(503, (api.sendFeedback(payload(), emptyList()) as FeedbackAnswer.Refused).status)
        assertEquals(emptyList<String>(), github.issues.single().labels)
        clock += 61_000
        assertEquals(FeedbackAnswer.Filed(100, "https://github.com/htxryan/penmoss/issues/100", duplicate = true), api.sendFeedback(payload(), emptyList()))
        assertEquals(1, github.issues.size)
    }

    @Test
    fun savingSaysWhatTheCheckFoundAndKeepsNoTokenGitHubRefuses() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val prefs = context.getSharedPreferences(GitHubTokenStore.PREFS, Context.MODE_PRIVATE).apply { edit().clear().commit() }
        val store = GitHubTokenStore(prefs, XorBox)
        var told = 0
        store.onChange { told++ }
        val model = GitHubTokenModel(store, api::checkToken, "htxryan/penmoss")

        github.failures += FakeGitHub.Failure("GET", "/user", 401, """{"message":"Bad credentials"}""")
        val invalid = model.save("ghp_revoked")
        assertFalse(invalid.kept)
        assertEquals("${GitHubTokenMessages.INVALID} It was not saved.", invalid.message)
        assertFalse(store.hasToken)

        val saved = model.save("  ghp_good  ")
        assertTrue(saved.kept)
        assertEquals("Saved. GitHub knows it as @htxryan, and it can open issues in htxryan/penmoss. Feedback waiting on this phone is sent now.", saved.message)
        assertEquals("ghp_good", store.token())
        assertEquals("htxryan", store.login())
        assertEquals(1, told)
        // Sealed: the preferences never hold the token itself.
        assertTrue(prefs.all.values.none { it.toString().contains("ghp_good") })
        // Another store over the same preferences (the app started again) reads it back.
        assertEquals("ghp_good", GitHubTokenStore(prefs, XorBox).token())

        assertEquals("Removed. Feedback waits on this phone until you add a token again.", model.remove())
        assertNull(store.token())
        assertEquals(FeedbackRoutes.tokenSummary(false, null), "Not set: Send Feedback needs it to file the issue")
    }

    @Test
    fun theLedgerIsKeptInItsOwnPreferences() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val prefs = context.getSharedPreferences(PrefsFeedbackLedger.PREFS, Context.MODE_PRIVATE).apply { edit().clear().commit() }
        val ledger = PrefsFeedbackLedger(prefs) { clock }
        ledger.set("OLD", FeedbackLedgerEntry(clock - PrefsFeedbackLedger.KEEP_MS - 1, FeedbackLedgerEntry.SENT, 5, "https://github.com/htxryan/penmoss/issues/5", updatedAt = clock - PrefsFeedbackLedger.KEEP_MS - 1))
        val entry = FeedbackLedgerEntry(clock, FeedbackLedgerEntry.FAILED, settleUntil = clock + 60_000, updatedAt = clock)
        ledger.set(SUBMISSION, entry)
        assertEquals(entry, PrefsFeedbackLedger(prefs) { clock }.get(SUBMISSION))
        // Older than 90 days: forgotten.
        assertNull(ledger.get("OLD"))
    }

    private object XorBox : SecretBox {
        override fun seal(plain: ByteArray) = ByteArray(plain.size) { (plain[it].toInt() xor 0x5a).toByte() }

        override fun open(sealed: ByteArray) = seal(sealed)
    }

    private companion object {
        const val TOKEN = "ghp_PersonalToken0123456789abcdefABCDEF"
        const val SUBMISSION = "01JBFEEDBACK0000000000000A"
        const val SECOND = "01JBFEEDBACK0000000000000B"
    }
}
