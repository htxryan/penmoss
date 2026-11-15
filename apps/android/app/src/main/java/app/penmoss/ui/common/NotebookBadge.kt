package app.penmoss.ui.common

import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import app.penmoss.engine.settings.BadgeGlyph
import app.penmoss.engine.settings.LucideIcon
import app.penmoss.engine.settings.LucideIcons
import app.penmoss.engine.settings.NotebookBadge
import app.penmoss.engine.settings.NotebookBadges
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Lucide's icons the app ships (A1579): `assets/lucide/icons.txt`, written by
 * `scripts/lucide-android.mjs` from the web's own Lucide, read once, off the main thread.
 */
object LucideAssets {
    const val FILE = "lucide/icons.txt"

    @Volatile
    private var loaded: LucideIcons? = null

    /** The icons if read already; null reads nothing. */
    fun now(): LucideIcons? = loaded

    /** The icons, read now if they are not yet (from a background thread: it is half a megabyte). */
    fun icons(context: Context): LucideIcons = loaded ?: synchronized(this) {
        loaded ?: LucideIcons.parse(context.assets.open(FILE).bufferedReader(Charsets.UTF_8).use { it.readText() })
            .also { loaded = it }
    }

    private val vectors = ConcurrentHashMap<String, ImageVector>()

    /** An icon as Lucide draws it: its shapes on the 24-unit grid, stroked 2 wide, round ends. */
    fun vector(icon: LucideIcon): ImageVector = vectors.getOrPut(icon.name) {
        ImageVector.Builder(icon.name, 24.dp, 24.dp, 24f, 24f).apply {
            for (shape in icon.shapes) {
                addPath(
                    pathData = addPathNodes(shape.pathData()),
                    fill = if (shape.filled) SolidColor(Color.Black) else null,
                    stroke = SolidColor(Color.Black),
                    strokeLineWidth = 2f,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()
    }
}

/** Lucide's icons, once read; null for the moment they take the first time. */
@Composable
fun rememberLucideIcons(): LucideIcons? {
    val context = LocalContext.current.applicationContext
    val icons by produceState(LucideAssets.now(), context) {
        if (value == null) value = withContext(Dispatchers.IO) { runCatching { LucideAssets.icons(context) }.getOrNull() }
    }
    return icons
}

/** `#rrggbb` as a colour. */
internal fun badgeColour(hex: String): Color = Color(android.graphics.Color.parseColor(hex))

/**
 * A notebook's badge (A1579; the web's `BadgeView`, A1504): a square of its colour holding its
 * letter, number or Lucide icon in white or near-black, whichever reads at 4.5:1. Its accessible
 * name is the notebook's, so TalkBack says "Personal", not "P"; [decorative] hides it where the
 * name is beside it. An icon this build has no shapes for shows the notebook's default letter,
 * as the web's does; until the icons are read the square shows alone.
 */
@Composable
fun NotebookBadgeView(
    badge: NotebookBadge,
    name: String,
    modifier: Modifier = Modifier,
    size: Dp = 18.dp,
    decorative: Boolean = false,
) {
    val lucide = badge.icon
    val icons = if (lucide != null) rememberLucideIcons() else null
    val icon = if (lucide != null) icons?.icon(lucide) else null
    val shown = if (lucide != null && icons != null && icon == null) NotebookBadges.defaultGlyph(name) else badge.glyph
    val ink = badgeColour(badge.ink)
    Box(
        modifier
            .size(size)
            .background(badgeColour(badge.color), RectangleShape)
            .testTag("notebook-badge")
            .semantics {
                if (decorative) {
                    hideFromAccessibility()
                } else {
                    contentDescription = name
                    role = Role.Image
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        if (shown.kind == BadgeGlyph.ICON) {
            if (icon != null) {
                Icon(
                    LucideAssets.vector(icon),
                    contentDescription = null,
                    tint = ink,
                    modifier = Modifier.size(size * 0.72f).testTag("notebook-badge-icon-${icon.name}"),
                )
            }
        } else {
            val text = with(LocalDensity.current) { (size * if (shown.value.length > 1) 0.5f else 0.62f).toSp() }
            Text(
                shown.value,
                color = ink,
                fontSize = text,
                lineHeight = text,
                fontWeight = FontWeight.SemiBold,
                textAlign = TextAlign.Center,
                maxLines = 1,
                modifier = Modifier.testTag("notebook-badge-text"),
            )
        }
    }
}
