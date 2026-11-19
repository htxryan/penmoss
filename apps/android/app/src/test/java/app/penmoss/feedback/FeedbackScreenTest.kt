package app.penmoss.feedback

import app.penmoss.stopScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.penmoss.data.PenmossDatabase
import app.penmoss.engine.api.FeedbackAnswer
import app.penmoss.engine.api.FeedbackImage
import app.penmoss.engine.api.PenmossFeedbackApi
import app.penmoss.ui.common.PenmossTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.nio.file.Files

/**
 * The Send feedback form (T49, D41): required fields said and read out, the markdown toolbar,
 * groups left out of exactly what is sent, offline queueing, and the About and Status screens.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class FeedbackScreenTest {
    @get:Rule
    val compose = createComposeRule()

    private lateinit var db: PenmossDatabase
    private lateinit var dir: File
    /** The app's scope, on real threads: a send's Room work resumes there, not on the rule's test dispatcher. */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val sent = mutableListOf<String>()
    private var answer: () -> FeedbackAnswer = { FeedbackAnswer.Filed(42, "https://github.com/htxryan/penmoss/issues/42", false) }
    private lateinit var service: FeedbackService
    private var closed = 0

    private val context = FeedbackContextData(
        listOf(
            fieldGroup(FeedbackGroupId.APP, listOf("Client" to "Android")),
            fieldGroup(FeedbackGroupId.WHERE, listOf("Route" to "/home")),
            tableGroup(FeedbackGroupId.ERRORS, ERROR_COLUMNS, emptyList()),
        ),
    )

    @Before
    fun open() {
        db = PenmossDatabase.inMemory(ApplicationProvider.getApplicationContext())
        dir = Files.createTempDirectory("form").toFile()
        val api = object : PenmossFeedbackApi {
            override suspend fun sendFeedback(payload: String, images: List<FeedbackImage>): FeedbackAnswer {
                sent += payload
                return answer()
            }
        }
        val outbox = FeedbackOutbox(db.feedback(), File(dir, "outbox"), api)
        val collector = FeedbackCollector(db, RecentErrors(), { emptyList() }, { error("not used") }, { error("not used") })
        service = FeedbackService(outbox, FeedbackDrafts(File(dir, "draft")) { "01JBXYZ0000000000000000001" }, collector, File(dir, "capture"), "0.31 (build 431425)", scope)
    }

    @After
    fun close() {
        // Ended before the database closes (A690), not only cancelled.
        stopScope(scope)
        db.close()
        dir.deleteRecursively()
    }

    /** The form as its route lays it out, on a model of its own. */
    @Composable
    private fun Form(model: FeedbackFormModel, logs: List<String> = emptyList()) {
        val draft by model.draft.collectAsStateWithLifecycle()
        val phase by model.phase.collectAsStateWithLifecycle()
        val problems by model.showProblems.collectAsStateWithLifecycle()
        val notice by model.notice.collectAsStateWithLifecycle()
        PenmossTheme {
            FeedbackScreen(
                FeedbackUi(draft, context, phase, problems, notice, logs = logs),
                FeedbackActions(
                    close = { closed++ },
                    send = { model.send(context, logs) },
                    logs = model::setLogs,
                    type = model::setType,
                    priority = model::setPriority,
                    title = model::setTitle,
                    description = model::setDescription,
                    omit = model::setOmitted,
                ),
            )
        }
    }

    @Test
    fun sendingWithNothingChosenSaysWhatIsMissingAndSendsNothing() {
        val model = FeedbackFormModel(service, scope)
        compose.setContent { Form(model) }
        compose.onNodeWithTag("feedbackSend").performClick()
        compose.onNodeWithTag("feedbackProblems")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, androidx.compose.ui.semantics.LiveRegionMode.Assertive))
            .assertIsDisplayed()
        compose.onNodeWithText("Choose Bug report or Feature request.").assertIsDisplayed()
        compose.onNodeWithText("Choose a priority.").performScrollTo().assertIsDisplayed()
        compose.onNodeWithTag("feedbackTitle").assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Error))
        assertTrue(sent.isEmpty())
        // No default: neither type nor priority is chosen.
        compose.onNodeWithTag("priority-3").assert(SemanticsMatcher.expectValue(SemanticsProperties.Selected, false))
    }

    @Test
    fun aFilledFormSendsWhatThePreviewShowedWithoutTheGroupLeftOut() {
        val model = FeedbackFormModel(service, scope)
        compose.setContent { Form(model) }
        compose.onNodeWithTag("type-bug").performClick()
        compose.onNodeWithTag("priority-2").performScrollTo().performClick()
        compose.onNodeWithTag("feedbackTitle").performScrollTo().performTextInput("Sync stalls")
        compose.onNodeWithTag("feedbackDescription").performScrollTo().performTextInput("It broke")
        compose.onNodeWithContentDescription("Bold").performClick()
        compose.waitForIdle()
        assertEquals("It broke****", model.draft.value.description)
        // Captured Context: the exact markdown, and a group left out.
        compose.onNodeWithTag("feedbackForm").performScrollToNode(hasText("Captured Context"))
        compose.onNodeWithTag("contextToggle").performClick()
        compose.onNodeWithTag("feedbackForm").performScrollToNode(hasText("Include Where you are"))
        compose.onNodeWithTag("group-where").assertIsOn().performClick()
        compose.onNodeWithTag("group-where").assertIsOff()
        val preview = FeedbackMarkdown.context(context.without(setOf("where")))
        compose.onNodeWithTag("contextMarkdown").assert(SemanticsMatcher.expectValue(SemanticsProperties.Text, listOf(androidx.compose.ui.text.AnnotatedString(preview))))
        compose.onNodeWithTag("feedbackSend").performClick()
        compose.waitUntil(5_000) { model.phase.value == FeedbackFormModel.Phase.Sent }
        val payload = Json.parseToJsonElement(sent.single()).jsonObject
        assertEquals("Sync stalls", payload.getValue("title").jsonPrimitive.content)
        assertEquals("It broke****", payload.getValue("description").jsonPrimitive.content)
        val groups = Json.decodeFromJsonElement(FeedbackContextData.serializer(), payload.getValue("context"))
        assertEquals(preview, FeedbackMarkdown.context(groups))
        // Sent: the outbox and the draft are empty again.
        assertEquals(0, runBlocking { db.feedback().count() })
        assertFalse(File(dir, "draft/draft.json").exists())
    }

    /** PEN-137 (AC7, O6): a bug report attaches its anonymised logs unless unticked; a feature request never offers them. */
    @Test
    fun aBugAttachesItsAnonymisedLogsTickedAndAFeatureRequestHasNone() {
        val logs = listOf("2026-11-19T11:54:16.525Z info Sync pass ok", "2026-11-19T11:54:17.001Z warn Git push failed: ‹token›")
        val model = FeedbackFormModel(service, scope)
        model.setType(FeedbackType.FEATURE)
        compose.setContent { Form(model, logs) }
        compose.onNodeWithTag("feedbackForm").performScrollToNode(hasText("Captured Context"))
        compose.onNodeWithTag("feedbackLogs").assertDoesNotExist()
        compose.onNodeWithTag("type-bug").performScrollTo().performClick()
        compose.onNodeWithTag("feedbackForm").performScrollToNode(hasText("Attach Anonymised Logs"))
        compose.onNodeWithTag("feedbackLogs").assertIsOn()
        val size = FeedbackLogs.formatReportSize(FeedbackLogs.textBytes(logs))
        compose.onNodeWithTag("feedbackLogsSummary", useUnmergedTree = true).assertTextEquals("Anonymised Logs · 2 lines · $size")
        compose.onNodeWithTag("feedbackLogsHint").assertTextEquals(
            "The app’s logs from the last 24 hours, at most 300 lines and 16 KB, with names, paths, IDs and secrets replaced. This is exactly what is attached.",
        )
        compose.onNodeWithTag("feedbackLogsToggle").performScrollTo().performClick()
        compose.onNodeWithTag("feedbackLogsText").performScrollTo().assertTextEquals(logs.joinToString("\n"))
        model.setPriority(2)
        model.setTitle("Sync stalls")
        compose.onNodeWithTag("feedbackSend").performClick()
        compose.waitUntil(5_000) { model.phase.value == FeedbackFormModel.Phase.Sent }
        val payload = Json.parseToJsonElement(sent.single()).jsonObject
        assertEquals(logs, payload.getValue("logs").jsonArray.map { it.jsonPrimitive.content })
    }

    @Test
    fun untickedTheLogsStayOnThePhone() {
        val logs = listOf("2026-11-19T11:54:16.525Z info Sync pass ok")
        val model = FeedbackFormModel(service, scope)
        model.setType(FeedbackType.BUG)
        model.setPriority(3)
        model.setTitle("Odd")
        compose.setContent { Form(model, logs) }
        compose.onNodeWithTag("feedbackForm").performScrollToNode(hasText("Attach Anonymised Logs"))
        compose.onNodeWithTag("feedbackLogs").assertIsOn().performClick()
        compose.onNodeWithTag("feedbackLogs").assertIsOff()
        compose.onNodeWithTag("feedbackSend").performClick()
        compose.waitUntil(5_000) { model.phase.value == FeedbackFormModel.Phase.Sent }
        assertFalse(Json.parseToJsonElement(sent.single()).jsonObject.containsKey("logs"))
    }

    @Test
    fun offlineItQueuesAndSaysSo() {
        answer = { throw java.io.IOException("offline") }
        val model = FeedbackFormModel(service, scope)
        model.setType(FeedbackType.FEATURE)
        model.setPriority(4)
        model.setTitle("Dark mode")
        compose.setContent { Form(model) }
        compose.onNodeWithTag("feedbackSend").performClick()
        compose.waitUntil(5_000) { model.phase.value is FeedbackFormModel.Phase.Queued }
        compose.onNodeWithText("Queued, will send when you’re online.").assertIsDisplayed()
        compose.onNodeWithTag("feedbackDone").performClick()
        assertEquals(1, closed)
        assertEquals(1, runBlocking { service.outbox.waitingCount() })
    }

    @Test
    fun settingsStatusKeepsA4xxWithRetryAndDiscard() {
        answer = { FeedbackAnswer.Refused(403, "device_only", "Devices only") }
        runBlocking {
            service.outbox.enqueue("01JBXYZ0000000000000000001", "{}", "Dark mode", emptyList())
            service.outbox.sendDue()
        }
        val rows = runBlocking { db.feedback().all() }
        assertEquals(FeedbackOutboxEntity.FAILED, rows.single().state)
        var retried = ""
        var discarded = ""
        var edited = ""
        compose.setContent {
            PenmossTheme {
                FeedbackOutboxList(rows, onRetry = { retried = it }, onDiscard = { discarded = it }, dateOf = { "27 Oct" }, onEdit = { edited = it }, notice = DRAFT_IN_THE_WAY)
            }
        }
        compose.onNodeWithText("Dark mode").assertIsDisplayed()
        compose.onNodeWithText("Not sent: Devices only (403).").assertIsDisplayed()
        compose.onNodeWithTag("feedbackOutboxNotice")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, androidx.compose.ui.semantics.LiveRegionMode.Polite))
            .assertIsDisplayed()
        // A refused report has Edit beside Retry and Discard (T49 review).
        compose.onNodeWithTag("feedbackEdit").assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, androidx.compose.ui.semantics.Role.Button)).performClick()
        assertEquals("01JBXYZ0000000000000000001", edited)
        compose.onNodeWithTag("feedbackRetry").performClick()
        compose.onNodeWithTag("feedbackDiscardQueued").performClick()
        compose.onNodeWithTag("confirmDiscardQueued").performClick()
        assertEquals("01JBXYZ0000000000000000001", retried)
        assertEquals("01JBXYZ0000000000000000001", discarded)
    }

    @Test
    fun aReportWaitingToSendHasNoEdit() {
        runBlocking { service.outbox.enqueue("01JBXYZ0000000000000000001", "{}", "Dark mode", emptyList()) }
        val rows = runBlocking { db.feedback().all() }
        compose.setContent { PenmossTheme { FeedbackOutboxList(rows, onRetry = {}, onDiscard = {}, dateOf = { "27 Oct" }) } }
        compose.onNodeWithTag("feedbackRetry").assertIsDisplayed()
        compose.onNodeWithTag("feedbackEdit").assertDoesNotExist()
    }

    @Test
    fun aRefusedReportIsNeverLostEditPutsItBackInTheFormWithItsScreenshots() {
        answer = { FeedbackAnswer.Refused(422, "invalid_request", "The context is too large") }
        val model = FeedbackFormModel(service, scope)
        model.setType(FeedbackType.BUG)
        model.setPriority(2)
        model.setTitle("Sync stalls")
        model.setDescription("It **broke**\n\n- twice")
        val png = java.io.ByteArrayOutputStream().also {
            android.graphics.Bitmap.createBitmap(40, 20, android.graphics.Bitmap.Config.ARGB_8888).compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }.toByteArray()
        runBlocking { model.addImage("image/png", png.size.toLong()) { png.inputStream() } }
        model.setOmitted("where", true)
        model.send(context)
        compose.waitUntil(5_000) { model.phase.value is FeedbackFormModel.Phase.Failed }
        val id = "01JBXYZ0000000000000000001"
        assertEquals(FeedbackOutboxEntity.FAILED, runBlocking { db.feedback().get(id) }!!.state)
        assertFalse(File(dir, "draft/draft.json").exists())

        // Edit: the form holds it again, the entry is gone.
        var shown = 0
        assertEquals(FeedbackService.Edit.OPENED, runBlocking { service.edit(id) { shown++ } })
        assertEquals(1, shown)
        assertEquals(0, runBlocking { db.feedback().count() })
        assertFalse(service.outbox.folder(id).exists())
        val again = FeedbackFormModel(service, scope)
        val draft = again.draft.value
        assertEquals(listOf(id, "bug", "Sync stalls", "It **broke**\n\n- twice"), listOf(draft.submissionId, draft.type, draft.title, draft.description))
        assertEquals(2, draft.priority)
        assertEquals(listOf("image/png"), draft.screenshots.map { it.mime })
        assertTrue(service.drafts.image(draft.screenshots.single().file).isFile)
        // With the context it was captured with, the group left out still out.
        assertEquals(context.without(setOf("where")), service.opening.value!!.context)

        // Sent again, fixed: the same submission, with its screenshot.
        answer = { FeedbackAnswer.Filed(43, "https://github.com/htxryan/penmoss/issues/43", false) }
        again.setTitle("Sync stalls on big notes")
        again.send(service.opening.value!!.context)
        compose.waitUntil(5_000) { again.phase.value == FeedbackFormModel.Phase.Sent }
        val payload = Json.parseToJsonElement(sent.last()).jsonObject
        assertEquals(id, payload.getValue("submissionId").jsonPrimitive.content)
        assertEquals("Sync stalls on big notes", payload.getValue("title").jsonPrimitive.content)
        assertEquals(0, runBlocking { db.feedback().count() })
    }

    @Test
    fun editWaitsForADraftInTheWayAndKeepsTheReport() {
        val id = "01JBXYZ0000000000000000009"
        runBlocking {
            service.outbox.enqueue(id, """{"submissionId":"$id","type":"feature","priority":4,"title":"Dark mode","description":""}""", "Dark mode", emptyList())
        }
        service.drafts.save(FeedbackDraft("01JBXYZ0000000000000000001", title = "Half written"))
        var shown = 0
        assertEquals(FeedbackService.Edit.DRAFT_IN_THE_WAY, runBlocking { service.edit(id) { shown++ } })
        assertEquals(0, shown)
        assertEquals(1, runBlocking { db.feedback().count() })
        assertEquals("Half written", service.drafts.load().title)
        // Gone meanwhile: nothing changes.
        assertEquals(FeedbackService.Edit.GONE, runBlocking { service.edit("01JBXYZ000000000000000000Z") { shown++ } })
    }

    @Test
    fun aDraftIsKeptUntilSentOrDiscarded() {
        val first = FeedbackFormModel(service, scope)
        first.setTitle("Half written")
        first.setPriority(3)
        first.setOmitted("errors", true)
        service.drafts.save(first.draft.value)
        val again = FeedbackFormModel(service, scope)
        assertEquals("Half written", again.draft.value.title)
        assertEquals(3, again.draft.value.priority)
        assertEquals(listOf("errors"), again.draft.value.omitted)
        assertEquals("01JBXYZ0000000000000000001", again.draft.value.submissionId)
        again.discard()
        assertEquals("", FeedbackFormModel(service, scope).draft.value.title)
    }

    /** Settings → GitHub (PEN-146, was About): the account, Sign Out once confirmed, the token path and Send Feedback. */
    @Test
    fun gitHubShowsTheAccountSignsOutOnceConfirmedAndSendsFeedback() {
        var opened = 0
        val signedOut = mutableListOf<String?>()
        var token = 0
        compose.setContent {
            PenmossTheme {
                GitHubScreen(
                    accounts = listOf(GitHubAccount("htxryan", primary = true)), signIn = SignInState.Idle, canSignIn = true,
                    onSignIn = {}, onCancelSignIn = {}, onSignOut = { signedOut += it }, onToken = { token++ }, onBack = {},
                    onSendFeedback = { opened++ },
                )
            }
        }
        compose.onNodeWithTag("githubLogin", useUnmergedTree = true).assertTextEquals("htxryan")
        compose.onNodeWithText("Used For").assertIsDisplayed()
        compose.onNodeWithTag("githubSignIn").assertTextEquals("Add Account")
        // The only account has no Use for Send Feedback: it is already the one.
        compose.onNodeWithTag("githubAccountMenu-htxryan").performClick()
        compose.onNodeWithTag("githubMakePrimary").assertDoesNotExist()
        compose.onNodeWithTag("githubSignOut").performClick()
        assertEquals(emptyList<String?>(), signedOut)
        compose.onNodeWithText("Feedback waits on the phone until you sign in again.", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("githubSignOutConfirm").performClick()
        assertEquals(listOf<String?>("htxryan"), signedOut)
        compose.onNodeWithTag("githubUseToken").performClick()
        assertEquals(1, token)
        compose.onNodeWithTag("githubSendFeedback").performScrollTo()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, androidx.compose.ui.semantics.Role.Button)).performClick()
        assertEquals(1, opened)
        // No version here: it is What's New's.
        compose.onNodeWithText("Version", substring = true).assertDoesNotExist()
    }

    /** Several accounts (A1616): a work one beside a personal one, either for Send Feedback, each signed out alone. */
    @Test
    fun gitHubListsEachAccountAndMovesSendFeedbackBetweenThem() {
        var accounts by mutableStateOf(listOf(GitHubAccount("htxryan", primary = true), GitHubAccount("ryan-work", primary = false)))
        val signedOut = mutableListOf<String?>()
        val primaries = mutableListOf<String?>()
        compose.setContent {
            PenmossTheme {
                GitHubScreen(
                    accounts = accounts, signIn = SignInState.Idle, canSignIn = true,
                    onSignIn = {}, onCancelSignIn = {}, onSignOut = { signedOut += it }, onToken = {}, onBack = {},
                    onMakePrimary = { primaries += it },
                )
            }
        }
        compose.onNodeWithTag("githubLogin", useUnmergedTree = true).assertTextEquals("htxryan")
        compose.onNodeWithTag("githubLogin-ryan-work", useUnmergedTree = true).assertTextEquals("ryan-work")
        compose.onNodeWithTag("githubAddHelp").assertIsDisplayed()
        compose.onNodeWithTag("githubAccountMenu-ryan-work").performClick()
        compose.onNodeWithTag("githubMakePrimary").performClick()
        assertEquals(listOf<String?>("ryan-work"), primaries)
        // Signing out of the first says where Send Feedback goes.
        compose.onNodeWithTag("githubAccountMenu-htxryan").performClick()
        compose.onNodeWithTag("githubSignOut").performClick()
        compose.onNodeWithText("Send Feedback moves to @ryan-work.", substring = true).assertIsDisplayed()
        compose.onNodeWithTag("githubSignOutConfirm").performClick()
        assertEquals(listOf<String?>("htxryan"), signedOut)
    }

    /** Sign In with GitHub (PEN-146): the code to enter while it waits, with Cancel; how it ended, after. */
    @Test
    fun signInShowsTheCodeWhileItWaitsAndHowItEnded() {
        var state by mutableStateOf<SignInState>(SignInState.Waiting("WDJB-MJHT", "https://github.com/login/device", expiresAt = 0))
        var cancelled = 0
        val opened = mutableListOf<Pair<String, String>>()
        compose.setContent {
            PenmossTheme {
                GitHubScreen(
                    accounts = emptyList(), signIn = state, canSignIn = true,
                    onSignIn = {}, onCancelSignIn = { cancelled++ }, onSignOut = {}, onToken = {}, onBack = {},
                    onOpenGitHub = { code, uri -> opened += code to uri },
                )
            }
        }
        compose.onNodeWithTag("githubLogin", useUnmergedTree = true).assertTextEquals("Not Signed In")
        compose.onNodeWithTag("githubUserCode").assertTextEquals("WDJB-MJHT")
        compose.onNodeWithTag("githubSignIn").assertDoesNotExist()
        // The code shows first; GitHub's page opens only on the button (17 Nov 2026).
        assertEquals(emptyList<Pair<String, String>>(), opened)
        compose.onNodeWithTag("githubSignInOpen").performClick()
        assertEquals(listOf("WDJB-MJHT" to "https://github.com/login/device"), opened)
        compose.onNodeWithTag("githubSignInCancel").performClick()
        assertEquals(1, cancelled)
        state = SignInState.Denied
        compose.onNodeWithTag("githubSignInMessage").assertTextEquals("GitHub says the sign-in was declined. Nothing was kept.")
        compose.onNodeWithTag("githubSignIn").assertTextEquals("Sign In with GitHub")
        // Without Send Feedback's form (the app's home), it says where to send it from.
        compose.onNodeWithText("Send it from a notebook’s ⋮ menu.", substring = true).performScrollTo().assertIsDisplayed()
    }

    @Test
    fun screenshotsMoveUpAndDownByNamedButtonsAndTheCaptureIsOfferedUnticked() {
        val shots = listOf(DraftImage("a.png", "image/png"), DraftImage("b.jpg", "image/jpeg"))
        val moves = mutableListOf<Pair<Int, Int>>()
        var ticked: Boolean? = null
        compose.setContent {
            PenmossTheme {
                FeedbackScreen(
                    FeedbackUi(FeedbackDraft("x", screenshots = shots), context, capture = File(dir, "capture.png")),
                    FeedbackActions(move = { i, by -> moves += i to by }, capture = { ticked = it }, thumbnail = { null }),
                )
            }
        }
        compose.onNodeWithTag("feedbackForm").performScrollToNode(hasText("Add a screenshot of the screen behind"))
        compose.onNodeWithTag("feedbackCapture").assertIsOff().performClick()
        assertEquals(true, ticked)
        compose.onNodeWithContentDescription("Move screenshot 1 up").performScrollTo().assert(SemanticsMatcher.keyIsDefined(SemanticsProperties.Disabled))
        compose.onNodeWithContentDescription("Move screenshot 1 down").performScrollTo().performClick()
        compose.onNodeWithContentDescription("Move screenshot 2 up").performScrollTo().performClick()
        assertEquals(listOf(0 to 1, 1 to -1), moves)
        compose.onNodeWithContentDescription("Remove screenshot 2").performScrollTo().assertIsDisplayed()
    }
}
