package app.penmoss.feedback

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.io.InputStream

/**
 * The Send feedback form's state (T49): the draft, kept on the phone as it changes (A796), and
 * where sending stands. Kept across rotation; the draft on disk survives the app being closed.
 */
class FeedbackFormModel(
    private val service: FeedbackService,
    /** The app's scope: a send carries on when the form is left. */
    private val appScope: CoroutineScope,
) : ViewModel() {
    sealed interface Phase {
        data object Editing : Phase

        data object Sending : Phase

        /** Sent: the form closes, and the app's snackbar says "Sent as #n". */
        data object Sent : Phase

        /** Kept to send later: "Queued, will send when you're online". */
        data class Queued(val message: String) : Phase

        /** Refused for good: kept in Settings → About with Retry and Discard. */
        data class Failed(val message: String) : Phase
    }

    private val _draft = MutableStateFlow(service.drafts.load())
    val draft: StateFlow<FeedbackDraft> = _draft.asStateFlow()

    private val _phase = MutableStateFlow<Phase>(Phase.Editing)
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    /** The problems show once Send was pressed with something missing. */
    private val _showProblems = MutableStateFlow(false)
    val showProblems: StateFlow<Boolean> = _showProblems.asStateFlow()

    /** A message about the last thing tried (an image refused); read out. */
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    /** The draft's copy of this opening's window capture, while it is ticked. */
    private val _captureFile = MutableStateFlow<String?>(null)
    val captureFile: StateFlow<String?> = _captureFile.asStateFlow()

    /** The draft is sent or discarded: it is never written again. */
    @Volatile
    private var finished = false

    init {
        @OptIn(FlowPreview::class)
        viewModelScope.launch { _draft.drop(1).debounce(SAVE_DELAY_MS).collect { save(it) } }
    }

    private suspend fun save(draft: FeedbackDraft) = withContext(Dispatchers.IO) { if (!finished) service.drafts.save(draft) }

    fun update(change: (FeedbackDraft) -> FeedbackDraft) {
        if (_phase.value != Phase.Editing) return
        _draft.update(change)
    }

    fun setType(type: FeedbackType) = update { it.copy(type = type.wire) }

    fun setPriority(priority: Int) = update { it.copy(priority = priority) }

    /** One line, at most a little over the limit so the counter can say how far over. */
    fun setTitle(title: String) = update { it.copy(title = title.replace('\n', ' ').take(FeedbackLimits.TITLE_MAX + 64)) }

    fun setDescription(description: String) = update { it.copy(description = description) }

    fun setOmitted(group: String, omitted: Boolean) = update { draft ->
        draft.copy(omitted = if (omitted) (draft.omitted + group).distinct() else draft.omitted - group)
    }

    fun clearNotice() {
        _notice.value = null
    }

    /** Adds a picked image: refused with a message when it is not an image GitHub takes, over 10 MB, or one too many. */
    suspend fun addImage(mime: String?, size: Long?, open: () -> InputStream?) {
        val count = _draft.value.screenshots.size
        FeedbackImages.refusal(mime, size ?: 1, count)?.let {
            _notice.value = it
            return
        }
        val added = withContext(Dispatchers.IO) {
            try {
                open()?.let { service.drafts.addImage(it, mime!!) }
            } catch (error: IOException) {
                null
            } catch (error: SecurityException) {
                null
            }
        }
        if (added == null) {
            _notice.value = if (size != null && size > FeedbackLimits.SCREENSHOT_BYTES) "That image is over 10 MB" else "That image could not be read, or is over 10 MB"
            return
        }
        update { it.copy(screenshots = (it.screenshots + added).take(FeedbackLimits.SCREENSHOTS)) }
    }

    /** Ticks or unticks the screen behind as the first screenshot (A801). */
    suspend fun setCapture(capture: File?, ticked: Boolean) {
        if (!ticked) {
            val name = _captureFile.value ?: return
            _captureFile.value = null
            update { it.copy(screenshots = it.screenshots.filterNot { image -> image.file == name }) }
            return
        }
        if (capture == null || _captureFile.value != null) return
        if (_draft.value.screenshots.size >= FeedbackLimits.SCREENSHOTS) {
            _notice.value = "At most ${FeedbackLimits.SCREENSHOTS} screenshots"
            return
        }
        val image = withContext(Dispatchers.IO) { service.drafts.adoptCapture(capture) } ?: return
        _captureFile.value = image.file
        update { it.copy(screenshots = listOf(image) + it.screenshots) }
    }

    fun remove(index: Int) {
        val name = _draft.value.screenshots.getOrNull(index)?.file ?: return
        if (name == _captureFile.value) _captureFile.value = null
        update { it.copy(screenshots = it.screenshots.filterIndexed { i, _ -> i != index }) }
    }

    /** Moves a screenshot [by] places (−1 up, +1 down). */
    fun move(index: Int, by: Int) = update { draft ->
        val target = index + by
        if (index !in draft.screenshots.indices || target !in draft.screenshots.indices) return@update draft
        val list = draft.screenshots.toMutableList()
        list.add(target, list.removeAt(index))
        draft.copy(screenshots = list)
    }

    fun image(name: String): File = service.drafts.image(name)

    /**
     * Sends the form, with [context] as previewed (its groups left out as ticked). Nothing goes
     * while a required field is missing: the problems show and are read out instead.
     */
    fun send(context: FeedbackContextData) {
        if (_phase.value != Phase.Editing) return
        val draft = _draft.value
        if (FeedbackValidation.problems(draft).isNotEmpty()) {
            _showProblems.value = true
            return
        }
        _phase.value = Phase.Sending
        finished = true
        appScope.launch {
            val outcome = try {
                service.send(draft, context)
            } catch (error: IOException) {
                finished = false
                _notice.value = "A screenshot could not be read. Remove it and send again."
                _phase.value = Phase.Editing
                return@launch
            }
            _phase.value = when (outcome) {
                is FeedbackOutbox.Outcome.Sent, FeedbackOutbox.Outcome.Gone -> Phase.Sent
                is FeedbackOutbox.Outcome.Queued -> Phase.Queued(queuedMessage(outcome.why))
                is FeedbackOutbox.Outcome.Failed -> Phase.Failed(failedMessage(outcome.status, outcome.message))
            }
        }
    }

    /** Deletes the draft and its screenshots: the person chose to. */
    fun discard() {
        finished = true
        service.drafts.discard()
    }

    override fun onCleared() {
        // The last change, written before the form goes.
        if (!finished) service.drafts.save(_draft.value)
    }

    companion object {
        const val SAVE_DELAY_MS = 300L

        fun queuedMessage(why: String): String = when (why) {
            FeedbackOutbox.OFFLINE -> "Queued, will send when you’re online."
            // A1012: it waits for the person's GitHub token, and says where to add it.
            FeedbackOutbox.NO_TOKEN -> "Queued. ${GitHubTokenMessages.MISSING}"
            else -> "Queued, will send when you’re online. Penmoss said: ${why.trimEnd('.')}."
        }

        fun failedMessage(status: Int?, message: String): String =
            // The web's words (T39 pass 3, A892).
            "Not sent: ${message.trimEnd('.')}${status?.let { " ($it)" }.orEmpty()}. It’s kept in Settings → About, where you can edit, retry or discard it."
    }
}
