package app.penmoss.feedback

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.ui.semantics.heading
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.penmoss.NotebookGraph
import app.penmoss.ui.common.Button
import app.penmoss.ui.common.roles
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
    SectionScreen(githubTokenTitle(remember { store.accounts() }), onBack) {
        GitHubTokenForm(store::accounts, graph.githubFeedback.repo, model::save, Modifier.padding(horizontal = 16.dp))
    }
}

/** The token page's title, the same in Settings → GitHub and in Add Notebook. */
fun githubTokenTitle(accounts: List<GitHubAccount>) = if (accounts.isEmpty()) "Use a Token" else "Add Account with a Token"

/** GitHub's page for a new classic token, with the repo scope ticked and Penmoss named. */
const val NEW_TOKEN_URL = "https://github.com/settings/tokens/new?scopes=repo&description=Penmoss"

/**
 * The token page (Ryan's Android feedback, 18 Nov 2026: one page, not two; then option 1 of the
 * Token Page Options canvas, Three Steps): Settings → GitHub's Add with a Token… and Add
 * Notebook's both show this, in their own frame. Make a token on GitHub (the permissions as a
 * list, and Open GitHub), paste it, add the account. A token is added as the account it belongs
 * to and never replaces another; each account's ⋮ signs it out. [onAdded] takes over once a
 * token is kept (Add Notebook reads its repositories); without it, the page says what Save came to.
 */
@Composable
fun GitHubTokenForm(
    accounts: () -> List<GitHubAccount>,
    /** Send Feedback's repository: its permissions are named when this token would file feedback. */
    feedbackRepo: String?,
    onSave: suspend (String) -> GitHubTokenModel.Saved,
    modifier: Modifier = Modifier,
    onAdded: ((GitHubTokenModel.Saved) -> Unit)? = null,
) {
    var token by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<GitHubTokenModel.Saved?>(null) }
    var here by remember { mutableStateOf(accounts()) }
    val scope = rememberCoroutineScope()
    val uri = androidx.compose.ui.platform.LocalUriHandler.current
    val colours = MaterialTheme.colorScheme
    androidx.compose.foundation.layout.Column(modifier, verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Text(
            if (here.isEmpty()) "A GitHub token, instead of signing in. Penmoss lists your repositories with it, and your notebooks sync with it."
            else "Use a GitHub token instead of signing in.",
            Modifier.testTag("githubTokenLead"),
            style = MaterialTheme.roles.help,
            color = colours.onSurfaceVariant,
        )
        androidx.compose.foundation.layout.Column {
        TokenStep(1, "Make a Token on GitHub") {
            Permission("Classic Token", "every repository") { Tick { Code("repo") } }
            Permission("Fine-Grained Token", "only the repositories it names") {
                Tick { Text("Contents: Read and Write", style = MaterialTheme.roles.body) }
                Tick {
                    Text("Administration: Read and Write", style = MaterialTheme.roles.body)
                    Text("to make one", style = MaterialTheme.roles.meta, color = colours.onSurfaceVariant)
                }
            }
            if (here.isEmpty() && feedbackRepo != null) {
                Permission("Optional", "Send Feedback to $feedbackRepo") {
                    Tick(glyph = "plus") {
                        Code("public_repo")
                        Text(", or Issues: Read and Write", style = MaterialTheme.roles.body, color = colours.onSurfaceVariant)
                    }
                }
            }
            // Tonal, as the design draws it: raised, with its border and an accent label.
            app.penmoss.ui.common.OutlinedButton(
                onClick = { runCatching { uri.openUri(NEW_TOKEN_URL) } },
                Modifier.testTag("githubTokenOpenGitHub"),
                colors = androidx.compose.material3.ButtonDefaults.outlinedButtonColors(containerColor = colours.surfaceContainerHigh, contentColor = colours.primary),
                border = androidx.compose.foundation.BorderStroke(1.dp, colours.outlineVariant),
            ) {
                Labelled("external-link", "Open GitHub")
            }
        }
        TokenStep(2, "Paste It Here") {
            OutlinedTextField(
                token,
                { token = it.trim(); message = null },
                Modifier.fillMaxWidth().testTag("githubTokenField"),
                label = { Text("Personal Access Token") },
                singleLine = true,
                enabled = !busy,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            )
        }
        TokenStep(3, "Add the Account", last = true) {
            Button(
                onClick = {
                    busy = true
                    message = null
                    scope.launch {
                        val done = onSave(token)
                        busy = false
                        if (done.kept) token = ""
                        if (done.kept && onAdded != null) onAdded(done)
                        else {
                            message = done
                            here = accounts()
                        }
                    }
                },
                enabled = token.isNotEmpty() && !busy,
                modifier = Modifier.testTag("githubTokenSave"),
            ) { Labelled("user-plus", if (busy) "Checking…" else "Add Account") }
            message?.let {
                Text(
                    it.message,
                    Modifier.semantics { liveRegion = LiveRegionMode.Polite }.testTag("githubTokenMessage"),
                    style = MaterialTheme.roles.body,
                    color = if (it.kept) colours.onSurface else colours.error,
                )
            }
            if (here.isNotEmpty()) {
                // The accounts it joins stand out from the words around them, as the design draws them.
                val joins = androidx.compose.ui.text.buildAnnotatedString {
                    append("Joins ")
                    here.forEachIndexed { i, a ->
                        if (i > 0) append(" and ")
                        withStyle(androidx.compose.ui.text.SpanStyle(color = colours.onSurface)) { append(a.login?.let { "@$it" } ?: "your token") }
                    }
                    append(".")
                }
                Note("user-plus", joins, "githubTokenBeside")
                Note("refresh-cw", "Already here? It renews that account.")
            }
            Note("lock", "Kept on this phone, encrypted by the Android Keystore.")
        }
        }
    }
}

/**
 * One numbered step, as option 1 draws it: its number in an accent circle, a rail down to the
 * next step, its title, then what it holds.
 */
@Composable
private fun TokenStep(number: Int, title: String, last: Boolean = false, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    val colours = MaterialTheme.colorScheme
    Row(Modifier.height(androidx.compose.foundation.layout.IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        androidx.compose.foundation.layout.Column(Modifier.fillMaxHeight(), horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally) {
            androidx.compose.foundation.layout.Box(
                Modifier.size(28.dp).background(colours.primary, androidx.compose.foundation.shape.CircleShape),
                contentAlignment = androidx.compose.ui.Alignment.Center,
            ) { Text("$number", style = MaterialTheme.roles.listHead.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Bold), color = colours.onPrimary) }
            if (!last) androidx.compose.foundation.layout.Box(Modifier.padding(vertical = 4.dp).width(2.dp).weight(1f).background(colours.outlineVariant))
        }
        androidx.compose.foundation.layout.Column(
            Modifier.weight(1f).padding(bottom = if (last) 0.dp else 16.dp),
            verticalArrangement = Arrangement.spacedBy(if (last) 10.dp else 8.dp),
        ) {
            Text(title, Modifier.semantics { heading() }, style = MaterialTheme.roles.groupHead, color = colours.onSurface)
            content()
        }
    }
}

/** A kind of token and what it reaches, over the permissions to tick. */
@Composable
private fun Permission(kind: String, reaches: String, ticks: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    androidx.compose.foundation.layout.Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text("$kind · $reaches", style = MaterialTheme.roles.meta.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Medium), color = MaterialTheme.colorScheme.onSurfaceVariant)
        ticks()
    }
}

/** A permission to tick: a green check (or a muted plus, for an optional one), then its name. */
@Composable
private fun Tick(glyph: String = "check", words: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    val colours = MaterialTheme.colorScheme
    val tint = if (glyph == "check") tickGreen() else colours.onSurfaceVariant
    Row(Modifier.padding(vertical = 1.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        app.penmoss.ui.common.rememberLucideIcons()?.icon(glyph)?.let {
            androidx.compose.material3.Icon(app.penmoss.ui.common.LucideAssets.vector(it), contentDescription = null, Modifier.size(20.dp), tint = tint)
        }
        words()
    }
}

/** A permission's own name, as code. */
@Composable
private fun Code(name: String) {
    val colours = MaterialTheme.colorScheme
    Text(
        name,
        Modifier
            .background(colours.surfaceContainerHigh, androidx.compose.foundation.shape.RoundedCornerShape(4.dp))
            .border(1.dp, colours.outlineVariant, androidx.compose.foundation.shape.RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp),
        style = MaterialTheme.roles.body.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, fontSize = androidx.compose.ui.unit.TextUnit(13f, androidx.compose.ui.unit.TextUnitType.Sp)),
    )
}

/** The theme has no green; this is the design's, darker on a light page so it still reads. */
@Composable
private fun tickGreen(): androidx.compose.ui.graphics.Color =
    if (MaterialTheme.colorScheme.background.luminance() < 0.5f) androidx.compose.ui.graphics.Color(0xFF93D3A2)
    else androidx.compose.ui.graphics.Color(0xFF2E7D4F)

/** A short line with its icon, under the button. */
@Composable
private fun Note(icon: String, words: String, tag: String? = null) = Note(icon, androidx.compose.ui.text.AnnotatedString(words), tag)

@Composable
private fun Note(icon: String, words: androidx.compose.ui.text.AnnotatedString, tag: String? = null) {
    Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
        app.penmoss.git.firstrun.ButtonIcon(icon)
        Text(words, if (tag != null) Modifier.testTag(tag) else Modifier, style = MaterialTheme.roles.help, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
