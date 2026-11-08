package app.penmoss.ui

import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge

/**
 * The system bars follow the variant the app shows (T40 P1, PL11, A414), not the phone's own mode:
 * with Dark chosen on a phone in light mode, the status and navigation bar icons are light, so they
 * read on the dark screen, and the reverse. Drawn edge to edge with no scrim of their own.
 */
fun ComponentActivity.followShownVariant(dark: Boolean) {
    val style = if (dark) SystemBarStyle.dark(Color.TRANSPARENT) else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
    enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
}
