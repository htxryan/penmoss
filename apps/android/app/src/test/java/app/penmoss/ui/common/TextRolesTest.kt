package app.penmoss.ui.common

import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The text roles (A1561) keep the web's order on Material's scale, in any interface font, and no
 * screen writes a font size of its own or takes a style from Material's scale itself. Plain JVM:
 * no screen.
 */
class TextRolesTest {
    private val roles = TextRoles(penmossTypography(null))

    private fun size(style: androidx.compose.ui.text.TextStyle) = style.fontSize.value

    private fun weight(style: androidx.compose.ui.text.TextStyle) = (style.fontWeight ?: FontWeight.Normal).weight

    @Test
    fun `each role is no larger than the role it sits under`() {
        assertTrue(size(roles.pageTitle) > size(roles.sectionHead))
        assertTrue(size(roles.sectionHead) > size(roles.groupHead))
        // A group's title is at least its rows' size, and heavier: titleSmall was smaller.
        assertTrue(size(roles.groupHead) >= size(roles.rowLabel))
        assertTrue(weight(roles.groupHead) > weight(roles.rowLabel))
        assertTrue(size(roles.rowLabel) > size(roles.help))
        assertTrue(size(roles.help) <= size(roles.body))
        assertTrue(size(roles.help) >= size(roles.meta))
        assertTrue(size(roles.meta) >= size(roles.badge))
        // A list's heading is smaller than its rows, as the web's sidebar sections are.
        assertTrue(size(roles.listHead) < size(roles.rowLabel))
    }

    @Test
    fun `the roles are in the interface font`() {
        val serif = TextRoles(penmossTypography(FontFamily.Serif))
        val interfaceRoles = listOf(
            serif.pageTitle, serif.sectionHead, serif.groupHead, serif.listHead, serif.dialogTitle, serif.rowLabel, serif.body,
            serif.help, serif.meta, serif.badge, serif.item, serif.field, serif.glyph, serif.display,
        )
        for (style in interfaceRoles) assertEquals(FontFamily.Serif, style.fontFamily)
        // Code is the one role in the monospace font, whatever the interface's.
        assertEquals(FontFamily.Monospace, serif.code.fontFamily)
    }

    @Test
    fun `no screen writes a font size, it names a role`() {
        val sources = File("src/main/java").walkTopDown().filter { it.isFile && it.extension == "kt" }.toList()
        assertTrue("the sources are where the test looks", sources.size > 50)
        val written = Regex("""\b(fontSize|lineHeight)\s*=\s*[\d.]+\s*\.(sp|em)\b|\b\d+(\.\d+)?\.sp\b""")
        val found = sources.flatMap { file ->
            file.readLines().mapIndexedNotNull { index, line ->
                if (written.containsMatchIn(line)) "${file.path}:${index + 1}: ${line.trim()}" else null
            }
        }
        assertEquals("Name a role from TextRoles (A1561) instead", emptyList<String>(), found)
    }

    @Test
    fun `no screen takes a style from Material's scale, it names a role`() {
        // TextRoles maps the roles onto Material's scale; everything else, ui/common's components
        // included, names a role (PEN-185), so a screen's text can't drift from its role.
        val sources = File("src/main/java").walkTopDown()
            .filter { it.isFile && it.extension == "kt" && it.name != "TextRoles.kt" }
            .toList()
        assertTrue("the sources are where the test looks", sources.size > 50)
        val raw = Regex("""\bMaterialTheme\s*\.\s*typography\b|\btypography\s*\.\s*(display|headline|title|body|label)(Large|Medium|Small)\b""")
        val found = sources.flatMap { file ->
            file.readLines().mapIndexedNotNull { index, line ->
                if (raw.containsMatchIn(line)) "${file.path}:${index + 1}: ${line.trim()}" else null
            }
        }
        assertEquals("Name a role from TextRoles (MaterialTheme.roles, A1561) instead", emptyList<String>(), found)
    }
}
