package app.penmoss

import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getAllSemanticsNodes
import androidx.compose.ui.semantics.getOrNull

/**
 * What the instrumented specs read off the screen, in one place: Compose's semantics tree under a
 * view, and the accessibility tree from UiAutomation. They read it rather than use the Compose test
 * rule, whose Espresso link doesn't start on the API 37 emulator (InputManager.getInstance is gone).
 */
object ScreenTree {
    /** Every Compose semantics node under [view], unmerged, whether scrolled into view or not. */
    fun nodes(view: View): List<SemanticsNode> {
        val roots = mutableListOf<ViewRootForTest>()
        fun walk(v: View) {
            if (v is ViewRootForTest) roots += v
            if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
        }
        walk(view)
        return roots.flatMap { it.semanticsOwner.getAllSemanticsNodes(mergingEnabled = false) }
    }

    /** Every Compose text under [view]; none before the first Compose root is attached. */
    fun texts(view: View): List<String> =
        nodes(view).flatMap { node -> node.config.getOrNull(SemanticsProperties.Text).orEmpty().map { it.text } }

    /** Every accessibility node under [roots], each root first. */
    fun accessibilityNodes(roots: List<AccessibilityNodeInfo>): List<AccessibilityNodeInfo> {
        val found = mutableListOf<AccessibilityNodeInfo>()
        fun walk(node: AccessibilityNodeInfo) {
            found += node
            for (i in 0 until node.childCount) node.getChild(i)?.let(::walk)
        }
        roots.forEach(::walk)
        return found
    }
}
