package app.penmoss.ui.settings

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The Settings sections' icons (T40 P1): the web app's line icons (packages/ui/src/icons/Icon.tsx)
 * on its 24-unit grid with a 1.5 stroke, as the formatting bar's are, so Settings on the phone
 * looks like Settings on the web. Tinted with the content colour where they are shown.
 */
object SettingsIcons {
    val Palette = icon(
        "Palette",
        "M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.6-1-2.6 0-.9.7-1.6 1.7-1.6h2.1a3.9 3.9 0 0 0 3.9-3.9c0-4.1-3.8-7.2-8.5-7.2z" +
            circle(7.8f, 11f, 1.1f) + circle(10.5f, 7.6f, 1.1f) + circle(15f, 8f, 1.1f),
    )
    val Journal = icon(
        "Journal",
        "M6.5 3.5h11A1.5 1.5 0 0 1 19 5v14a1.5 1.5 0 0 1-1.5 1.5h-11zM6.5 3.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5M10 8h5.5M10 11.5h4",
    )
    val Inbox = icon("Inbox", "M3.5 13.5 6 5.5h12l2.5 8V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18zM3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5")
    val Refresh = icon(
        "Refresh",
        "M19.5 11A7.6 7.6 0 0 0 6 7.3L4.5 9M4.5 4.5V9H9M4.5 13A7.6 7.6 0 0 0 18 16.7l1.5-1.7M19.5 19.5V15H15",
    )
    /** Display (T42, A650): the web's `panelL`, a window with its sidebar. */
    val PanelLeft = icon("Display", rect(3.5f, 4.5f, 17f, 15f, 2f) + "M9.5 4.5v15")
    /** A notebook (T43, A750): the web's `notebook`, a bound book with a label, apart from the Journal's. */
    val Notebook = icon("Notebook", "M7 3.5h10.5A1.5 1.5 0 0 1 19 5v14a1.5 1.5 0 0 1-1.5 1.5H7zM7 3.5v17M4.5 7.5h5M4.5 12h5M4.5 16.5h5M11.5 8h4.5v3h-4.5z")
    /** Symbols (T44, A747): the web's `star`. */
    val Star = icon("Symbols", "m12 3.8 2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z")
    val Sun = icon(
        "Sun",
        circle(12f, 12f, 3.8f) +
            "M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4",
    )
    val Moon = icon("Moon", "M19.5 14.5A7.8 7.8 0 0 1 9.5 4.5a7.8 7.8 0 1 0 10 10z")
    val Monitor = icon("Monitor", rect(3f, 4.5f, 18f, 12f, 1.8f) + "M8.5 20h7M12 16.5V20")
    /** An agent author, as the history panel draws one (T40 P3b, NT16): a four-pointed star. */
    val Spark = icon("Agent", "M12 3.5 13.9 10 20.5 12 13.9 14 12 20.5 10.1 14 3.5 12 10.1 10z")
    /** The note's sync state (PL10, A429): a cloud with what it means. */
    private const val CLOUD = "M7 18.5h10.3a3.9 3.9 0 0 0 .7-7.75A5.4 5.4 0 0 0 7.6 9.2 4.7 4.7 0 0 0 7 18.5z"
    val CloudDone = icon("Synced", CLOUD + "M9.6 14l1.7 1.7 3.2-3.2")
    val CloudSync = icon("Syncing", CLOUD + "M9.6 14.6a2.5 2.5 0 0 1 4.4-1.6M14.4 13.4a2.5 2.5 0 0 1-4.4 1.6M14 11.6V13h-1.4M10 16.4V15h1.4")
    val CloudUpload = icon("Waiting to upload", CLOUD + "M12 16.6v-4.8M9.9 13.7 12 11.6l2.1 2.1")
    val CloudOff = icon("Offline", CLOUD + "M4 4.5l16 16")
    val CloudAlert = icon("Not synced", CLOUD + "M12 11.4v3M12 16.3v.2")
    /** Git notebooks (T50, A856): the web's `terminal`. */
    val Terminal = icon("Git notebooks", rect(3f, 4.5f, 18f, 15f, 2f) + "M7 9.5l3 2.5-3 2.5M12.5 15h4.5")
    val Key = icon("Key", circle(8f, 15.5f, 3.6f) + "M10.6 13 19.5 4.5M16.5 7.5l2.2 2.2M14.3 9.7l1.7 1.7")
    /** The note's Info sheet (T40 P7, NT23), the web's Info panel button. */
    /** Settings → What’s New (PEN-109): a speaker announcing. */
    val WhatsNew = icon("What’s New", "M4 10v4h3l6 4V6l-6 4zM16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10")
    val Info = icon("Info", "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 11v5.2M12 7.8h.01")

    /** Keyboard shortcuts (T40 P9, ST8): the web's keyboard icon. */
    val Keyboard = icon("Keyboard", rect(2.5f, 6f, 19f, 12f, 2f) + "M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M18 10h.01M7 14h10")
    val WidthFull = icon("WidthFull", "M3.5 5v14M20.5 5v14M7 12h10M9.5 9.5 7 12l2.5 2.5M14.5 9.5 17 12l-2.5 2.5")

    /*
     * Home's row and the note panel (T51, A932, A935, A936): the web's `search`, `today`, `week`,
     * `graph`, `command`, `gear`, `comment`, `history` and `pin`, so the phone's icons are the sidebar's.
     */
    val Search = icon("Search", circle(11f, 11f, 6.5f) + "M20 20l-4.2-4.2")
    private const val CALENDAR = "M5.5 5h13a2 2 0 0 1 2 2v11.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3.5 9.5h17M8 3v4M16 3v4"
    val Today = icon("Today", CALENDAR + circle(12f, 15f, 1.5f))
    val Week = icon("This Week", CALENDAR + "M7.5 13.5h9M7.5 16.8h5")
    val Graph = icon("Graph", circle(6f, 7f, 2.2f) + circle(18f, 6f, 2.2f) + circle(12f, 17.5f, 2.5f) + "M7.1 9l3.7 6.4M17 8l-3.8 7.3M8.2 6.8l7.6-.6")
    val Command = icon("Commands", "M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3")
    val Gear = icon(
        "Settings",
        "M10.34 5.82 10.51 3.53 13.49 3.53 13.66 5.82 15.2 6.46 16.93 4.96 19.04 7.07 17.54 8.8 18.18 10.34 20.47 10.51 20.47 13.49 " +
            "18.18 13.66 17.54 15.2 19.04 16.93 16.93 19.04 15.2 17.54 13.66 18.18 13.49 20.47 10.51 20.47 10.34 18.18 8.8 17.54 " +
            "7.07 19.04 4.96 16.93 6.46 15.2 5.82 13.66 3.53 13.49 3.53 10.51 5.82 10.34 6.46 8.8 4.96 7.07 7.07 4.96 8.8 6.46z" +
            circle(12f, 12f, 2.6f),
    )
    val Comment = icon(
        "Comments",
        "M5.5 5h13A1.5 1.5 0 0 1 20 6.5v8.5a1.5 1.5 0 0 1-1.5 1.5H11l-4.5 3.5v-3.5h-1A1.5 1.5 0 0 1 4 15V6.5A1.5 1.5 0 0 1 5.5 5z",
    )
    val History = icon("Version History", "M3.8 12a8.2 8.2 0 1 0 2.5-5.9M3.8 4.2v4h4M12 7.5V12l3 2")
    /** A notebook's heading on Home (T52 items 8, 10): the web's `sort`, `folderPlus`, `trash` and `plus`. */
    val Sort = icon("Sort Order", "M7.5 4.5v15m0 0-3-3m3 3 3-3M16.5 19.5v-15m0 0-3 3m3-3 3 3")
    val FolderPlus = icon("New Folder", "M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM12 10.5v5M9.5 13h5")
    val Trash = icon("Trash", "M5 7h14M10 4h4M7 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7")
    val Plus = icon("New Note", "M12 5v14M5 12h14")
    val Pin = icon("Pin", "M9 4h6M10 4v5.5L6.5 13h11L14 9.5V4M12 13v7")

    /*
     * A shape closes its subpath, so a path after one starts with an absolute M: a relative m
     * would move from the shape's start, not from the origin as in the web's own <path> (T51).
     */
    private fun circle(cx: Float, cy: Float, r: Float) = "M${cx - r} ${cy}a$r $r 0 1 0 ${2 * r} 0a$r $r 0 1 0 ${-2 * r} 0z"

    private fun rect(x: Float, y: Float, w: Float, h: Float, r: Float) =
        "M${x + r} ${y}h${w - 2 * r}a$r $r 0 0 1 $r ${r}v${h - 2 * r}a$r $r 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a$r $r 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a$r $r 0 0 1 $r ${-r}z"

    private fun icon(name: String, path: String): ImageVector = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
        addPath(
            pathData = addPathNodes(path),
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 1.5f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        )
    }.build()
}
