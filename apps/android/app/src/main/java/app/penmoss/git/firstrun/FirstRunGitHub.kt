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
import app.penmoss.feedback.SignInState
import app.penmoss.ui.common.roles
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/** Where GitHub Access is: asking GitHub with the phone's sign-in, none yet, or refused. */
private sealed interface Check {
    data object Checking : Check
    data object NoSignIn : Check

    /** More than one account (or Switch Account): which one lists the repositories (A1616). */
    data class Choose(val accounts: List<app.penmoss.feedback.GitHubAccount>) : Check
    data class Failed(val error: BrowseError) : Check
}

/**
 * GitHub Access (A1404; the Mac's FirstRunGitHub.tsx, 2.1–2.9): with the phone's GitHub sign-in
 * (Settings → GitHub) it reads the repositories and goes straight on. With none, Sign In with
 * GitHub (the device code, PEN-146) or a personal access token typed here; refused, offline or
 * rate-limited, it says so with Try Again, and Paste a URL Instead goes on without GitHub. With
 * more than one account on the phone, or [choose] (back from Use a Different GitHub Account), it first asks which,
 * with Add Another Account, which signs in beside the others (A1616).
 */
@Composable
internal fun GitHubAccess(deps: FirstRunDeps, onReady: (Hub) -> Unit, onUrl: () -> Unit, back: () -> Unit, choose: Boolean = false) {
    var check by remember { mutableStateOf<Check>(Check.Checking) }
    var asked by remember { mutableIntStateOf(0) }
    var typing by remember { mutableStateOf(false) }
    var token by remember { mutableStateOf("") }
    var tokenBusy by remember { mutableStateOf(false) }
    var tokenProblem by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val idle = remember { MutableStateFlow<SignInState>(SignInState.Idle) }
    val device by (deps.signIn?.state ?: idle).collectAsState()
    /** This screen started a sign-in: only then do its outcomes show here. */
    var signing by remember { mutableStateOf(false) }
    /** The account picked, or just signed in to: its repositories are read (A1616). */
    var picked by remember { mutableStateOf<app.penmoss.feedback.GitHubAccount?>(null) }
    /** Add Another Account: the sign-in screen, with the other accounts kept. */
    var adding by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { deps.signIn?.reset() }
    LaunchedEffect(asked) {
        val accounts = deps.accounts()
        val account = picked ?: accounts.singleOrNull()?.takeIf { !choose }
        if (account == null && accounts.isNotEmpty() && !adding) {
            check = Check.Choose(accounts)
            return@LaunchedEffect
        }
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
    fun withAccount(account: app.penmoss.feedback.GitHubAccount?) {
        picked = account
        adding = account == null
        again()
    }
    fun signIn() {
        signing = true
        // GitHub's page opens only once the code is on screen (Ryan's Android feedback, 15 Nov 2026):
        // opened at once, a phone shows the browser over the code, with nothing saying to come back.
        deps.signIn?.start(scope) {}
    }
    // In the screen, not the footer: a phone's footer holds Back and one button (A1404 on Android).
    val urlInstead = @Composable { Link("Paste a URL Instead", "first-run-url-instead", "link", onUrl) }
    val signInButton = @Composable { words: String ->
        if (deps.signIn?.available == true) Primary(words, "first-run-signin", "log-in", onClick = ::signIn)
        else Primary("Try Again", "first-run-retry", "refresh-cw", onClick = ::again)
    }

    if (typing) {
        Frame(
            "github-token",
            "Use a Token",
            step = 2,
            back = { typing = false },
            actions = {
                Primary(if (tokenBusy) "Checking…" else "Continue", "first-run-token-continue", "arrow-right", enabled = token.isNotBlank(), busy = tokenBusy) {
                    tokenBusy = true
                    tokenProblem = null
                    scope.launch {
                        val typed = token.trim()
                        val (hub, error) = readHub(deps.browse, typed, null)
                        tokenBusy = false
                        if (hub != null) {
                            deps.saveToken(typed, hub.login)
                            onReady(hub)
                        } else {
                            tokenProblem = error!!.message
                        }
                    }
                }
            },
        ) {
            Lead("A personal access token from GitHub. Penmoss lists your repositories with it, and each notebook you add here syncs with it. It is kept with the Android Keystore.")
            OutlinedTextField(
                token,
                { token = it; tokenProblem = null },
                Modifier.fillMaxWidth().testTag("first-run-token"),
                label = { Text("Personal Access Token") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            )
            tokenProblem?.let { Problem(it, "first-run-token-problem") }
            Lead("A classic token with the repo scope lists every repository; a fine-grained one, only those it names (with Contents read and write, and Administration to make one).", small = true)
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
                    actions = { Primary("Continue", "first-run-continue", "arrow-right") { withAccount(app.penmoss.feedback.GitHubAccount(state.login, primary = false)) } },
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
                        Primary("Copy Code and Open GitHub", "github-signin-open", "external-link") {
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
                        Link("Cancel", "github-signin-cancel", "x") { deps.signIn?.cancel() }
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
                            onClick = { deps.copy(state.userCode) },
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
                        Link("Use a Token Instead", "first-run-use-token", "key-round") { typing = true }
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
        is Check.Choose -> {
            val add = "add"
            fun keyOf(account: app.penmoss.feedback.GitHubAccount) = "account:${account.login.orEmpty()}"
            var choice by remember(now) { mutableStateOf(keyOf(now.accounts.first())) }
            Frame(
                "github-account",
                "Pick GitHub Account",
                step = 2,
                back = back,
                actions = {
                    Primary("Continue", "first-run-continue", "arrow-right") {
                        withAccount(now.accounts.firstOrNull { keyOf(it) == choice })
                    }
                },
                below = { urlInstead() },
            ) {
                Lead("Which account’s repositories? A notebook syncs as the account you add it with.")
                Options(
                    choice,
                    now.accounts.map { account ->
                        Option(
                            keyOf(account),
                            account.login?.let { "@$it" } ?: "Token (Account Not Named)",
                            if (account.primary) "Your first account; Send Feedback uses it" else "Signed in on this phone",
                            "first-run-account-${account.login.orEmpty()}",
                        )
                    } + Option(add, "Add Another Account", "Sign in to GitHub as someone else, such as your work account", "first-run-account-add"),
                ) { choice = it }
            }
        }
        // 2.3: no GitHub sign-in on this phone yet, or Add Another Account (A1616).
        Check.NoSignIn -> Frame(
            "github",
            if (adding) "Add GitHub Account" else "Sign In to GitHub",
            step = 2,
            // Back from Add Another Account goes back to the accounts.
            back = if (adding) ({ adding = false; picked = null; again() }) else back,
            actions = { signInButton("Sign In with GitHub") },
            below = {
                Link("Use a Token Instead", "first-run-use-token", "key-round") { typing = true }
                urlInstead()
            },
        ) {
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
                        Link("Try Again", "first-run-retry", "refresh-cw", ::again)
                        Link("Use a Token Instead", "first-run-use-token", "key-round") { typing = true }
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
                    actions = { Primary("Try Again", "first-run-retry", "refresh-cw", onClick = ::again) },
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
