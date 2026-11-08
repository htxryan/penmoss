package app.penmoss.engine.api

import kotlinx.serialization.Serializable

/** Who made a version: a device or an agent, with the name the phone shows (`GET /api/notes/:id/versions`, T21). */
@Serializable
data class HistoryAuthor(
    val id: String,
    val kind: String = "device",
    val label: String = "",
)

/** One version as the history list shows it (T21): newest first. */
@Serializable
data class NoteVersion(
    val id: Long,
    val createdAt: Long = 0,
    val reason: String = "",
    val summary: String = "",
    val authors: List<HistoryAuthor> = emptyList(),
)

/** The version list with changes since the newest version not in any version yet (T21). */
@Serializable
data class NoteHistory(
    val versions: List<NoteVersion> = emptyList(),
    val unversioned: UnversionedChanges? = null,
)

@Serializable
data class UnversionedChanges(
    val authors: List<HistoryAuthor> = emptyList(),
    val since: Long = 0,
)

/** One line of a version's diff against the version before it (`same`, `add` or `del`). */
@Serializable
data class DiffOp(
    val op: String,
    val line: String = "",
)

/** One version's markdown and its line diff against the version before it. */
@Serializable
data class VersionDetail(
    val id: Long,
    val previousId: Long? = null,
    val markdown: String = "",
    val diff: List<DiffOp> = emptyList(),
)

/** One region a revert could not undo: the text now, and the text before the reverted edit. */
@Serializable
data class RevertConflict(
    val part: String = "body",
    val ours: List<String> = emptyList(),
    val theirs: List<String> = emptyList(),
)

/** What restoring a version answers: the new version, and whether the note changed. */
@Serializable
data class RestoredVersion(
    val changed: Boolean = false,
)

/** What reverting a version answers: whether the note changed, and what overlapped. */
@Serializable
data class RevertedVersion(
    val changed: Boolean = false,
    val conflicts: List<RevertConflict> = emptyList(),
)
