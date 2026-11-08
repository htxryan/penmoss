package app.penmoss.ui.settings

import androidx.compose.foundation.Canvas
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.foundation.border
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderColors
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/*
 * Any colour for a symbol (T51, A939): the web's colour wheel for hue and saturation, a
 * brightness slider, an opacity slider, and a hex field that takes #RGB, #RRGGBB or #RRGGBBAA. What it gives is the
 * stored form, `#rrggbb` or `#rrggbbaa` in lower case, opaque colours without their alpha.
 */

/** A colour as the picker holds it: hue in degrees, saturation, value and alpha from 0 to 1. */
data class Hsva(val hue: Float, val saturation: Float, val value: Float, val alpha: Float = 1f)

object HexColours {
    private val INPUT = Regex("^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")

    /** Typed text as a stored colour, or null when it is not #RGB, #RRGGBB or #RRGGBBAA (the # optional). */
    fun parse(text: String): String? {
        val digits = INPUT.matchEntire(text.trim())?.groupValues?.get(1)?.lowercase() ?: return null
        val full = if (digits.length == 3) digits.map { "$it$it" }.joinToString("") else digits
        return stored("#$full")
    }

    /** The stored form: lower case, and an opaque colour's `ff` alpha dropped. */
    fun stored(hex: String): String {
        val lower = hex.lowercase()
        return if (lower.length == 9 && lower.endsWith("ff")) lower.take(7) else lower
    }

    /** [hsva] as a stored colour. */
    fun of(hsva: Hsva): String {
        val (r, g, b) = rgb(hsva)
        val alpha = (hsva.alpha.coerceIn(0f, 1f) * 255).roundToInt()
        return stored("#" + listOf(r, g, b, alpha).joinToString("") { it.toString(16).padStart(2, '0') })
    }

    /** A stored colour as hue, saturation, value and alpha (black and grey keep hue 0). */
    fun hsva(hex: String): Hsva {
        val digits = hex.removePrefix("#")
        val r = digits.substring(0, 2).toInt(16) / 255f
        val g = digits.substring(2, 4).toInt(16) / 255f
        val b = digits.substring(4, 6).toInt(16) / 255f
        val alpha = if (digits.length == 8) digits.substring(6, 8).toInt(16) / 255f else 1f
        val max = maxOf(r, g, b)
        val min = minOf(r, g, b)
        val delta = max - min
        val hue = when {
            delta == 0f -> 0f
            max == r -> 60f * (((g - b) / delta).mod(6f))
            max == g -> 60f * ((b - r) / delta + 2f)
            else -> 60f * ((r - g) / delta + 4f)
        }
        return Hsva(hue, if (max == 0f) 0f else delta / max, max, alpha)
    }

    private fun rgb(hsva: Hsva): Triple<Int, Int, Int> {
        val h = hsva.hue.mod(360f)
        val s = hsva.saturation.coerceIn(0f, 1f)
        val v = hsva.value.coerceIn(0f, 1f)
        val c = v * s
        val x = c * (1 - abs((h / 60f).mod(2f) - 1))
        val m = v - c
        val (r, g, b) = when ((h / 60f).toInt()) {
            0 -> Triple(c, x, 0f)
            1 -> Triple(x, c, 0f)
            2 -> Triple(0f, c, x)
            3 -> Triple(0f, x, c)
            4 -> Triple(x, 0f, c)
            else -> Triple(c, 0f, x)
        }
        fun byte(channel: Float) = ((channel + m) * 255).roundToInt().coerceIn(0, 255)
        return Triple(byte(r), byte(g), byte(b))
    }

    /** A stored colour for Compose. */
    fun color(hex: String): Color {
        val digits = hex.removePrefix("#")
        val rgb = digits.take(6).toLong(16)
        val alpha = if (digits.length == 8) digits.substring(6).toLong(16) else 0xFF
        return Color((alpha shl 24) or rgb)
    }
}

/**
 * The colour wheel's maths, the web's (`apps/web/src/shell/colour.ts`): red at the top, the
 * hue running clockwise, saturation from the centre out to the edge.
 */
object ColourWheel {
    /** The hue and saturation at ([x], [y]) from the centre of a wheel of [radius]; outside it, its edge. */
    fun point(x: Float, y: Float, radius: Float): Pair<Float, Float> {
        val distance = hypot(x, y)
        if (distance == 0f || radius <= 0f) return 0f to 0f
        var hue = Math.toDegrees(atan2(x.toDouble(), -y.toDouble())).toFloat()
        if (hue < 0f) hue += 360f
        return hue to min(1f, distance / radius)
    }

    /** Where [hue] and [saturation] sit from the centre (the inverse of [point]). */
    fun position(hue: Float, saturation: Float, radius: Float): Offset {
        val angle = Math.toRadians(hue.toDouble())
        return Offset((sin(angle) * saturation * radius).toFloat(), (-cos(angle) * saturation * radius).toFloat())
    }
}

/** The wheel's width on the phone; the web's is 144 px. */
private val WHEEL = 168.dp

/**
 * The picker for one colour, [hex] (stored form); [onChange] gets each new one. As the web's
 * (A939): a wheel for hue and saturation (tap or drag; with a keyboard, left and right turn the
 * hue and up and down change the saturation, Shift for bigger steps), then Brightness, Opacity
 * and a Hex field.
 */
@Composable
fun ColourPicker(hex: String, onChange: (String) -> Unit, modifier: Modifier = Modifier) {
    var hsva by remember { mutableStateOf(HexColours.hsva(hex)) }
    var typed by rememberSaveable { mutableStateOf(hex.uppercase()) }
    // The last colour these controls sent: it comes back as [hex] a frame later, when the field
    // may already hold more of what is being typed (#C21, then #C218…), which it must not undo.
    var sent by remember { mutableStateOf<String?>(null) }
    // A colour set from outside (a chip, a restored dialog) moves the controls, unless it is the one they made.
    LaunchedEffect(hex) {
        if (hex == sent) return@LaunchedEffect
        if (HexColours.of(hsva) != hex) hsva = HexColours.hsva(hex)
        if (HexColours.parse(typed) != hex) typed = hex.uppercase()
    }
    val change by rememberUpdatedState(onChange)
    fun send(made: String) {
        sent = made
        change(made)
    }
    fun set(next: Hsva) {
        hsva = next
        val made = HexColours.of(next)
        typed = made.uppercase()
        send(made)
    }
    val current by rememberUpdatedState(hsva)
    val solid = HexColours.color(HexColours.of(hsva.copy(alpha = 1f)))
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        fun pick(at: Offset, width: Int) {
            val radius = width / 2f
            val (hue, saturation) = ColourWheel.point(at.x - radius, at.y - radius, radius)
            // A black colour turns bright again when a hue is picked, as on the web.
            set(current.copy(hue = hue, saturation = saturation, value = if (current.value == 0f) 1f else current.value))
        }
        Box(
            Modifier
                .align(Alignment.CenterHorizontally)
                .size(WHEEL)
                .testTag("symbol-colour-wheel")
                .semantics {
                    contentDescription = "Hue and saturation"
                    stateDescription = "Hue ${hsva.hue.roundToInt()}°, saturation ${(hsva.saturation * 100).roundToInt()}%"
                }
                .onKeyEvent { event ->
                    if (event.type != KeyEventType.KeyDown) return@onKeyEvent false
                    val step = if (event.isShiftPressed) 10f else 1f
                    val now = current
                    val next = when (event.key) {
                        Key.DirectionRight -> now.copy(hue = (now.hue + step).mod(360f))
                        Key.DirectionLeft -> now.copy(hue = (now.hue - step).mod(360f))
                        Key.DirectionUp -> now.copy(saturation = min(1f, (now.saturation * 100 + step).roundToInt() / 100f))
                        Key.DirectionDown -> now.copy(saturation = max(0f, (now.saturation * 100 - step).roundToInt() / 100f))
                        else -> null
                    } ?: return@onKeyEvent false
                    set(next)
                    true
                }
                .focusable()
                .pointerInput(Unit) { detectTapGestures { pick(it, size.width) } }
                .pointerInput(Unit) {
                    detectDragGestures(onDragStart = { pick(it, size.width) }) { change, _ ->
                        change.consume()
                        pick(change.position, size.width)
                    }
                },
        ) {
            Canvas(Modifier.matchParentSize()) {
                val radius = size.minDimension / 2f
                // The hues around from the top, clockwise; white at the centre; dimmed by brightness.
                rotate(-90f) {
                    drawCircle(Brush.sweepGradient((0..6).map { HexColours.color(HexColours.of(Hsva(it * 60f, 1f, 1f))) }), radius)
                }
                drawCircle(Brush.radialGradient(listOf(Color.White, Color.White.copy(alpha = 0f)), center, radius), radius)
                drawCircle(Color.Black.copy(alpha = 1f - hsva.value.coerceIn(0f, 1f)), radius)
                val at = center + ColourWheel.position(hsva.hue, hsva.saturation, radius)
                drawCircle(solid, 7.dp.toPx(), at)
                drawCircle(Color.White, 7.dp.toPx(), at, style = Stroke(2.dp.toPx()))
                drawCircle(Color.Black.copy(alpha = 0.45f), 8.dp.toPx(), at, style = Stroke(1.dp.toPx()))
            }
        }
        Text("Brightness", style = MaterialTheme.typography.labelMedium)
        GradientSlider(
            brush = Brush.horizontalGradient(listOf(Color.Black, HexColours.color(HexColours.of(hsva.copy(value = 1f, alpha = 1f))))),
            value = hsva.value,
            onValueChange = { set(hsva.copy(value = it)) },
            valueRange = 0f..1f,
            modifier = Modifier.testTag("symbol-colour-value").semantics { contentDescription = "Brightness" },
        )
        Text("Opacity", style = MaterialTheme.typography.labelMedium)
        GradientSlider(
            brush = Brush.horizontalGradient(listOf(solid.copy(alpha = 0f), solid)),
            checks = true,
            value = hsva.alpha,
            onValueChange = { set(hsva.copy(alpha = it)) },
            valueRange = 0f..1f,
            modifier = Modifier.testTag("symbol-colour-alpha").semantics { contentDescription = "Opacity" },
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Canvas(
                Modifier
                    .size(40.dp)
                    .clip(RectangleShape)
                    .border(1.dp, MaterialTheme.colorScheme.outline, RectangleShape),
            ) {
                drawChecks()
                drawRect(HexColours.color(hex))
            }
            val problem = if (HexColours.parse(typed) == null) "Use #RGB, #RRGGBB or #RRGGBBAA" else null
            OutlinedTextField(
                value = typed,
                onValueChange = { text ->
                    typed = text.take(9)
                    HexColours.parse(text)?.let { parsed ->
                        hsva = HexColours.hsva(parsed)
                        send(parsed)
                    }
                },
                label = { Text("Hex") },
                singleLine = true,
                isError = problem != null,
                supportingText = problem?.let { { Text(it) } },
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, imeAction = ImeAction.Done),
                modifier = Modifier.weight(1f).testTag("symbol-hex").semantics { problem?.let { error(it) } },
            )
        }
    }
}

/** The checks a see-through colour is shown over, as the web's: light grey and white. */
private fun DrawScope.drawChecks() {
    val cell = 4.dp.toPx()
    drawRect(Color.White)
    val light = Color(0xFFCCCCCC)
    var row = 0
    var y = 0f
    while (y < size.height) {
        var x = if (row % 2 == 0) 0f else cell
        while (x < size.width) {
            drawRect(light, Offset(x, y), Size(cell, cell))
            x += 2 * cell
        }
        y += cell
        row++
    }
}

/**
 * A slider over its own colours (T51, A939): the colour from black to bright, or from clear to
 * opaque over checks. Material's tracks and ticks are clear, so they no longer cover the colours (T51's
 * manual pass found only the spectrum's ends showing).
 */
@Composable
private fun GradientSlider(
    brush: Brush,
    value: Float,
    onValueChange: (Float) -> Unit,
    valueRange: ClosedFloatingPointRange<Float>,
    modifier: Modifier = Modifier,
    checks: Boolean = false,
) {
    Box(contentAlignment = Alignment.Center) {
        Canvas(
            Modifier
                .fillMaxWidth()
                .height(12.dp)
                .clip(RectangleShape)
                .border(1.dp, MaterialTheme.colorScheme.outline, RectangleShape),
        ) {
            if (checks) drawChecks()
            drawRect(brush)
        }
        Slider(
            value = value,
            onValueChange = onValueChange,
            valueRange = valueRange,
            colors = gradientSliderColours(),
            modifier = modifier,
        )
    }
}

/** A slider's colours over a gradient: only its thumb is drawn. */
@Composable
internal fun gradientSliderColours(): SliderColors = SliderDefaults.colors(
    thumbColor = MaterialTheme.colorScheme.onSurface,
    activeTrackColor = Color.Transparent,
    inactiveTrackColor = Color.Transparent,
    activeTickColor = Color.Transparent,
    inactiveTickColor = Color.Transparent,
)
