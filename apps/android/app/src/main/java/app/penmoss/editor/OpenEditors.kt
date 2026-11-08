package app.penmoss.editor

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * The copies of notes that open editors may still send edits of (A309). An
 * editor holds the copy it has open, a copy it is reopening away from until
 * the page says `opened` (its last edits of the old copy come first), and the
 * copy of any edit it is still storing. Edits kept apart from a copy one holds
 * are not made into a conflict copy yet, and the base rows they build on stay,
 * so a restore's last seconds of typing land in the same copy as the rest.
 */
class OpenEditors {
    private val _held = MutableStateFlow<Map<Any, Held>>(emptyMap())

    /** Changes whenever an editor holds a different set of copies. */
    val held: StateFlow<Map<Any, Held>> = _held.asStateFlow()

    /** The copies (epochs, null for one with none known) one editor holds of its note. */
    data class Held(val noteId: String, val epochs: Set<String?>)

    fun set(owner: Any, noteId: String, epochs: Set<String?>) {
        _held.update { current ->
            if (epochs.isEmpty()) current - owner else current + (owner to Held(noteId, epochs))
        }
    }

    fun remove(owner: Any) = _held.update { it - owner }

    /** Whether an open editor may still send edits of this copy of the note. */
    fun holds(noteId: String, epoch: String?): Boolean =
        _held.value.values.any { it.noteId == noteId && epoch in it.epochs }
}
