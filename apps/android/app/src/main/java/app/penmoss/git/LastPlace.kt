package app.penmoss.git

import android.content.Context
import android.os.Bundle

/**
 * Where the app was left (Ryan, 18 Nov 2026; A1624), so the next launch opens there, even after a
 * force close: the notebook, and in it a note, a folder or its notes list. Any Settings page, Add
 * Notebook among them, is kept as Settings itself; any other screen (Search, Tags, Trash…) as the
 * notebook's notes list. Kept on this phone only, never synced.
 */
data class LastPlace(val localId: String, val kind: Kind, val id: String? = null) {
    enum class Kind { NOTES, FOLDER, NOTE, SETTINGS }

    companion object {
        private const val FILE = "penmoss-last-place"
        private const val NOTEBOOK = "notebook"
        private const val KIND = "kind"
        private const val ID = "id"

        /** What the screen in front, by its route and arguments, leaves to come back to. */
        fun of(localId: String, route: String?, arguments: Bundle?): LastPlace = when {
            route == null -> LastPlace(localId, Kind.NOTES)
            route == app.penmoss.ui.NOTE_ROUTE -> arguments?.getString("id")?.let { LastPlace(localId, Kind.NOTE, it) } ?: LastPlace(localId, Kind.NOTES)
            route == FOLDER_ROUTE -> arguments?.getString("id")?.let { LastPlace(localId, Kind.FOLDER, it) } ?: LastPlace(localId, Kind.NOTES)
            route == app.penmoss.ui.settings.SettingsRoutes.HOME || route.startsWith("${app.penmoss.ui.settings.SettingsRoutes.HOME}/") ||
                route.startsWith("${app.penmoss.ui.settings.SettingsRoutes.HOME}?") -> LastPlace(localId, Kind.SETTINGS)
            else -> LastPlace(localId, Kind.NOTES)
        }

        /** The place last left, or null before there is one. */
        fun read(context: Context): LastPlace? {
            val prefs = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)
            val notebook = prefs.getString(NOTEBOOK, null) ?: return null
            val kind = prefs.getString(KIND, null)?.let { name -> Kind.entries.firstOrNull { it.name == name } } ?: Kind.NOTES
            return LastPlace(notebook, kind, prefs.getString(ID, null))
        }

        /** Keeps [place]; a force close right after still finds it (written at once, not batched). */
        fun write(context: Context, place: LastPlace) {
            if (read(context) == place) return
            context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit()
                .putString(NOTEBOOK, place.localId)
                .putString(KIND, place.kind.name)
                .putString(ID, place.id)
                .commit()
        }

        /** A folder's screen's route ([app.penmoss.ui.folders.folderRoutes]). */
        const val FOLDER_ROUTE = "folder/{id}"
    }
}
