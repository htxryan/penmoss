package app.penmoss.git.firstrun

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.common.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.trackedClick
import app.penmoss.feedback.SignInState
import app.penmoss.ui.common.roles
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/** Where GitHub Access is: asking GitHub with the phone's sign-in, none yet, or refused. */
private sealed interface Check {
    data object Checking : Check
    data object NoSignIn : Check

    data class Failed(val error: BrowseError) : Check
}

/**
 * GitHub Access (A1404; the Mac's FirstRunGitHub.tsx, 2.1–2.9): with the phone's GitHub sign-in
 * (Settings → GitHub) it reads the repositories and goes straight on. With none, Sign In with
 * GitHub (the device code, PEN-146) or a personal access token typed here; refused, offline or
 * rate-limited, it says so with Try Again, and Paste a URL Instead goes on without GitHub. With
 * several accounts it never asks which: it lists [account]'s, else the first account's, and the
 * switcher at the top of the list changes it (A1618). Add Another Account signs in beside the others.
 */
@Composable
internal fun GitHubAccess(
    deps: FirstRunDeps,
    onReady: (Hub) -> Unit,
    onUrl: () -> Unit,
    back: () -> Unit,
    /** Picked in the switcher (A1618): read at once. Back from Add Another Account comes back to it. */
    account: app.penmoss.feedback.GitHubAccount? = null,
    /** Add Another Account from the switcher: the sign-in at once. */
    add: Boolean = false,
) {
    var check by remember { mutableStateOf<Check>(Check.Checking) }
    var asked by remember { mutableIntStateOf(0) }
    var typing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val idle = remember { MutableStateFlow<SignInState>(SignInState.Idle) }
    val device by (deps.signIn?.state ?: idle).collectAsState()
    /** This screen started a sign-in: only then do its outcomes show here. */
    var signing by remember { mutableStateOf(false) }
    /** The account picked, or just signed in to: its repositories are read (A1616). */
    var picked by remember { mutableStateOf(account) }
    /** Add Another Account: the sign-in screen, with the other accounts kept. */
    var adding by remember { mutableStateOf(add) }

    LaunchedEffect(Unit) { deps.signIn?.reset() }
    LaunchedEffect(asked) {
        // Add Another Account (the switcher's): nothing is read until it ends.
        if (adding) {
            check = Check.NoSignIn
            return@LaunchedEffect
        }
        val accounts = deps.accounts()
        // Never Pick GitHub Account (Ryan, 18 Nov 2026; A1618): the one picked, else the first.
        val account = picked?.takeIf { now -> accounts.any { it.login == now.login } }
            ?: accounts.firstOrNull { it.primary } ?: accounts.firstOrNull()
        val saved = account?.let { deps.tokenFor(it.login) }
        if (saved == null) {
            check = Check.NoSignIn
            return@LaunchedEffect
        }
        check = Check.Checking
        val (hub, error) = readHub(deps.browse, saved, account.login)
        if (hub != null) onReady(hub) else check = Check.Failed(error!!)
    }
    fun again() {
        signing = false
        deps.signIn?.reset()
        asked++
    }
    fun withAccount(account: app.penmoss.feedback.GitHubAccount) {
        picked = account
        adding = false
        again()
    }
    fun signIn() {
        signing = true
        // GitHub's page opens only once the code is on screen (Ryan's Android feedback, 15 Nov 2026):
        // opened at once, a phone shows the browser over the code, with nothing saying to come back.
        deps.signIn?.start(scope) {}
    }
    // In the screen, not the footer: a phone's footer holds Back and one button (A1404 on Android).
    val urlInstead = @Composable { Link("Paste a URL Instead", "first-run-url-instead", "link", event = "firstrun.github.paste-a-url-instead", onClick = onUrl) }
    // Settings → GitHub's words for the same page.
    val tokenLink = @Composable { Link(if (deps.accounts().isEmpty()) "Use a Token Instead" else "Add with a Token", "first-run-use-token", "key-round", event = "firstrun.github.use-token") { typing = true } }
    val signInButton = @Composable { words: String ->
        if (deps.signIn?.available == true) Primary(words, "first-run-signin", "log-in", onClick = ::signIn, event = "firstrun.github.sign-in")
        else Primary("Try Again", "first-run-retry", "refresh-cw", onClick = ::again, event = "firstrun.github.try-again")
    }

    if (typing) {
        // Settings → GitHub's token page, in this frame (one page, not two; Ryan, 18 Nov 2026).
        Frame("github-token", app.penmoss.feedback.githubTokenTitle(remember { deps.accounts() }), step = 2, back = { typing = false }) {
            app.penmoss.feedback.GitHubTokenForm(
                deps.accounts,
                deps.feedbackRepo,
                onSave = { typed ->
                    deps.addToken?.invoke(typed) ?: run {
                        val (hub, error) = readHub(deps.browse, typed.trim(), null)
                        if (hub == null) app.penmoss.feedback.GitHubTokenModel.Saved(false, error!!.message)
                        else {
                            deps.saveToken(typed.trim(), hub.login)
                            app.penmoss.feedback.GitHubTokenModel.Saved(true, "Added.", hub.login)
                        }
                    }
                },
                onAdded = { saved ->
                    typing = false
                    withAccount(app.penmoss.feedback.GitHubAccount(saved.login, primary = false))
                },
            )
        }
        return
    }

    // Penmoss's own sign-in, as this screen started it.
    if (signing) {
        when (val state = device) {
            is SignInState.SignedIn -> {
                Frame(
                    "github",
                    "Signed In to GitHub",
                    step = 2,
                    back = back,
                    actions = { Primary("Continue", "first-run-continue", "arrow-right", event = "firstrun.continue") { withAccount(app.penmoss.feedback.GitHubAccount(state.login, primary = false)) } },
                ) {
                    Text("Signed in", Modifier.testTag("first-run-signed-in"), style = MaterialTheme.roles.rowLabel, color = MaterialTheme.colorScheme.primary)
                    Lead("Kept with the Android Keystore. Sign out in Settings → GitHub.", small = true)
                }
                return
            }
            is SignInState.Waiting -> {
                Frame(
                    "github-code",
                    "Enter This Code on GitHub",
                    step = 2,
                    back = {
                        deps.signIn?.cancel()
                        back()
                    },
                    actions = {
                        Primary("Copy Code and Open GitHub", "github-signin-open", "external-link", event = "firstrun.github.copy-code") {
                            deps.copy(state.userCode)
                            deps.openUrl(state.verificationUri)
                        }
                    },
                    below = {
                        Lead(
                            "Or, on any device signed in to GitHub, such as your computer, open ${state.verificationUri.removePrefix("https://")} and enter the code.",
                            Modifier.testTag("github-signin-elsewhere"),
                            small = true,
                            centered = true,
                        )
                        Link("Cancel", "github-signin-cancel", "x", event = "firstrun.github.cancel") { deps.signIn?.cancel() }
                    },
                ) {
                    Lead("GitHub asks for this code. Copy it and open GitHub, enter it there and approve Penmoss, then come back: this screen goes on by itself.")
                    // The code, with Copy beside it, where people look for it.
                    Box(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(vertical = 16.dp)) {
                        Text(
                            state.userCode,
                            Modifier
                                .align(Alignment.Center)
                                .testTag("github-signin-code")
                                .semantics { contentDescription = "Code ${state.userCode}" },
                            style = MaterialTheme.roles.pageTitle,
                        )
                        app.penmoss.ui.common.IconButton(
                            onClick = trackedClick("settings.github.sign-in.copy-code") { deps.copy(state.userCode) },
                            modifier = Modifier.align(Alignment.CenterEnd).padding(end = 8.dp).testTag("github-signin-copy"),
                        ) { LucideGlyph("copy", contentDescription = "Copy Code") }
                    }
                    Working("Waiting for you to approve…", "github-signin-waiting")
                }
                return
            }
            SignInState.Denied, SignInState.Expired, SignInState.Cancelled, is SignInState.Failed -> {
                val words = when (state) {
                    SignInState.Denied -> "GitHub’s page said no, so Penmoss isn’t signed in."
                    SignInState.Expired -> "The code ran out before it was entered. Sign in again for a new one."
                    SignInState.Cancelled -> "Sign-in cancelled."
                    is SignInState.Failed -> state.message
                }
                Frame(
                    "github",
                    "Sign In to GitHub",
                    step = 2,
                    back = back,
                    actions = { signInButton("Sign In Again") },
                    below = {
                        tokenLink()
                        urlInstead()
                    },
                ) {
                    Problem(words, "github-signin-ended")
                }
                return
            }
            SignInState.Idle -> Unit
        }
    }

    when (val now = check) {
        Check.Checking -> Frame("github", "Checking GitHub", step = 2, back = back) {
            Working("Reading your repositories…")
        }
        // 2.3: no GitHub sign-in on this phone yet, or Add Another Account (A1616).
        Check.NoSignIn -> Frame(
            "github",
            if (adding) "Add GitHub Account" else "Sign In to GitHub",
            step = 2,
            // Back from Add Another Account: the account listed before, its repositories again.
            back = if (adding) ({ adding = false; again() }) else back,
            actions = { signInButton("Sign In with GitHub") },
            below = {
                tokenLink()
                urlInstead()
            },
        ) {
            // The Back gesture as the Back button: the repositories again, not the step before.
            androidx.activity.compose.BackHandler(enabled = adding) { adding = false; again() }
            if (adding) {
                Lead("Sign in as your other GitHub account. Your other accounts, and the notebooks added with them, stay as they are.")
                Lead("On GitHub’s page, check the account shown at the top right is the one you want; switch accounts there if it isn’t.", Modifier.testTag("first-run-add-account-hint"), small = true)
            } else {
                Lead("Penmoss lists your repositories and syncs with this sign-in.")
                Lead("GitHub shows a short code to enter in your browser; nothing is typed here. The sign-in is kept with the Android Keystore.", small = true)
            }
        }
        is Check.Failed -> {
            val error = now.error
            if (error.reason == BrowseReason.UNAUTHORIZED || error.reason == BrowseReason.FORBIDDEN) {
                // 2.7: GitHub refuses the sign-in the phone has: expired, or an organisation's SSO.
                Frame(
                    "github",
                    "GitHub Refused the Sign-In",
                    step = 2,
                    back = back,
                    actions = { signInButton("Sign In with GitHub") },
                    below = {
                        Link("Try Again", "first-run-retry", "refresh-cw", event = "firstrun.github.try-again", onClick = ::again)
                        tokenLink()
                        urlInstead()
                    },
                ) {
                    Problem(error.message, "first-run-github-problem")
                    Lead("Repositories in an organisation with single sign-on need Penmoss authorised for it on GitHub.")
                }
            } else {
                // 2.9: offline, rate-limited, or anything else GitHub answered.
                Frame(
                    "github",
                    if (error.reason == BrowseReason.OFFLINE) "Can’t Reach GitHub" else "GitHub Didn’t Answer",
                    step = 2,
                    back = back,
                    actions = { Primary("Try Again", "first-run-retry", "refresh-cw", onClick = ::again, event = "firstrun.github.try-again") },
                    below = { urlInstead() },
                ) {
                    Problem(if (error.reason == BrowseReason.OFFLINE) "Check the connection, then try again." else error.message, "first-run-github-problem")
                    if (error.reason == BrowseReason.OFFLINE || error.reason == BrowseReason.RATE_LIMITED) {
                        Lead("If GitHub is limiting requests, wait a few minutes.", small = true)
                    }
                }
            }
        }
    }
}
