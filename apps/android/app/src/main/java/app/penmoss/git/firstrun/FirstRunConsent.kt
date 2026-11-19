package app.penmoss.git.firstrun

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import kotlinx.coroutines.launch
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.penmoss.analytics.AnalyticsCopy
import app.penmoss.analytics.ConsentAnswer
import app.penmoss.analytics.trackedClick
import app.penmoss.analytics.trackedId
import app.penmoss.ui.common.OutlinedButton
import app.penmoss.ui.common.roles

/** Penmoss's privacy policy, which the question links to. */
const val PRIVACY_POLICY_URL = "https://penmoss.app/privacy/"

/**
 * The usage question (PEN-137, AC4, AC9): Penmoss keeps a record of what is done in it, by name,
 * on this phone, and the answer decides only whether it leaves. The first run's last step
 * ([lastStep], "Last Step" in the step bar's place), and once before Home on a phone that had a
 * notebook before the question existed. Share Usage Data and Don't Share are equal: the same
 * style, neither chosen first, and Back does nothing, so only an answer moves on.
 */
@Composable
fun ConsentStep(lastStep: Boolean, busy: Boolean = false, onAnswer: (ConsentAnswer) -> Unit, openUrl: (String) -> Unit) {
    BackHandler { }
    Frame(
        "consent",
        AnalyticsCopy.text("consent.title"),
        stepLabel = if (lastStep) AnalyticsCopy.text("consent.lastStep.label") else null,
        below = {
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Answer(AnalyticsCopy.text("consent.share.button"), "consent-share", "consent.share", busy) { onAnswer(ConsentAnswer.YES) }
                Answer(AnalyticsCopy.text("consent.dontShare.button"), "consent-dont-share", "consent.dont-share", busy) { onAnswer(ConsentAnswer.NO) }
            }
        },
    ) {
        Lead(AnalyticsCopy.text("consent.body"), Modifier.testTag("consent-body"))
        Points(AnalyticsCopy.text("consent.recorded.title"), (1..4).map { AnalyticsCopy.text("consent.recorded.$it") }, "consent-recorded")
        Points(AnalyticsCopy.text("consent.never.title"), (1..3).map { AnalyticsCopy.text("consent.never.$it") }, "consent-never")
        Lead(AnalyticsCopy.text("consent.later"), small = true)
        Link(AnalyticsCopy.text("consent.policy.label"), "consent-policy", "external-link", event = "consent.policy") { openUrl(PRIVACY_POLICY_URL) }
    }
}

/** One of the two answers: the same outlined button for both, the full width. */
@Composable
private fun Answer(text: String, tag: String, id: String, busy: Boolean, onClick: () -> Unit) {
    OutlinedButton(
        onClick = trackedClick(id, onClick),
        enabled = !busy,
        modifier = Modifier.fillMaxWidth().testTag(tag).trackedId(id),
    ) { Text(text, maxLines = 1, overflow = TextOverflow.Ellipsis) }
}

/** A short titled list; an empty line (the Mac's own) is left out. */
@Composable
private fun Points(title: String, lines: List<String>, tag: String) {
    Column(Modifier.fillMaxWidth().testTag(tag), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(title, Modifier.semantics { heading() }, style = MaterialTheme.roles.rowLabel)
        for (line in lines.filter { it.isNotEmpty() }) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("•", style = MaterialTheme.roles.body, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(line, style = MaterialTheme.roles.body)
            }
        }
    }
}

/**
 * Home, once the usage question is answered (PEN-137, AC9): a phone that had notebooks before the
 * question existed is asked it once, as a full screen, before [content]; nothing shows until the
 * answer is read, so neither flashes past. Without analytics (tests) it is [content] alone.
 */
@Composable
fun ConsentGate(analytics: app.penmoss.analytics.AnalyticsService?, openUrl: (String) -> Unit, content: @Composable () -> Unit) {
    if (analytics == null) {
        content()
        return
    }
    val consent by analytics.state.collectAsState()
    val scope = rememberCoroutineScope()
    var answering by remember { mutableStateOf(false) }
    when {
        consent == null -> Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background))
        consent?.answered != true -> ConsentStep(
            lastStep = false,
            busy = answering,
            onAnswer = { answer ->
                answering = true
                scope.launch {
                    runCatching { analytics.answer(answer, app.penmoss.BuildConfig.VERSION_NAME) }
                    answering = false
                }
            },
            openUrl = openUrl,
        )
        else -> content()
    }
}
