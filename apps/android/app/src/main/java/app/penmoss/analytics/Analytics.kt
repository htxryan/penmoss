package app.penmoss.analytics

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.concurrent.atomic.AtomicLong

/** What the phone fills in for every event it records. */
data class ClientFields(
    val version: String,
    val channel: String,
    val osVersion: String,
    val sizeClass: String?,
    val client: String = "android",
    val actor: String = "person",
    val os: String = "android",
)

/**
 * Usage analytics on the phone (PEN-137): records every event on the phone whatever the answer,
 * and sends only with it. Events are stamped with the session, a rising `seq` and the time, checked
 * against the catalogue (an invalid one is dropped, never stored), and inserted on
 * [Dispatchers.IO] every second or every 100 events. Each takes its state when it is stored, from
 * the answer in force: pending (no answer), local (No), waiting (Yes). Recording never throws and
 * never waits.
 */
class AnalyticsService(
    val store: AnalyticsStore,
    val consent: ConsentStore,
    private val sender: AnalyticsSender,
    private val scope: CoroutineScope,
    private val fields: () -> ClientFields,
    private val catalogue: AnalyticsCatalogue = AnalyticsCatalogue.bundled,
    private val now: () -> Long = System::currentTimeMillis,
    /** Asks for a send in [delayMs] (WorkManager in the app; tests run [sendDue] themselves). */
    private val schedule: (delayMs: Long) -> Unit = {},
    /** Drops any send asked for (sharing turned off). */
    private val unschedule: () -> Unit = {},
    /** Called after limits change: the log writer follows them. */
    private val onLimits: (Limits) -> Unit = {},
    /** Told of each event dropped (tests make it fail). */
    private val onDropped: (problem: String, kind: String, name: String) -> Unit = { _, _, _ -> },
) {
    val session: String = AnalyticsFormat.newSessionId()
    private val seq = AtomicLong(0)
    private val buffer = ArrayList<AnalyticsEvent>()
    private val flushing = Mutex()
    private val sending = Mutex()
    private var flushJob: Job? = null

    @Volatile
    private var sendJob: Job? = null

    private val _state = MutableStateFlow<ConsentState?>(null)

    /** The answer, the ID and the limits; null until read. */
    val state: StateFlow<ConsentState?> = _state.asStateFlow()

    init {
        scope.launch {
            _state.value = consent.now()
            consent.state.collect { read -> if (AnalyticsFormat.INSTALL.matches(read.install)) _state.value = read }
        }
    }

    /** The answer once it is read. */
    suspend fun stateNow(): ConsentState = state.filterNotNull().first()

    /** Records one event; false when it was dropped. */
    fun record(kind: String, name: String, props: Map<String, Any?> = emptyMap()): Boolean = try {
        val client = fields()
        val json = JsonObject(props.mapNotNull { (key, value) -> jsonOf(value)?.let { key to it } }.toMap())
        val draft = AnalyticsEvent(
            session = session,
            seq = 0,
            at = now(),
            client = client.client,
            actor = client.actor,
            version = client.version,
            channel = client.channel,
            os = client.os,
            osVersion = client.osVersion,
            sizeClass = client.sizeClass,
            kind = kind,
            name = name,
            props = json,
        )
        val problem = catalogue.problem(draft)
        if (problem != null) {
            onDropped(problem, kind, name)
            false
        } else {
            val size = synchronized(buffer) {
                // seq rises in the order events are kept.
                buffer += draft.copy(seq = seq.getAndIncrement())
                buffer.size
            }
            if (size >= FLUSH_AT) flushSoon(0) else flushSoon(FLUSH_MS)
            true
        }
    } catch (error: Exception) {
        false
    }

    private fun flushSoon(delayMs: Long) {
        synchronized(buffer) {
            if (delayMs > 0 && flushJob?.isActive == true) return
            flushJob = scope.launch(Dispatchers.IO) {
                if (delayMs > 0) delay(delayMs)
                flush()
            }
        }
    }

    /** Stores what is waiting in memory, each in the state the answer gives it now. */
    suspend fun flush() {
        flushing.withLock {
            val taken = synchronized(buffer) { buffer.toList().also { buffer.clear() } }
            if (taken.isEmpty()) return
            val state = stateNow().stateNow
            store.insert(taken.map { it to state })
            if (state == EventState.WAITING && (store.counts()[EventState.WAITING] ?: 0) >= AnalyticsFormat.SEND_AT_WAITING) schedule(0)
        }
    }

    /**
     * The person answered, the first time or from Settings: pending events go with the first
     * Yes, or stay as Not Shared; Yes from now on sends what is recorded from then, and No turns
     * waiting events local at once. A local event never changes.
     */
    suspend fun answer(answer: ConsentAnswer, version: String) {
        flush()
        consent.answer(answer, now(), version)
        _state.value = consent.now()
        if (answer == ConsentAnswer.NO) {
            // A batch in flight is abandoned: nothing more leaves the phone.
            unschedule()
            sendJob?.cancel()
        }
        store.applyAnswer(answer)
        if (answer == ConsentAnswer.NO) store.sharingOff()
        if (answer == ConsentAnswer.YES) schedule(0)
    }

    /** Reset My Analytics ID: a new ID, and unsent events stay on the phone. */
    suspend fun resetId() {
        flush()
        consent.resetId()
        _state.value = consent.now()
        store.unsentToLocal()
    }

    /** Delete My Shared Data: the server forgets the ID, then the phone takes a new one. */
    suspend fun forget(): ForgetOutcome {
        val install = stateNow().install
        val outcome = sender.forget(install)
        if (outcome == ForgetOutcome.OK) resetId()
        return outcome
    }

    /** New limits: saved, then what falls outside them (events and logs) pruned at once. */
    suspend fun setLimits(limits: Limits) {
        consent.setLimits(limits)
        _state.value = consent.now()
        onLimits(limits)
        store.prune(limits, now())
    }

    /** The limits in force, told to [onLimits] once they are read (the log writer follows them). */
    suspend fun followLimits() {
        onLimits(stateNow().limits)
    }

    /** Prunes to the limits in force (hourly, and at start). */
    suspend fun prune() {
        store.prune(stateNow().limits, now())
    }

    /**
     * Sends what waits, a batch at a time, while the person shares; false when it should be tried
     * again later (offline, a 5xx, a 429). Only ever called off the main thread (the worker).
     */
    suspend fun sendDue(): Boolean = sending.withLock {
        sendJob = kotlinx.coroutines.currentCoroutineContext()[Job]
        flush()
        repeat(MAX_BATCHES_PER_RUN) {
            val state = stateNow()
            // No sends nothing, ever; nor does no answer.
            if (!state.sharing || !AnalyticsFormat.INSTALL.matches(state.install)) return@withLock true
            when (val outcome = sender.sendNext(store, state.install)) {
                SendOutcome.Empty -> {
                    store.setMeta(AnalyticsStore.FAILURES, "0")
                    return@withLock true
                }
                is SendOutcome.Sent, is SendOutcome.Refused -> store.setMeta(AnalyticsStore.FAILURES, "0")
                is SendOutcome.Retry -> {
                    val failures = (store.meta(AnalyticsStore.FAILURES)?.toIntOrNull() ?: 0) + 1
                    store.setMeta(AnalyticsStore.FAILURES, failures.toString())
                    val wait = SendBackoff.delay(outcome, failures)
                    store.setMeta(AnalyticsStore.NEXT_TRY, (now() + wait).toString())
                    schedule(wait)
                    return@withLock false
                }
            }
        }
        true
    }

    /** While the app is in front: a send about every minute when events wait, and pruning hourly. */
    fun whileInFront(): Job = scope.launch(Dispatchers.IO) {
        var sincePrune = 0L
        while (isActive) {
            delay(AnalyticsFormat.SEND_EVERY_MS)
            flush()
            val state = stateNow()
            val nextTry = store.meta(AnalyticsStore.NEXT_TRY)?.toLongOrNull() ?: 0L
            if (state.sharing && (store.counts()[EventState.WAITING] ?: 0) > 0 && now() >= nextTry) schedule(0)
            sincePrune += AnalyticsFormat.SEND_EVERY_MS
            if (sincePrune >= PRUNE_EVERY_MS) {
                sincePrune = 0
                prune()
            }
        }
    }

    /** The app left the screen: what waits is stored and sent. */
    fun leftScreen() {
        scope.launch(Dispatchers.IO) {
            flush()
            if (stateNow().sharing) schedule(0)
        }
    }

    companion object {
        const val FLUSH_MS = 1_000L
        const val FLUSH_AT = 100
        const val PRUNE_EVERY_MS = 60 * 60_000L
        private const val MAX_BATCHES_PER_RUN = 50

        /** A prop's value as JSON: an enum, a boolean, a bucket, a number or a list of names. */
        fun jsonOf(value: Any?): JsonElement? = when (value) {
            null -> null
            is String -> JsonPrimitive(value)
            is Boolean -> JsonPrimitive(value)
            is Int -> JsonPrimitive(value)
            is Long -> JsonPrimitive(value)
            is List<*> -> JsonArray(value.mapNotNull { (it as? String)?.let(::JsonPrimitive) })
            else -> null
        }
    }
}

/**
 * The app's one recorder (PEN-137), for code with no graph at hand: AppKeys' commands, the
 * NavController's screens, [tracked] controls. A no-op until [install]ed (and in tests that
 * install none).
 */
object Analytics {
    @Volatile
    var service: AnalyticsService? = null
        private set

    fun install(service: AnalyticsService?) {
        // A new recorder starts with no screen before it, so its first screen is recorded.
        if (service !== this.service) lastScreen = null
        this.service = service
    }

    /** Records one event (kind, catalogue name, typed props); false when dropped or not installed. */
    fun record(kind: String, name: String, props: Map<String, Any?> = emptyMap()): Boolean =
        service?.record(kind, name, props) ?: false

    /** A tracked control was used (`Modifier.tracked`): its id, and on/off for a switch. */
    fun click(id: String, on: Boolean? = null): Boolean =
        record("click", id, if (on == null) emptyMap() else mapOf("state" to if (on) "on" else "off"))

    /** A setting changed: its value when it is an enum, a boolean, a bucket or a limit's number. */
    fun setting(name: String, value: Any): Boolean = record("setting", name, mapOf("value" to value))

    @Volatile
    private var lastScreen: String? = null

    /** A screen was shown: its kind ([ScreenKinds]), and the kind it came from. */
    fun screen(kind: String?) {
        kind ?: return
        val from = lastScreen
        if (from == kind) return
        lastScreen = kind
        record("screen", kind, if (from == null) emptyMap() else mapOf("from" to from))
    }

    /** A command ran (or was asked for and could not): how, with which keys, and whether they are the person's own. */
    fun command(id: String, source: String, ran: Boolean, keys: String? = null, custom: Boolean? = null) {
        val props = buildMap<String, Any?> {
            put("source", source)
            put("ran", ran)
            if (keys != null && AnalyticsCatalogue.KEYS.matches(keys)) put("keys", keys)
            if (custom != null) put("custom", custom)
        }
        record("command", id, props)
    }
}

/**
 * What kind of screen a route is (PEN-137): a kind from the catalogue, never a route or an id.
 * Null for a route that has no kind (it is not recorded).
 */
object ScreenKinds {
    private val SETTINGS = mapOf(
        "settings" to "settings",
        "settings/appearance" to "settings.appearance",
        "settings/appearance/theme/{id}" to "settings.appearance",
        "settings/display" to "settings.home",
        "settings/note" to "settings.note",
        "settings/symbols" to "settings.symbols",
        "settings/daily" to "settings.journal",
        "settings/daily/zone" to "settings.journal",
        "settings/capture" to "settings.quick-capture",
        "settings/shortcuts" to "settings.shortcuts",
        "settings/git" to "settings.git-notebooks",
        "settings/git/{id}?tab={tab}" to "settings.git-notebook",
        "settings/agent-activity" to "settings.agent-activity",
        "settings/storage" to "settings.storage",
        "settings/github" to "settings.github",
        "settings/github/token" to "settings.github",
        "settings/about" to "settings.github",
        "settings/whatsnew" to "settings.whats-new",
        "settings/privacy" to "settings.privacy",
        "settings/privacy/data" to "settings.privacy-data",
        "notebooks" to "home",
        "feedback" to "feedback",
    )

    fun of(route: String?, catalogue: AnalyticsCatalogue = AnalyticsCatalogue.bundled): String? {
        route ?: return null
        SETTINGS[route]?.let { return it }
        if (route.startsWith("settings/add-notebook")) return null
        // A notebook's own screens: the route's first word ("note/{id}" → note), when it is a kind.
        val first = route.substringBefore('/').substringBefore('?').substringBefore('{')
        val kind = when (first) {
            "history" -> "history"
            "folder" -> "home"
            else -> first
        }
        return kind.takeIf { catalogue.has("screen", it) }
    }
}
