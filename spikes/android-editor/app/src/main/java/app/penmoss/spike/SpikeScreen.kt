package app.penmoss.spike

import android.os.Build
import android.webkit.WebView
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.delay
import org.json.JSONObject

data class StatsSnapshot(val native: JSONObject, val frames: JSONObject, val web: JSONObject?)

private enum class Panel { None, Protocol, Stats, Export, Link }

@Composable
fun SpikeTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val context = LocalContext.current
    val colors = when {
        Build.VERSION.SDK_INT >= 31 && dark -> dynamicDarkColorScheme(context)
        Build.VERSION.SDK_INT >= 31 -> dynamicLightColorScheme(context)
        dark -> darkColorScheme()
        else -> lightColorScheme()
    }
    MaterialTheme(colorScheme = colors, content = content)
}

@Composable
fun SpikeScreen(
    webView: WebView,
    bridge: EditorBridge,
    state: EditorState,
    onStartTest: (String) -> Unit,
    onFocusEditor: () -> Unit,
    statsSource: ((StatsSnapshot) -> Unit) -> Unit,
    onResetFrames: () -> Unit,
) {
    var panel by remember { mutableStateOf(Panel.None) }

    // Record keyboard open/close (IME inset height) in the IME log, debounced.
    val imeBottom = WindowInsets.ime.getBottom(LocalDensity.current)
    LaunchedEffect(imeBottom) {
        delay(200)
        bridge.logNative("ime-inset bottom=${imeBottom}px")
    }

    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surface)) {
        TopBar(
            coldOpenMs = state.coldOpenMs,
            onProtocol = { panel = Panel.Protocol },
            onStats = { panel = Panel.Stats },
            onExport = { panel = Panel.Export },
        )
        AndroidView(factory = { webView }, modifier = Modifier.weight(1f).fillMaxWidth())
        FormatBar(
            state = state,
            onCommand = { command -> bridge.exec(command) },
            onLink = { panel = Panel.Link },
            onCheck = { bridge.checkTest() },
        )
    }

    when (panel) {
        Panel.None -> Unit
        Panel.Protocol -> ProtocolDialog(
            lastResult = state.lastTestSummary,
            onStart = { mode ->
                panel = Panel.None
                onStartTest(mode)
            },
            onDismiss = { panel = Panel.None },
        )
        Panel.Stats -> StatsDialog(statsSource, onResetFrames, onDismiss = { panel = Panel.None })
        Panel.Export -> ExportDialog(
            onExport = { mode ->
                panel = Panel.None
                bridge.requestExport(mode)
            },
            onDismiss = { panel = Panel.None },
        )
        Panel.Link -> LinkDialog(
            hasLink = state.active["link"] == true,
            onApply = { url ->
                panel = Panel.None
                bridge.exec("link", url)
                onFocusEditor()
            },
            onDismiss = {
                panel = Panel.None
                onFocusEditor()
            },
        )
    }
}

@Composable
private fun TopBar(coldOpenMs: Long?, onProtocol: () -> Unit, onStats: () -> Unit, onExport: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainer, tonalElevation = 2.dp) {
        Row(
            Modifier.fillMaxWidth().statusBarsPadding().padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("Penmoss Spike", style = MaterialTheme.typography.titleMedium)
                Text(
                    text = coldOpenMs?.let { "Opened in $it ms" } ?: "Loading note…",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            val compact = PaddingValues(horizontal = 8.dp)
            TextButton(onClick = onProtocol, contentPadding = compact, modifier = Modifier.noFocus()) { Text("Protocol") }
            TextButton(onClick = onStats, contentPadding = compact, modifier = Modifier.noFocus()) { Text("Stats") }
            TextButton(onClick = onExport, contentPadding = compact, modifier = Modifier.noFocus()) { Text("Export log") }
        }
    }
}

/**
 * Pinned above the keyboard: navigationBarsPadding + imePadding pad the bar by the
 * IME height (animated with the keyboard), which shrinks the WebView above it.
 * Buttons never take focus, so the WebView keeps the IME connection.
 */
@Composable
private fun FormatBar(state: EditorState, onCommand: (String) -> Unit, onLink: () -> Unit, onCheck: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Row(
            Modifier.fillMaxWidth()
                .navigationBarsPadding()
                .imePadding()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 6.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (state.testActive) BarButton("Check", highlighted = true, onClick = onCheck)
            BarButton("B", active = state.active["bold"] == true, weight = FontWeight.Bold) { onCommand("bold") }
            BarButton("I", active = state.active["italic"] == true, italic = true) { onCommand("italic") }
            BarButton("• List", active = state.active["bulletList"] == true) { onCommand("bulletList") }
            BarButton("☑ Tasks", active = state.active["taskList"] == true) { onCommand("taskList") }
            BarButton("</> Code", active = state.active["codeBlock"] == true, mono = true) { onCommand("codeBlock") }
            BarButton("Link", active = state.active["link"] == true, onClick = onLink)
            BarButton("Undo", enabled = state.canUndo) { onCommand("undo") }
            BarButton("Redo", enabled = state.canRedo) { onCommand("redo") }
        }
    }
}

@Composable
private fun BarButton(
    label: String,
    active: Boolean = false,
    enabled: Boolean = true,
    highlighted: Boolean = false,
    weight: FontWeight = FontWeight.Medium,
    italic: Boolean = false,
    mono: Boolean = false,
    onClick: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = RoundedCornerShape(10.dp),
        color = when {
            highlighted -> colors.tertiaryContainer
            active -> colors.primaryContainer
            else -> colors.surfaceContainerHigh
        },
        contentColor = if (enabled) colors.onSurface else colors.onSurface.copy(alpha = 0.38f),
        modifier = Modifier.noFocus().heightIn(min = 44.dp).widthIn(min = 44.dp),
    ) {
        Row(Modifier.padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = label,
                fontWeight = weight,
                fontStyle = if (italic) FontStyle.Italic else FontStyle.Normal,
                fontFamily = if (mono) FontFamily.Monospace else FontFamily.Default,
                fontSize = 16.sp,
                modifier = Modifier.padding(vertical = 10.dp),
            )
        }
    }
}

private fun Modifier.noFocus(): Modifier = focusProperties { canFocus = false }

@Composable
private fun ProtocolDialog(lastResult: String?, onStart: (String) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
        title = { Text("T2 test protocol") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                PROTOCOL_STEPS.forEachIndexed { index, step ->
                    Text("${index + 1}. $step", style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(8.dp))
                }
                Text("Test paragraph", style = MaterialTheme.typography.titleSmall)
                SelectionContainer {
                    Text(
                        TEST_PARAGRAPH,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier
                            .padding(vertical = 6.dp)
                            .background(MaterialTheme.colorScheme.surfaceContainerHighest, RoundedCornerShape(8.dp))
                            .padding(10.dp),
                    )
                }
                if (lastResult != null) {
                    Text("Last result: $lastResult", style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(8.dp))
                }
                Text(
                    "Start a typing test (adds a heading and an empty paragraph at the end of the note; type the paragraph, then tap Check):",
                    style = MaterialTheme.typography.titleSmall,
                )
                KEYBOARD_MODES.forEach { mode ->
                    OutlinedButton(onClick = { onStart(mode) }, modifier = Modifier.fillMaxWidth()) { Text(mode) }
                }
            }
        },
    )
}

@Composable
private fun StatsDialog(
    statsSource: ((StatsSnapshot) -> Unit) -> Unit,
    onResetFrames: () -> Unit,
    onDismiss: () -> Unit,
) {
    var text by remember { mutableStateOf("Collecting…") }
    var refresh by remember { mutableStateOf(0) }
    LaunchedEffect(refresh) { statsSource { text = formatStats(it) } }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
        dismissButton = {
            Row {
                TextButton(onClick = {
                    onResetFrames()
                    refresh++
                }) { Text("Reset frames") }
                TextButton(onClick = { refresh++ }) { Text("Refresh") }
            }
        },
        title = { Text("Stats") },
        text = {
            SelectionContainer {
                Text(
                    text,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    modifier = Modifier.verticalScroll(rememberScrollState()),
                )
            }
        },
    )
}

private fun formatStats(s: StatsSnapshot): String = buildString {
    val n = s.native
    appendLine("COLD OPEN (target < 1000 ms)")
    appendLine("  process start → note painted: ${n.opt("processStartToNotePaintedMs")} ms")
    appendLine("  activity create → note painted: ${n.opt("activityCreateToNotePaintedMs")} ms")
    appendLine("  process start → page finished: ${n.opt("processStartToPageFinishedMs")} ms")
    val web = s.web
    if (web == null) {
        appendLine("\nEditor not loaded yet.")
    } else {
        val t = web.optJSONObject("timings") ?: JSONObject()
        appendLine("  web (from navigation start): script ${t.opt("scriptStart")}, editor ready ${t.opt("editorReady")}, painted ${t.opt("notePainted")} ms")
        val lt = web.optJSONObject("longTasks") ?: JSONObject()
        val lf = web.optJSONObject("longAnimationFrames") ?: JSONObject()
        appendLine("\nMAIN THREAD")
        appendLine("  long tasks: ${lt.opt("count")} (total ${lt.opt("totalMs")} ms, worst ${lt.opt("worstMs")} ms)")
        appendLine("  long animation frames: ${lf.opt("count")} (worst ${lf.opt("worstMs")} ms)")
        val scroll = web.optJSONArray("scroll")
        appendLine("\nWEB SCROLL (rAF intervals, last gestures)")
        if (scroll == null || scroll.length() == 0) appendLine("  none yet: fling the note, then Refresh")
        else for (i in maxOf(0, scroll.length() - 5) until scroll.length()) {
            val g = scroll.getJSONObject(i)
            appendLine("  ${g.opt("frames")} frames, avg ${g.opt("avgFps")} fps, p95 ${g.opt("p95")} ms, worst ${g.opt("worst")} ms, >16.7 ms: ${g.opt("over60fpsBudget")}")
        }
    }
    val f = s.frames
    appendLine("\nFRAMES (JankStats, whole window, since reset)")
    appendLine("  ${f.opt("frames")} frames, ${f.opt("jankyFrames")} janky (${f.opt("jankPercent")}%), display ${f.opt("displayRefreshHz")} Hz")
    appendLine("  UI duration p50 ${f.opt("uiDurationP50Ms")} / p95 ${f.opt("uiDurationP95Ms")} / p99 ${f.opt("uiDurationP99Ms")} / max ${f.opt("uiDurationMaxMs")} ms")
    appendLine("  frames over 16.7 ms: ${f.opt("framesOver60fpsBudget")}")
    if (web != null) {
        val d = web.optJSONObject("document") ?: JSONObject()
        appendLine("\nDOCUMENT: ${d.opt("words")} words, ${d.opt("blocks")} blocks")
        appendLine("IME LOG: ${web.optJSONObject("ime")?.opt("entries")} entries")
        val tests = web.optJSONArray("typingTests")
        if (tests != null && tests.length() > 0) {
            appendLine("\nTYPING TESTS")
            for (i in 0 until tests.length()) {
                val r = tests.getJSONObject(i)
                appendLine("  ${r.optString("label")}: lost ${r.opt("lost")}, dup ${r.opt("duplicated")}, extra ${r.opt("extra")}")
            }
        }
    }
}

@Composable
private fun ExportDialog(onExport: (String) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        title = { Text("Export log") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("IME event log, typing-test results, stats and device info as JSON.")
                OutlinedButton(onClick = { onExport("share") }, modifier = Modifier.fillMaxWidth()) { Text("Share file…") }
                OutlinedButton(onClick = { onExport("copy") }, modifier = Modifier.fillMaxWidth()) { Text("Copy to clipboard") }
            }
        },
    )
}

@Composable
private fun LinkDialog(hasLink: Boolean, onApply: (String) -> Unit, onDismiss: () -> Unit) {
    var url by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = { onApply(url.trim()) }, enabled = url.isNotBlank()) { Text("Apply") } },
        dismissButton = {
            Row {
                if (hasLink) TextButton(onClick = { onApply("") }) { Text("Remove link") }
                TextButton(onClick = onDismiss) { Text("Cancel") }
            }
        },
        title = { Text("Link") },
        text = {
            OutlinedTextField(value = url, onValueChange = { url = it }, label = { Text("URL") }, singleLine = true)
        },
    )
}
