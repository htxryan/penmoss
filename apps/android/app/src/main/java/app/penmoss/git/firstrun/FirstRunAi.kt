package app.penmoss.git.firstrun

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.common.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.penmoss.ai.AiResult
import app.penmoss.ui.common.roles
import kotlinx.coroutines.launch

/*
 * AI Descriptions on the phone's first run (PEN-161, A1656), as the Mac's `FirstRunAi.tsx`:
 * asked once, after Setting Up, "Describe Notes for Agents?", with Not Now picked. Turn On asks
 * for the Anthropic key, checked and kept before anything goes on; Skip leaves the phone's notes
 * for the Mac to describe once they sync.
 */

/** What the first run's AI step needs of the app. */
class FirstRunAi(
    /** This phone has not been asked yet. */
    val pending: () -> Boolean,
    /** Asked: not asked again on this phone. */
    val asked: () -> Unit,
    /** Checks the key with Anthropic and keeps it only if Anthropic takes it. */
    val saveKey: suspend (String) -> AiResult,
    /** Anthropic for this phone, and Describe Notes on (synced). */
    val turnOn: () -> Unit,
)

/** Describe Notes for Agents?: Turn On for All Notes, or Not Now (the default). */
@Composable
internal fun AiQuestionStep(onNext: (on: Boolean) -> Unit) {
    var choice by rememberSaveable { mutableStateOf("off") }
    Frame(
        "ai",
        "Describe Notes for Agents?",
        step = 3,
        actions = {
            Primary(if (choice == "on") "Continue" else "Start Writing", "first-run-continue", "arrow-right") { onNext(choice == "on") }
        },
    ) {
        Lead("AI writes a short description into each note’s frontmatter, so agents see what a note holds before opening it.")
        Options(
            choice,
            listOf(
                Option("on", "Turn On for All Notes", "Next, your Anthropic API key. Any notebook, folder or note can still say Off.", "first-run-ai-on"),
                Option("off", "Not Now", "It stays off. Settings → AI Descriptions turns it on later.", "first-run-ai-off"),
            ),
        ) { choice = it }
        Lead("A note’s text is sent to Anthropic. Nothing is sent while descriptions are off.", small = true)
    }
}

/**
 * Which AI Should Write Descriptions?: on the phone, Anthropic with a key, checked here; or Skip,
 * which leaves the phone's notes for the Mac to describe after they sync.
 */
@Composable
internal fun AiKeyStep(ai: FirstRunAi, back: () -> Unit, onDone: () -> Unit) {
    var key by rememberSaveable { mutableStateOf("") }
    var said by rememberSaveable { mutableStateOf<String?>(null) }
    var saved by rememberSaveable { mutableStateOf(false) }
    var busy by rememberSaveable { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Frame(
        "ai-provider",
        "Which AI Should Write Descriptions?",
        step = 3,
        back = back,
        actions = {
            Plain("Skip", "first-run-ai-skip", "arrow-right", event = "firstrun.ai.skip") { onDone() }
            Primary("Turn On and Start Writing", "first-run-continue", "check", enabled = saved) {
                ai.turnOn()
                onDone()
            }
        },
    ) {
        Lead("Anthropic, with your API key: calls go straight to Anthropic and are billed to the key. It stays on this phone, sealed by Android’s keystore.")
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = key,
                onValueChange = {
                    key = it
                    said = null
                },
                label = { Text("Anthropic API Key") },
                placeholder = { Text("sk-ant-…") },
                singleLine = true,
                enabled = !saved && !busy,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth().testTag("first-run-ai-key"),
            )
            Plain("Check Key", "first-run-ai-check-key", "check", enabled = !saved && !busy && key.isNotBlank(), event = "firstrun.ai.check-key") {
                busy = true
                said = "Checking…"
                scope.launch {
                    val answer = ai.saveKey(key)
                    busy = false
                    if (answer is AiResult.Text) {
                        saved = true
                        key = ""
                        said = "Anthropic accepted the key. It’s kept on this phone, sealed."
                    } else {
                        said = (answer as AiResult.Failed).message
                    }
                }
            }
            said?.let {
                Text(
                    it,
                    Modifier.testTag("first-run-ai-key-state"),
                    style = MaterialTheme.roles.help,
                    color = if (saved || busy) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                )
            }
        }
        Lead("Skip, and your Mac describes this phone’s notes once they sync. Settings → AI Descriptions sets up a key later.", small = true)
    }
}
