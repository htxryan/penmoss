package app.penmoss.git

import app.penmoss.AppGraph
import app.penmoss.engine.api.HttpPenmossApi

/**
 * Whose notes an [AppGraph] holds (T50 G7, A880; T59, A1040): none, for the app's own graph (the
 * device's settings, feedback and the git notebooks on the phone), or one git notebook's, its own
 * graph built beside the app's. A git notebook's graph has its own Room database, preferences and
 * files, so nothing crosses notebooks (A826); its API is the notebook's notes server on the phone
 * ([app.penmoss.engine.git.LocalGitApi]).
 */
sealed interface GraphSource {
    /** The app's own graph: no notes of its own since the Penmoss server went (T59). */
    data object Device : GraphSource

    class Git(
        val localId: String,
        val notebookId: String,
        val name: String,
        /** The app's graph: device settings (Appearance and the rest), feedback, recent errors. */
        val main: AppGraph,
        val api: HttpPenmossApi,
    ) : GraphSource
}
