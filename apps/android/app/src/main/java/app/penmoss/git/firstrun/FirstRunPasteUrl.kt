package app.penmoss.git.firstrun

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import app.penmoss.engine.git.AddResult
import app.penmoss.engine.git.GitRefusal
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/* The first run by address: Paste a URL, and naming a notebook a repository does not hold yet; split from FirstRunRepos.kt (PEN-186). */

/**
 * Paste a URL: any HTTPS git repository. A github.com address uses the phone's GitHub sign-in
 * when it has one, else a token typed here. Added without a name, it opens the notebook the
 * address holds, or asks for a name when it holds none.
 */
@Composable
internal fun PasteUrl(deps: FirstRunDeps, add: suspend (Place, String?) -> AddResult, onAdded: (Setup) -> Unit, onName: (Place) -> Unit, back: () -> Unit) {
    var remote by remember { mutableStateOf("") }
    var branch by remember { mutableStateOf("main") }
    var dir by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val signedIn = remember { deps.token() }
    val github = isGitHub(remote)
    val usesSignIn = github && signedIn != null && token.isBlank()
    fun check() {
        if (busy || remote.isBlank()) return
        busy = true
        problem = null
        val address = remote.trim()
        val folder = dir.trim().trim('/')
        val place = Place(
            remote = address,
            branch = branch.trim().ifEmpty { "main" },
            dir = folder,
            label = address.removePrefix("https://").removeSuffix(".git"),
            token = token.trim().ifEmpty { if (github) signedIn else null },
            suggested = nameFromRepo(if (folder.isNotEmpty()) folder.substringAfterLast('/') else repoNameOf(address)),
        )
        scope.launch {
            try {
                when (val result = add(place, null)) {
                    AddResult.NeedsName -> onName(place)
                    is AddResult.Added -> onAdded(Setup.Added(place, result.notebook.name, result.notebook.localId))
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: GitRefusal) {
                problem = error.message
            } catch (error: Exception) {
                problem = error.message ?: "Penmoss could not add the notebook."
            } finally {
                busy = false
            }
        }
    }
    Frame(
        "url",
        "Paste a URL",
        step = 2,
        back = back,
        actions = {
            Primary(
                when {
                    busy -> "Checking…"
                    problem != null -> "Try Again"
                    else -> "Continue"
                },
                "first-run-continue", "arrow-right",
                enabled = remote.isNotBlank(),
                busy = busy,
                onClick = ::check,
                event = "firstrun.continue",
            )
        },
    ) {
        OutlinedTextField(
            remote,
            { remote = it; problem = null },
            Modifier.fillMaxWidth().testTag("first-run-url-input"),
            label = { Text("Repository URL") },
            placeholder = { Text("https://github.com/you/notes") },
            isError = problem != null,
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        )
        Lead("The https:// address of a git repository. Android syncs over HTTPS only.", small = true)
        OutlinedTextField(
            token,
            { token = it; problem = null },
            Modifier.fillMaxWidth().testTag("first-run-url-token"),
            label = { Text(if (github && signedIn != null) "Personal Access Token (Optional)" else "Personal Access Token") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
        Lead(
            if (usesSignIn) {
                "Uses your GitHub sign-in${deps.login()?.let { " ($it)" }.orEmpty()}."
            } else {
                "GitHub: a fine-grained token with Contents read and write and Metadata read on that repository. Kept with the Android Keystore."
            },
            Modifier.testTag("first-run-url-token-help"),
            small = true,
        )
        MoreOptions(branch, dir, { branch = it }, { dir = it })
        if (busy) Working("Asking the repository…")
        problem?.let { Problem(it, "first-run-url-problem") }
    }
}

/** Name Your Notebook: a new notebook's name, offered from the repository's. */
@Composable
internal fun NameNotebook(place: Place, onMake: (String) -> Unit, back: () -> Unit) {
    var name by remember { mutableStateOf(place.suggested) }
    Frame(
        "name",
        "Name Your Notebook",
        step = 3,
        back = back,
        actions = { Primary("Make Notebook", "first-run-make", "plus", enabled = name.isNotBlank(), event = "firstrun.name.make-notebook") { onMake(name.trim()) } },
    ) {
        Lead("It shows in your list of notebooks.")
        NameField(name, "first-run-name-input") { name = it }
        PlaceCard(place.label, place.dir, place.branch)
    }
}
