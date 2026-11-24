package app.penmoss.git

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import app.penmoss.ui.common.Button
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import app.penmoss.ui.common.OutlinedTextField
import androidx.compose.material3.Text
import app.penmoss.ui.common.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.size
import androidx.compose.ui.semantics.Role
import app.penmoss.ui.common.roles
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.trackedClick
import app.penmoss.ui.settings.GroupTitle
import app.penmoss.ui.settings.settingRow
import app.penmoss.ui.common.ConfirmDialog

/* The commit identity and the signing key the phone signs its commits with; split from GitNotebooksScreen.kt (PEN-186). */

/**
 * Asks before a new signing key replaces this phone's (#174 delta review): it is one key for every
 * notebook here, and the old one is deleted from the Keystore. Nothing in a repository changes,
 * so no fingerprint is asked; the words name the notebooks that sign and say to add the new
 * public key to GitHub.
 */
@Composable
internal fun NewSigningKey(
    type: app.penmoss.engine.git.CommitKeyType?,
    ui: GitNotebooksUi,
    onDismiss: () -> Unit,
    onConfirm: (app.penmoss.engine.git.CommitKeyType) -> Unit,
) {
    if (type == null) return
    val ed25519 = type == app.penmoss.engine.git.CommitKeyType.ED25519
    val kind = if (ed25519) "an Ed25519" else "a new P-256"
    val signing = ui.rows.filter { it.view.signCommits }.map { it.view.name }
    val who = when (signing.size) {
        0 -> "No notebook signs commits now; any you turn Sign commits on for uses it."
        1 -> "${signing.single()} signs with it from its next commit."
        else -> "${signing.dropLast(1).joinToString(", ")} and ${signing.last()} sign with it from their next commits."
    }
    ConfirmDialog(
        title = "Make ${if (ed25519) "an Ed25519" else "a New P-256"} Signing Key?",
        body = "This deletes this phone's signing key and makes $kind key in its place, for every git notebook on this phone. $who " +
            "Its commits show Unverified on GitHub until you add its public key to GitHub as a signing key (Settings → SSH and GPG keys); remove the old key there afterwards. Nothing in the repositories changes.",
        confirmLabel = "Make the Key",
        confirmEvent = "settings.git-notebooks.signing-key.new.confirm",
        cancelEvent = "settings.git-notebooks.signing-key.new.cancel",
        onConfirm = { onConfirm(type) },
        onDismiss = onDismiss,
        confirmTag = "gitSigningKeyConfirm",
        cancelTag = "gitSigningKeyCancel",
        bodyTag = "gitSigningKeyWords",
    )
}

/**
 * Commit Identity (PEN-146; the Mac's words, PEN-10): the name and email this phone commits as,
 * and its signing key, one row that opens in place. A notebook's own name and email are on its Git
 * tab.
 */
@Composable
internal fun CommitIdentity(ui: GitNotebooksUi, actions: GitNotebooksActions) {
    var open by rememberSaveable { mutableStateOf(false) }
    var name by rememberSaveable(ui.identityName) { mutableStateOf(ui.identityName) }
    var email by rememberSaveable(ui.identityEmail) { mutableStateOf(ui.identityEmail) }
    GroupTitle("Commit Identity", Modifier.settingRow("commit-identity"))
    ListItem(
        headlineContent = { Text(ui.identityName.ifBlank { "No Name Set" }) },
        supportingContent = {
            Text(listOfNotNull(ui.identityEmail.ifBlank { null }, if (ui.signingKey != null) "signing key on this phone" else null).joinToString(" · ").ifEmpty { "Name and email for your commits" })
        },
        trailingContent = { Text(if (open) "⌃" else "›", style = MaterialTheme.roles.rowLabel) },
        modifier = Modifier.testTag("gitCommits").clickable(role = Role.Button, onClick = trackedClick("settings.git-notebooks.commits.toggle") { open = !open }),
    )
    if (!open) return
    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth().testTag("gitIdentityName"), label = { Text("Name") }, singleLine = true)
        OutlinedTextField(email, { email = it }, Modifier.fillMaxWidth().testTag("gitIdentityEmail"), label = { Text("Email") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
        if (name != ui.identityName || email != ui.identityEmail) {
            TextButton(onClick = trackedClick("settings.git-notebooks.identity.save") { actions.onIdentity(name, email) }, Modifier.testTag("gitIdentitySave")) { Text("Save") }
        }
        SigningKey(ui, actions)
    }
}

/** This phone's signing key (#172, A921), with Copy and Make a New Key; nothing until one is made. */
@Composable
internal fun SigningKey(ui: GitNotebooksUi, actions: GitNotebooksActions) {
    val key = ui.signingKey ?: return
    /** The kind of key a tap on Make… asks to make, while its confirmation shows. */
    var making by remember { mutableStateOf<app.penmoss.engine.git.CommitKeyType?>(null) }
    NewSigningKey(making, ui, onDismiss = { making = null }) { type ->
        making = null
        actions.onNewSigningKey(type)
    }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Signing Key", style = MaterialTheme.roles.groupHead)
        Text(
            "Made in this phone's Keystore; it never leaves the phone. Add it to GitHub as a signing key (Settings → SSH and GPG keys → New SSH key, Key type: Signing Key), with your commit email verified on your account, so its commits show Verified.",
            style = MaterialTheme.roles.help,
        )
        Text(key, Modifier.fillMaxWidth().testTag("gitSigningKey"), style = MaterialTheme.roles.code)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = trackedClick("settings.git-notebooks.signing-key.copy") { actions.onCopySigningKey(key) }, Modifier.testTag("gitSigningKeyCopy")) { Text("Copy") }
            TextButton(onClick = trackedClick("settings.git-notebooks.signing-key.new") { making = app.penmoss.engine.git.CommitKeyType.P256 }, Modifier.testTag("gitSigningKeyNew")) { Text("Make a New Key") }
            TextButton(onClick = trackedClick("settings.git-notebooks.signing-key.new-ed25519") { making = app.penmoss.engine.git.CommitKeyType.ED25519 }, Modifier.testTag("gitSigningKeyNewEd25519")) { Text("Make an Ed25519 Key") }
        }
        Text(
            "Make a New Key is P-256, which every phone's Keystore has; Ed25519 works where this phone's Keystore has it, and your key stays as it is where it does not.",
            style = MaterialTheme.roles.help,
        )
    }
}
