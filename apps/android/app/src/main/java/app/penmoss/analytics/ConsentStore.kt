package app.penmoss.analytics

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import java.io.File

/**
 * The person's answer (PEN-137, O3), as core's `ConsentFile` is the Mac's: the answer (null until
 * given), the anonymous install ID, when it was answered and by which version, since when sharing
 * has been on, and the limits that differ from their defaults. A DataStore file of its own under
 * `filesDir/datastore/`, which Auto Backup and device transfer leave out (every file of the app is
 * left out, `data_extraction_rules.xml`). Never in the synced settings or a notebook.
 */
data class ConsentState(
    val consent: ConsentAnswer? = null,
    val install: String = "",
    val answeredAt: Long? = null,
    val askedVersion: String? = null,
    val sharingSince: Long? = null,
    val limits: Limits = Limits.DEFAULTS,
) {
    val answered: Boolean get() = consent != null
    val sharing: Boolean get() = consent == ConsentAnswer.YES

    /** The state an event recorded now takes. */
    val stateNow: EventState
        get() = when (consent) {
            null -> EventState.PENDING
            ConsentAnswer.YES -> EventState.WAITING
            ConsentAnswer.NO -> EventState.LOCAL
        }
}

class ConsentStore(private val store: DataStore<Preferences>) {
    val state: Flow<ConsentState> = store.data.map(::read)

    suspend fun now(): ConsentState = ensureInstall(state.first())

    /** A state with an install ID: one is made, and kept, the first time. */
    private suspend fun ensureInstall(state: ConsentState): ConsentState {
        if (AnalyticsFormat.INSTALL.matches(state.install)) return state
        val id = AnalyticsFormat.newInstallId()
        store.edit { if (!AnalyticsFormat.INSTALL.matches(it[INSTALL].orEmpty())) it[INSTALL] = id }
        return read(store.data.first())
    }

    /** The person answered (core's `answer`). */
    suspend fun answer(answer: ConsentAnswer, now: Long, version: String): ConsentState {
        store.edit { prefs ->
            prefs[CONSENT] = answer.wire
            prefs[ANSWERED_AT] = now
            prefs[ASKED_VERSION] = version.take(40)
            if (answer == ConsentAnswer.YES) {
                if (prefs[SHARING_SINCE] == null) prefs[SHARING_SINCE] = now
            } else {
                prefs.remove(SHARING_SINCE)
            }
        }
        return now()
    }

    /** A new install ID (Reset My Analytics ID, or after Delete My Shared Data). */
    suspend fun resetId(): ConsentState {
        val id = AnalyticsFormat.newInstallId()
        store.edit { it[INSTALL] = id }
        return now()
    }

    /** Saves the limits: only the values that differ from their defaults are kept. */
    suspend fun setLimits(limits: Limits) {
        store.edit { prefs ->
            for (key in Limits.KEYS) {
                val value = limits.changed[key]
                if (value == null) prefs.remove(limitKey(key)) else prefs[limitKey(key)] = value
            }
        }
    }

    private fun read(prefs: Preferences): ConsentState {
        val consent = ConsentAnswer.of(prefs[CONSENT])
        return ConsentState(
            consent = consent,
            install = prefs[INSTALL]?.takeIf(AnalyticsFormat.INSTALL::matches).orEmpty(),
            answeredAt = prefs[ANSWERED_AT],
            askedVersion = prefs[ASKED_VERSION],
            sharingSince = if (consent == ConsentAnswer.YES) prefs[SHARING_SINCE] else null,
            limits = Limits.of(Limits.KEYS.associateWith { prefs[limitKey(it)] }),
        )
    }

    companion object {
        /** The file's name under `filesDir/datastore/`. */
        const val FILE = "analytics-consent.preferences_pb"

        private val CONSENT = stringPreferencesKey("consent")
        private val INSTALL = stringPreferencesKey("install")
        private val ANSWERED_AT = longPreferencesKey("answeredAt")
        private val ASKED_VERSION = stringPreferencesKey("askedVersion")
        private val SHARING_SINCE = longPreferencesKey("sharingSince")

        private fun limitKey(key: String) = intPreferencesKey("limits.$key")

        /** The store in [dir] (the app's `filesDir/datastore`, or a test's folder). */
        fun create(dir: File, scope: CoroutineScope): ConsentStore =
            ConsentStore(PreferenceDataStoreFactory.create(scope = scope) { File(dir, FILE) })
    }
}
