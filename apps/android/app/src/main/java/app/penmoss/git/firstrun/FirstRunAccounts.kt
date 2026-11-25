package app.penmoss.git.firstrun

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.rememberTrackedDialog
import app.penmoss.analytics.trackedClick
import app.penmoss.ui.common.roles

/* The first run's GitHub account control and its sheet; split from FirstRunRepos.kt (PEN-186). */

/**
 * Whose repositories these are, as a control (Ryan's pick of option 2 in the account designs,
 * 17 Nov 2026; A1616): the account, then a sheet of every account, Add Another Account, Manage
 * GitHub Accounts (Settings → GitHub's page inside the flow) and Refresh.
 */
@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
internal fun AccountSwitcher(
    login: String?,
    accounts: List<app.penmoss.feedback.GitHubAccount>,
    onPick: (app.penmoss.feedback.GitHubAccount) -> Unit,
    onAdd: (() -> Unit)?,
    onManage: (() -> Unit)?,
    onRefresh: (() -> Unit)?,
) {
    var open by androidx.compose.runtime.saveable.rememberSaveable { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant)
            .background(MaterialTheme.colorScheme.surfaceBright)
            .clickable(role = Role.Button, onClickLabel = "Change GitHub Account", onClick = trackedClick("firstrun.account.open") { open = true })
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .testTag("first-run-account-switcher"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        AccountInitial(login)
        Column(Modifier.weight(1f)) {
            Text(login ?: "GitHub", Modifier.testTag("first-run-via"), style = MaterialTheme.roles.rowLabel)
            Text("Listing this account’s repositories", style = MaterialTheme.roles.help, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        LucideGlyph("chevron-down", contentDescription = null, size = 20.dp)
    }
    if (open) {
        val tracked = rememberTrackedDialog("accounts")
        // A row picked: the sheet did its job, and closes.
        val close = {
            tracked.done()
            open = false
        }
        androidx.compose.material3.ModalBottomSheet(onDismissRequest = { open = false }, modifier = Modifier.testTag("first-run-account-sheet")) {
            Text(
                "GitHub Account",
                Modifier.padding(start = 22.dp, end = 22.dp, bottom = 8.dp),
                style = MaterialTheme.roles.help,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            for (account in accounts) {
                val current = account.login == login
                SheetRow("first-run-switch-${account.login.orEmpty()}", current, event = "firstrun.account", onClose = close, onClick = { if (!current) onPick(account) }) {
                    AccountInitial(account.login)
                    Column(Modifier.weight(1f)) {
                        Text(account.login ?: "Token (Account Not Named)", style = MaterialTheme.roles.rowLabel)
                        Text(
                            if (account.primary) "Send Feedback uses it" else "Signed in on this phone",
                            style = MaterialTheme.roles.help,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (current) LucideGlyph("check", contentDescription = "Listed now", size = 20.dp)
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            onAdd?.let { add ->
                SheetRow("first-run-switch-add", false, event = "firstrun.account.add", onClose = close, onClick = add) {
                    LucideGlyph("user-plus", contentDescription = null)
                    Text("Add Another Account", style = MaterialTheme.roles.rowLabel)
                }
            }
            onManage?.let { manage ->
                SheetRow("first-run-switch-manage", false, event = "firstrun.account.manage", onClose = close, onClick = manage) {
                    LucideGlyph("settings", contentDescription = null)
                    Text("Manage GitHub Accounts", style = MaterialTheme.roles.rowLabel)
                }
            }
            onRefresh?.let { refresh ->
                SheetRow("first-run-refresh", false, event = "firstrun.account.refresh", onClose = close, onClick = refresh) {
                    LucideGlyph("refresh-cw", contentDescription = null)
                    Text("Refresh Repositories", style = MaterialTheme.roles.rowLabel)
                }
            }
            androidx.compose.foundation.layout.Spacer(Modifier.padding(bottom = 16.dp))
        }
    }
}

/** One row of the account sheet: [onClose] closes the sheet, then [onClick] runs; counted as [event]. */
@Composable
private fun SheetRow(tag: String, selected: Boolean, event: String, onClose: () -> Unit, onClick: () -> Unit, content: @Composable () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (selected) MaterialTheme.colorScheme.secondaryContainer else androidx.compose.ui.graphics.Color.Transparent)
            .clickable(role = Role.Button, onClick = trackedClick(event) {
                onClose()
                onClick()
            })
            .padding(horizontal = 22.dp, vertical = 12.dp)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) { content() }
}

/** An account's first letter on a square of colour, so two accounts tell apart at a glance. */
@Composable
private fun AccountInitial(login: String?) {
    val shades = listOf(0xFF2F5E86, 0xFF7A5A2F, 0xFF3F7A4A, 0xFF7A3F6B, 0xFF5A4F8C)
    val shade = androidx.compose.ui.graphics.Color(shades[Math.floorMod((login ?: "").hashCode(), shades.size)])
    androidx.compose.foundation.layout.Box(
        Modifier.size(36.dp).background(shade),
        contentAlignment = Alignment.Center,
    ) {
        Text((login?.firstOrNull() ?: 'G').uppercaseChar().toString(), color = androidx.compose.ui.graphics.Color.White, style = MaterialTheme.roles.rowLabel)
    }
}
