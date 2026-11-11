package app.penmoss.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarData
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.SnackbarVisuals
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.penmoss.ui.square.IconButton
import app.penmoss.ui.square.TextButton

/** The widest a snackbar grows; past it, its text wraps (PEN-63). */
val SNACKBAR_MAX_WIDTH = 380.dp

/** The snackbar's `testTag`, for tests to find its card. */
const val SNACKBAR_TAG = "penmoss-snackbar"

/** The leading glyph's `testTag`: `penmoss-snackbar-glyph-done`, `-error` or `-trash`. */
fun snackbarGlyphTag(tone: SnackbarTone) = "penmoss-snackbar-glyph-${tone.name.lowercase()}"

/**
 * What a snackbar reports, as the web toast's `data-tone` (PEN-63): [Done] leads with a check in
 * the accent, [Error] with a warning in the danger colour, [Trash] with Trash's bin in the accent
 * (the web's Trash toast), [Info] with no glyph. A plain `showSnackbar` is [Info].
 */
enum class SnackbarTone { Done, Error, Trash, Info }

/** A snackbar's visuals with its [tone]; shown with [say]. */
data class PenmossSnackbarVisuals(
    override val message: String,
    val tone: SnackbarTone,
    override val actionLabel: String? = null,
    override val withDismissAction: Boolean = false,
    override val duration: SnackbarDuration = if (actionLabel == null) SnackbarDuration.Short else SnackbarDuration.Indefinite,
) : SnackbarVisuals

/** Shows [message] with [tone]'s leading glyph, as `showSnackbar` does otherwise. */
suspend fun SnackbarHostState.say(
    message: String,
    tone: SnackbarTone,
    actionLabel: String? = null,
    withDismissAction: Boolean = false,
    duration: SnackbarDuration = if (actionLabel == null) SnackbarDuration.Short else SnackbarDuration.Indefinite,
): SnackbarResult = showSnackbar(PenmossSnackbarVisuals(message, tone, actionLabel, withDismissAction, duration))

/** What a snackbar is drawn with: the theme's raised surface, text, accent and border. */
internal data class SnackbarColours(val container: Color, val content: Color, val action: Color, val muted: Color, val border: Color, val danger: Color)

/**
 * The snackbar's colours from the theme (PEN-63): the raised surface (`surfaceContainerHigh`), the
 * text on it, the accent made only as light or dark as it must be to read there, and the border
 * mixed 15% toward the text, as the web's `--pm-border-strong`; the error glyph in the theme's
 * danger colour, made as readable there.
 */
internal fun snackbarColours(scheme: ColorScheme): SnackbarColours {
    val container = scheme.surfaceContainerHigh
    return SnackbarColours(
        container = container,
        content = readableOn(container, scheme.onSurface),
        action = readableOn(container, scheme.primary),
        muted = scheme.onSurfaceVariant,
        border = lerp(scheme.outline, scheme.onSurface, 0.15f),
        danger = readableOn(container, scheme.error),
    )
}

/**
 * Every snackbar in the app (PEN-63), as the web's toast: a square raised card in the theme's
 * colours with a 1 dp border and a soft shadow, led by its tone's glyph ([SnackbarTone]), as wide as its text up to [SNACKBAR_MAX_WIDTH],
 * centred at the bottom; its action in the accent. Each `SnackbarHost` draws its snackbars with
 * it: `SnackbarHost(state) { PenmossSnackbar(it) }`.
 */
@Composable
fun PenmossSnackbar(data: SnackbarData, modifier: Modifier = Modifier) {
    val colours = snackbarColours(MaterialTheme.colorScheme)
    val visuals = data.visuals
    Box(modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) {
        Surface(
            modifier = Modifier.widthIn(max = SNACKBAR_MAX_WIDTH).testTag(SNACKBAR_TAG),
            shape = RectangleShape,
            color = colours.container,
            contentColor = colours.content,
            border = BorderStroke(1.dp, colours.border),
            shadowElevation = 6.dp,
        ) {
            val controls = visuals.actionLabel != null || visuals.withDismissAction
            val tone = (visuals as? PenmossSnackbarVisuals)?.tone ?: SnackbarTone.Info
            Row(
                Modifier.heightIn(min = 48.dp).padding(start = if (tone == SnackbarTone.Info) 16.dp else 14.dp, end = if (controls) 4.dp else 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                val glyph = when (tone) {
                    SnackbarTone.Done -> Icons.Filled.Check to colours.action
                    SnackbarTone.Error -> Icons.Filled.Warning to colours.danger
                    SnackbarTone.Trash -> Icons.Filled.Delete to colours.action
                    SnackbarTone.Info -> null
                }
                glyph?.let { (icon, tint) ->
                    Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.padding(end = 10.dp).size(18.dp).testTag(snackbarGlyphTag(tone)))
                }
                Text(
                    visuals.message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = colours.content,
                    modifier = Modifier.weight(1f, fill = false).padding(vertical = 12.dp),
                )
                visuals.actionLabel?.let { label ->
                    TextButton(
                        onClick = { data.performAction() },
                        colors = ButtonDefaults.textButtonColors(contentColor = colours.action),
                    ) {
                        Text(label, fontWeight = FontWeight.SemiBold)
                    }
                }
                if (visuals.withDismissAction) {
                    IconButton(onClick = { data.dismiss() }) {
                        Icon(Icons.Filled.Close, contentDescription = "Dismiss", tint = colours.muted)
                    }
                }
            }
        }
    }
}
