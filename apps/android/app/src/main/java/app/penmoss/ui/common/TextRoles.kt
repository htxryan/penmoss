package app.penmoss.ui.common

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.text.TextStyle

/**
 * The text roles (A1561): the web's type roles (apps/web/src/shell/type.css) on Material's
 * scale, in the interface font. A screen names the role its text plays, not a size, so a group's
 * title is never smaller than the rows under it and a note under a setting is the size of every
 * other setting's help. Material's own sizes stay (a phone reads larger than the Mac); the
 * order is the web's: page title > section head > group head ≥ row label > help ≥ meta ≥ badge,
 * and a list's heading, like the web's, smaller than its rows.
 * No screen writes `fontSize = N.sp` (`TextRolesTest`).
 */
class TextRoles(type: Typography) {
    /** A screen's large title. */
    val pageTitle: TextStyle = type.headlineSmall

    /** A section of a screen. */
    val sectionHead: TextStyle = type.titleLarge

    /** A group of rows, a card's title: at least a row's size, and heavier. */
    val groupHead: TextStyle = type.titleMedium

    /** A list's heading over its rows (Folders, Notes): small, in the accent. */
    val listHead: TextStyle = type.titleSmall

    /** A dialog's title. */
    val dialogTitle: TextStyle = type.headlineSmall

    /** A setting's or a list row's name (a ListItem's headline). */
    val rowLabel: TextStyle = type.bodyLarge

    /** Running text: a screen's or a dialog's paragraphs, an empty list's message. */
    val body: TextStyle = type.bodyMedium

    /** What a row, a group or a screen means (a ListItem's supporting text). */
    val help: TextStyle = type.bodyMedium

    /** About a thing: a time, a count, a path. */
    val meta: TextStyle = type.labelMedium

    /** A chip, a count, a key. */
    val badge: TextStyle = type.labelSmall
}

/** The text roles of the theme's typography. */
val MaterialTheme.roles: TextRoles
    @Composable
    @ReadOnlyComposable
    get() = TextRoles(typography)
