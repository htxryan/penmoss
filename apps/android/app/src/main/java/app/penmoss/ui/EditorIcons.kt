package app.penmoss.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The formatting bar's icons (T33): the web app's line icons
 * (packages/ui/src/icons/Icon.tsx, after the prototype), on the same 24-unit
 * grid with a 1.5 stroke, so the phone's bar looks like the web's. Heading,
 * numbered list, indent, outdent and picture are drawn in the same style. The
 * icons are tinted with the content colour where they are shown.
 */
object EditorIcons {
    val Bold = icon("Bold", stroke = 2f, "M7.5 5h5.5a3.5 3.5 0 0 1 0 7H7.5zM7.5 12h6.5a3.5 3.5 0 0 1 0 7H7.5z")
    val Italic = icon("Italic", "M10.5 5H18M6 19h7.5M14.5 5l-5 14")
    val Code = icon("Code", "m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13")
    val Link = icon(
        "Link",
        "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
    )
    val Heading = icon("Heading", "M6 5v14M16 5v14M6 12h10M19.5 19v-5l-1.5 1")
    val List = icon("List", "M9.5 6.5H20M9.5 12H20M9.5 17.5H20", dots = listOf(5f to 6.5f, 5f to 12f, 5f to 17.5f))
    val NumberedList = icon("NumberedList", "M10 6.5h10M10 12h10M10 17.5h10M4.5 5.5 6 4.5v4M4.5 14.5a1.2 1.2 0 1 1 1.8 1L4.5 18.5h2.2")
    val Checklist = icon(
        "Checklist",
        "M5 4.5h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3a1.5 1.5 0 0 1-1.5-1.5v-3a1.5 1.5 0 0 1 1.5-1.5z" +
            "M5 13.5h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3a1.5 1.5 0 0 1-1.5-1.5v-3a1.5 1.5 0 0 1 1.5-1.5z" +
            "M4.9 7.6l1.3 1.3 2.1-2.4M13 7.5h7.5M13 16.5h7.5",
    )
    val Indent = icon("Indent", "M11 6.5h9M11 12h9M11 17.5h9M4 9l3 3-3 3")
    val Outdent = icon("Outdent", "M11 6.5h9M11 12h9M11 17.5h9M7 9l-3 3 3 3")
    val Picture = icon(
        "Picture",
        "M5.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2zM3.5 16l4.5-4.5 4 4 2.5-2.5 6 6",
        dots = listOf(15.5f to 9f),
    )
    val Undo = icon("Undo", "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11")
    val Redo = icon("Redo", "m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13")

    // T40 P8 (ED4–ED6): the + sheet, the Block menu and the table buttons, in the same style.
    val Plus = icon("Plus", "M12 5v14M5 12h14")
    // T44 (A747): the bar's Symbol menu, the web's `star`, and its ticks.
    val Star = icon("Symbol", "m12 3.8 2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z")
    val Tick = icon("Tick", "m5 12.5 4.5 4.5L19 7.5")
    val Block = icon(
        "Block",
        "",
        dots = listOf(9f to 6f, 15f to 6f, 9f to 12f, 15f to 12f, 9f to 18f, 15f to 18f),
    )
    val NextCell = icon("NextCell", "M4 12h11M11 8l4 4-4 4M19.5 5v14")
    val PreviousCell = icon("PreviousCell", "M20 12H9M13 8l-4 4 4 4M4.5 5v14")
    val AddRow = icon("AddRow", "M4.5 4.5h15v9h-15zM4.5 9h15M12 4.5v9M12 16v5M9.5 18.5h5")
    val AddColumn = icon("AddColumn", "M4.5 4.5h9v15h-9zM9 4.5v15M4.5 12h9M16 12h5M18.5 9.5v5")

    // T40 P8 (ED12): Attach a file, a paper clip.
    val Attach = icon("Attach", "M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8")

    private fun icon(name: String, path: String, dots: kotlin.collections.List<Pair<Float, Float>> = emptyList()) =
        icon(name, 1.5f, path, dots)

    private fun icon(
        name: String,
        stroke: Float,
        path: String,
        dots: kotlin.collections.List<Pair<Float, Float>> = emptyList(),
    ): ImageVector = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
        addPath(
            pathData = addPathNodes(path),
            stroke = SolidColor(Color.Black),
            strokeLineWidth = stroke,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        )
        for ((x, y) in dots) {
            addPath(
                pathData = addPathNodes("M${x - 1.1f} ${y}a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0-2.2 0z"),
                fill = SolidColor(Color.Black),
            )
        }
    }.build()
}
