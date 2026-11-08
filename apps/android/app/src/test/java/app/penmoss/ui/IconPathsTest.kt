package app.penmoss.ui

import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathNode
import androidx.compose.ui.graphics.vector.VectorGroup
import androidx.compose.ui.graphics.vector.VectorNode
import androidx.compose.ui.graphics.vector.VectorPath
import app.penmoss.ui.settings.SettingsIcons
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The line icons are the web's (packages/ui/src/icons/Icon.tsx), whose shapes are separate
 * `<circle>`, `<rect>` and `<path>` elements. Here they are one path, so a path written after a
 * closed shape must start with an absolute M: a relative m moves from the shape's start, which
 * drew Search without its handle and Graph without an edge (T51's manual pass).
 */
class IconPathsTest {
    private fun icons(owner: Any): Map<String, ImageVector> =
        owner.javaClass.declaredMethods
            .filter { it.parameterCount == 0 && it.returnType == ImageVector::class.java }
            .associate { it.name to (it.apply { isAccessible = true }.invoke(owner) as ImageVector) }

    private fun paths(group: VectorGroup): List<List<PathNode>> = group.flatMap { node: VectorNode ->
        when (node) {
            is VectorGroup -> paths(node)
            is VectorPath -> listOf(node.pathData)
            else -> emptyList()
        }
    }

    /** Each point a path moves or draws to, on the icon's 24-unit grid. */
    private fun points(nodes: List<PathNode>): List<Pair<Float, Float>> {
        var x = 0f
        var y = 0f
        var startX = 0f
        var startY = 0f
        val out = mutableListOf<Pair<Float, Float>>()
        fun to(nx: Float, ny: Float) {
            x = nx
            y = ny
            out += x to y
        }
        for (node in nodes) {
            when (node) {
                is PathNode.MoveTo -> { to(node.x, node.y); startX = x; startY = y }
                is PathNode.RelativeMoveTo -> { to(x + node.dx, y + node.dy); startX = x; startY = y }
                is PathNode.LineTo -> to(node.x, node.y)
                is PathNode.RelativeLineTo -> to(x + node.dx, y + node.dy)
                is PathNode.HorizontalTo -> to(node.x, y)
                is PathNode.RelativeHorizontalTo -> to(x + node.dx, y)
                is PathNode.VerticalTo -> to(x, node.y)
                is PathNode.RelativeVerticalTo -> to(x, y + node.dy)
                is PathNode.CurveTo -> to(node.x3, node.y3)
                is PathNode.RelativeCurveTo -> to(x + node.dx3, y + node.dy3)
                is PathNode.ReflectiveCurveTo -> to(node.x2, node.y2)
                is PathNode.RelativeReflectiveCurveTo -> to(x + node.dx2, y + node.dy2)
                is PathNode.QuadTo -> to(node.x2, node.y2)
                is PathNode.RelativeQuadTo -> to(x + node.dx2, y + node.dy2)
                is PathNode.ReflectiveQuadTo -> to(node.x, node.y)
                is PathNode.RelativeReflectiveQuadTo -> to(x + node.dx, y + node.dy)
                is PathNode.ArcTo -> to(node.arcStartX, node.arcStartY)
                is PathNode.RelativeArcTo -> to(x + node.arcStartDx, y + node.arcStartDy)
                is PathNode.Close -> { x = startX; y = startY }
            }
        }
        return out
    }

    @Test
    fun everyIconStaysOnItsGridAndNoPathMovesRelativeToAClosedShape() {
        val all = icons(SettingsIcons) + icons(EditorIcons).mapKeys { "editor ${it.key}" }
        assertTrue("found the icons", all.size > 30)
        for ((name, icon) in all) {
            for (nodes in paths(icon.root)) {
                for ((px, py) in points(nodes)) {
                    assertTrue("$name goes to ($px, $py), off its 24-unit grid", px in -0.01f..24.01f && py in -0.01f..24.01f)
                }
                val afterClose = nodes.zipWithNext().filter { (a, b) -> a is PathNode.Close && b is PathNode.RelativeMoveTo }
                assertEquals("$name moves relative to a closed shape", emptyList<Any>(), afterClose)
            }
        }
    }
}
