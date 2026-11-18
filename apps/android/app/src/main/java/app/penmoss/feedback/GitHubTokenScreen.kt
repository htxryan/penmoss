package app.penmoss.feedback

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.common.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.penmoss.NotebookGraph
import app.penmoss.ui.common.Button
import app.penmoss.ui.settings.Help
import app.penmoss.ui.settings.SectionScreen
import kotlinx.coroutines.launch

/**
 * Settings → GitHub → Use a Token Instead… or Add with a Token… (A1012; PEN-146): the person's own token, which Send feedback files the
 * issue with. Saving checks it with GitHub first and says plainly what it found; a token GitHub
 * does not accept is not kept. Never shown again once saved, never logged.
 */
class GitHubTokenModel(
    private val store: GitHubTokenStore,
    private val check: suspend (String) -> TokenCheck,
    private val repo: String,
) {
    /** What Save came to: the words said, whether the token was kept, and as whose account. */
    data class Saved(val kept: Boolean, val message: String, val login: String? = null)

    suspend fun save(candidate: String): Saved {
        val token = candidate.trim()
        if (token.isEmpty()) return Saved(false, "Enter a token first.")
        return when (val found = check(token)) {
            is TokenCheck.Ok -> {
                store.save(token, found.login)
                // Another account beside the primary (A1616) files no feedback: say only whose it is.
                if (!isPrimary(found.login)) Saved(true, addedAccount(found.login), found.login)
                else Saved(true, "Saved. ${found.login?.let { "GitHub knows it as @$it, and it" } ?: "It"} can open issues in $repo. Feedback waiting on this phone is sent now.", found.login)
            }
            is TokenCheck.Problem -> when (found.problem) {
                // Not kept: it would never file anything.
                TokenCheck.INVALID -> Saved(false, "${found.message} It was not saved.")
                // Kept: its permissions can be changed on GitHub without a new token.
                TokenCheck.CANNOT_FILE -> {
                    store.save(token, found.login)
                    Saved(true, savedButCannotFile(found.login, found.message), found.login)
                }
                else -> {
                    store.save(token, found.login)
                    Saved(true, "Saved. GitHub could not be reached to check it (${found.message.trimEnd('.')}); feedback is sent once it can be.")
                }
            }
        }
    }

    private fun isPrimary(login: String?) = store.login() == login

    private fun addedAccount(login: String?) = "Added ${login?.let { "@$it" } ?: "the account"} beside your other GitHub accounts. Add Notebook’s account switcher lists it."

    /** A token that can't file feedback: that matters only for the primary account (A1616). */
    private fun savedButCannotFile(login: String?, message: String) =
        if (!isPrimary(login)) addedAccount(login) else "Saved${login?.let { " (@$it)" }.orEmpty()}, but: $message"

}

@Composable
fun GitHubTokenRoute(graph: app.penmoss.DeviceGraph, onBack: () -> Unit) {
    val store = graph.githubToken
    val model = remember(store) { GitHubTokenModel(store, graph.githubFeedback::checkToken, graph.githubFeedback.repo) }
    GitHubTokenScreen(
        accounts = { store.accounts() },
        repo = graph.githubFeedback.repo,
        onSave = model::save,
        onBack = onBack,
    )
}

/**
 * Adds a GitHub account by its token (Ryan's Android feedback, 18 Nov 2026): it never replaces
 * another account, so it shows no saved token and no Remove; each account's own ⋮ signs it out.
 */
@Composable
fun GitHubTokenScreen(
    accounts: () -> List<GitHubAccount>,
    repo: String,
    onSave: suspend (String) -> GitHubTokenModel.Saved,
    onBack: () -> Unit,
) {
    var token by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var here by remember { mutableStateOf(accounts()) }
    val scope = rememberCoroutineScope()
    val adding = here.isNotEmpty()
    SectionScreen(if (adding) "Add Account with a Token" else "GitHub Token", onBack) {
        Help(
            if (adding) {
                "A personal access token of your own, instead of signing in. It is added as the GitHub account it belongs to, " +
                    "beside ${here.joinToString { it.login?.let { login -> "@$login" } ?: "your token" }}; " +
                    "a token for an account already here renews that one. It stays on this phone, encrypted by the Android Keystore."
            } else {
                "Instead of signing in, give Penmoss a token of your own. Send Feedback files the issue in $repo with it: a classic token with the public_repo scope or, as a collaborator, " +
                    "a fine-grained token for $repo with Issues and Contents (read and write). It stays on this phone, encrypted by the Android Keystore."
            },
        )
        if (adding) {
            Text(
                "To list a notebook’s repositories, a classic token needs the repo scope; a fine-grained one, Contents (read and write) on those repositories.",
                Modifier.padding(horizontal = 16.dp, vertical = 4.dp).testTag("githubTokenScopes"),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        OutlinedTextField(
            token,
            { token = it.trim() },
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).testTag("githubTokenField"),
            label = { Text("Token") },
            singleLine = true,
            enabled = !busy,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
        Row(Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    busy = true
                    message = "Checking it with GitHub…"
                    scope.launch {
                        val done = onSave(token)
                        if (done.kept) token = ""
                        message = done.message
                        here = accounts()
                        busy = false
                    }
                },
                enabled = token.isNotEmpty() && !busy,
                modifier = Modifier.testTag("githubTokenSave"),
            ) { Labelled(if (adding) "user-plus" else "save", if (busy) "Checking…" else if (adding) "Add Account" else "Save") }
        }
        message?.let {
            Text(
                it,
                Modifier.padding(horizontal = 16.dp, vertical = 4.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("githubTokenMessage"),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}
