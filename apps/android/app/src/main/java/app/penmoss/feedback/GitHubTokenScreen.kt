package app.penmoss.feedback

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
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
import app.penmoss.AppGraph
import app.penmoss.ui.settings.Help
import app.penmoss.ui.settings.SectionScreen
import app.penmoss.ui.square.Button
import app.penmoss.ui.square.TextButton
import kotlinx.coroutines.launch

/**
 * Settings → About → GitHub Token (A1012): the person's own token, which Send feedback files the
 * issue with. Saving checks it with GitHub first and says plainly what it found; a token GitHub
 * does not accept is not kept. Never shown again once saved, never logged.
 */
class GitHubTokenModel(
    private val store: GitHubTokenStore,
    private val check: suspend (String) -> TokenCheck,
    private val repo: String,
) {
    /** What Save came to: the words said, and whether the token was kept. */
    data class Saved(val kept: Boolean, val message: String)

    suspend fun save(candidate: String): Saved {
        val token = candidate.trim()
        if (token.isEmpty()) return Saved(false, "Enter a token first.")
        return when (val found = check(token)) {
            is TokenCheck.Ok -> {
                store.save(token, found.login)
                Saved(true, "Saved. ${found.login?.let { "GitHub knows it as @$it, and it" } ?: "It"} can open issues in $repo. Feedback waiting on this phone is sent now.")
            }
            is TokenCheck.Problem -> when (found.problem) {
                // Not kept: it would never file anything.
                TokenCheck.INVALID -> Saved(false, "${found.message} It was not saved.")
                // Kept: its permissions can be changed on GitHub without a new token.
                TokenCheck.CANNOT_FILE -> {
                    store.save(token, found.login)
                    Saved(true, "Saved${found.login?.let { " (@$it)" }.orEmpty()}, but: ${found.message}")
                }
                else -> {
                    store.save(token, found.login)
                    Saved(true, "Saved. GitHub could not be reached to check it (${found.message.trimEnd('.')}); feedback is sent once it can be.")
                }
            }
        }
    }

    fun remove(): String {
        store.clear()
        return "Removed. Feedback waits on this phone until you add a token again."
    }
}

@Composable
fun GitHubTokenRoute(graph: AppGraph, onBack: () -> Unit) {
    val store = graph.githubToken
    val model = remember(store) { GitHubTokenModel(store, graph.githubFeedback::checkToken, graph.githubFeedback.repo) }
    GitHubTokenScreen(
        saved = { store.hasToken },
        login = { store.login() },
        repo = graph.githubFeedback.repo,
        onSave = model::save,
        onRemove = model::remove,
        onBack = onBack,
    )
}

@Composable
fun GitHubTokenScreen(
    saved: () -> Boolean,
    login: () -> String?,
    repo: String,
    onSave: suspend (String) -> GitHubTokenModel.Saved,
    onRemove: () -> String,
    onBack: () -> Unit,
) {
    var token by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var hasToken by remember { mutableStateOf(saved()) }
    var account by remember { mutableStateOf(login()) }
    val scope = rememberCoroutineScope()
    SectionScreen("GitHub Token", onBack) {
        Help(
            "Send Feedback files the issue in $repo with your own GitHub token: a classic token with the public_repo scope or, as a collaborator, " +
                "a fine-grained token for $repo with Issues and Contents (read and write). It stays on this phone, encrypted by the Android Keystore, and is kept when you sign out.",
        )
        Text(
            when {
                !hasToken -> "No token saved: feedback waits on this phone until you add one."
                account != null -> "Saved, for GitHub account @$account."
                else -> "Saved."
            },
            Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("githubTokenState"),
            style = MaterialTheme.typography.bodyLarge,
        )
        OutlinedTextField(
            token,
            { token = it.trim() },
            Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("githubTokenField"),
            label = { Text(if (hasToken) "Token (saved; type a new one to replace it)" else "Token") },
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
                        hasToken = saved()
                        account = login()
                        busy = false
                    }
                },
                enabled = token.isNotEmpty() && !busy,
                modifier = Modifier.testTag("githubTokenSave"),
            ) { Text(if (busy) "Checking…" else "Save") }
            if (hasToken) {
                TextButton(
                    onClick = {
                        message = onRemove()
                        hasToken = saved()
                        account = login()
                    },
                    enabled = !busy,
                    modifier = Modifier.testTag("githubTokenRemove"),
                ) { Text("Remove") }
            }
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
