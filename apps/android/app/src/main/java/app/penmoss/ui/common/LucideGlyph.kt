package app.penmoss.ui.common

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** One of Lucide's icons by name, the Mac's icon set (an empty space of its size until it loads). */
@Composable
fun LucideGlyph(name: String, contentDescription: String?, size: Int, tint: Color = LocalContentColor.current) {
    val icon = rememberLucideIcons()?.icon(name)
    if (icon != null) {
        Icon(LucideAssets.vector(icon), contentDescription, Modifier.size(size.dp), tint = tint)
    } else {
        Spacer(Modifier.size(size.dp))
    }
}

/** An icon-and-text button's content, as the Mac's `.btn` with an icon draws it: the icon, then the words. */
@Composable
fun IconAndText(icon: String, words: String) {
    LucideGlyph(icon, null, 18)
    Spacer(Modifier.width(6.dp))
    Text(words, maxLines = 1, softWrap = false, overflow = TextOverflow.Ellipsis)
}
